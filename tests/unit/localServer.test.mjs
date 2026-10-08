import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { copyFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { startLocalServer } from '../../scripts/localServer.mjs'
import { portableLauncher } from '../../scripts/packageWindows.mjs'

async function setup(t) {
  const temporaryRoot = resolve('.vite/native-server-tests')
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(join(temporaryRoot, 'server-'))
  await mkdir(join(directory, 'app/assets'), { recursive: true })
  await mkdir(join(directory, 'app/data'), { recursive: true })
  await writeFile(join(directory, 'app/index.html'), '<h1>练习</h1>')
  await writeFile(join(directory, 'app/assets/app.js'), 'export const answer = 42')
  await writeFile(join(directory, 'app/data/template.csv'), 'timestamp,close\n')
  await writeFile(join(directory, 'secret.txt'), 'private account')
  const local = await startLocalServer(join(directory, 'app'), { port: 0 })
  t.after(async () => {
    await local.close()
    assert.equal(dirname(directory), temporaryRoot)
    await rm(directory, { recursive: true, force: true })
  })
  return { ...local, port: local.server.address().port }
}

function get(port, path, options = {}) {
  return new Promise((resolveResponse, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, ...options }, response => {
      const bytes = []
      response.on('data', chunk => bytes.push(chunk))
      response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers, text: Buffer.concat(bytes).toString('utf8') }))
      response.on('error', reject)
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

test('原生本机服务器以正确类型响应 GET/HEAD，不缓存升级前入口', async t => {
  const { port } = await setup(t)
  const index = await get(port, '/')
  assert.equal(index.status, 200)
  assert.equal(index.text, '<h1>练习</h1>')
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(index.headers['cache-control'], 'no-store')
  assert.equal(index.headers['x-content-type-options'], 'nosniff')
  const script = await get(port, '/assets/app.js?version=2')
  assert.equal(script.status, 200)
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8')
  const head = await get(port, '/', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.text, '')
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(index.text))
  assert.equal((await get(port, '/data/template.csv')).headers['content-type'], 'text/csv; charset=utf-8')
})

test('遍历、编码异常、目录和未知页面不泄露文件，不使用 SPA 回退', async t => {
  const { port } = await setup(t)
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/%5c..%5csecret.txt', '/%00.txt', '/bad%encoding']) {
    const result = await get(port, path)
    assert.equal(result.status, 400, path)
    assert.ok(!result.text.includes('private account'))
  }
  for (const path of ['/assets/', '/unknown-page', '/secret.txt', '/imports/private.csv']) assert.equal((await get(port, path)).status, 404, path)
  assert.equal((await get(port, '/', { headers: { host: `evil.example:${port}` } })).status, 403)
  const post = await get(port, '/', { method: 'POST' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET, HEAD')
})

test('端口占用明确失败，关闭后释放同一端口', async t => {
  const local = await setup(t)
  await assert.rejects(startLocalServer(resolve('.vite/native-server-tests'), { port: local.port }), error => error.code === 'EADDRINUSE')
  await local.close()
  const reopened = await startLocalServer(resolve('.vite/native-server-tests'), { port: local.port })
  await reopened.close()
})

test('便携启动.cmd在中文与空格路径使用包内Node，端口占用后明确失败', { skip: process.platform !== 'win32' }, async t => {
  const temporaryRoot = resolve('.vite/native-server-tests')
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(join(temporaryRoot, '便携启动 中文与空格-'))
  for (const folder of ['runtime', 'scripts', 'app']) await mkdir(join(directory, folder))
  await copyFile(process.execPath, join(directory, 'runtime/node.exe'))
  for (const script of ['startLocal.mjs', 'localServer.mjs']) await copyFile(resolve('scripts', script), join(directory, 'scripts', script))
  await writeFile(join(directory, 'app/index.html'), '<h1>发行启动测试</h1>')
  await writeFile(join(directory, '启动.cmd'), portableLauncher())
  let occupyingServer
  try { occupyingServer = await startLocalServer(join(directory, 'app')) }
  catch (error) { if (error.code !== 'EADDRINUSE') throw error }
  t.after(async () => {
    await occupyingServer?.close()
    assert.equal(dirname(directory), temporaryRoot)
    await rm(directory, { recursive: true, force: true })
  })
  const result = await new Promise((resolveResult, reject) => {
    const command = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe'), ['/d', '/s', '/c', `""${join(directory, '启动.cmd')}" --no-open"`], {
      windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: join(directory, 'runtime') },
    })
    const chunks = []
    command.stdout.on('data', chunk => chunks.push(chunk))
    command.stderr.on('data', chunk => chunks.push(chunk))
    command.once('error', reject)
    command.once('exit', code => resolveResult({ code, output: Buffer.concat(chunks).toString('utf8') }))
    command.stdin.end('\r\n')
  })
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /127\.0\.0\.1:4173 已被占用/)
  assert.match(result.output, /不会更换端口/)
})
