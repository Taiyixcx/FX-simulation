import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { startLocalServer } from './localServer.mjs'

const projectDirectory = fileURLToPath(new URL('../', import.meta.url))

async function start() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!(major === 22 && minor >= 12 || major === 24 || major >= 26)) throw new Error('请使用 Node.js 24.x，或 package.json 中支持的版本。')
  let applicationDirectory = resolve(projectDirectory, 'app')
  try { await access(resolve(applicationDirectory, 'index.html')) }
  catch { applicationDirectory = resolve(projectDirectory, 'dist') }
  try { await access(resolve(applicationDirectory, 'index.html')) }
  catch { throw new Error('尚未生成运行文件。请在项目目录执行 npm run build。') }
  let server
  try {
    server = await startLocalServer(applicationDirectory)
  } catch (error) {
    if (/already in use|EADDRINUSE/i.test(String(error))) throw new Error('127.0.0.1:4173 已被占用，请先关闭已有服务；不会更换端口。')
    throw error
  }
  process.stdout.write('FX 练习室已启动：http://127.0.0.1:4173\n保持此窗口打开，按 Ctrl+C 结束服务。\n')
  let isClosing = false
  const close = async () => {
    if (isClosing) return
    isClosing = true
    await server.close()
    process.stdout.write('本机服务已结束，已保存的练习仍在浏览器中。\n')
  }
  process.once('SIGINT', () => { void close().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }) })
  process.once('SIGTERM', () => { void close().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }) })
  if (process.platform === 'win32' && !process.argv.includes('--no-open')) {
    const browser = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', 'http://127.0.0.1:4173'], { windowsHide: true, stdio: 'ignore' })
    browser.once('error', () => process.stdout.write('请手动在浏览器打开上方本机地址。\n'))
  }
}

start().catch(error => { process.stderr.write(`启动失败：${error.message}\n`); process.exitCode = 1 })
