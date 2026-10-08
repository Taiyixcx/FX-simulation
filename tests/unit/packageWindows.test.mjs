import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { collectPublicFiles, hashFile, listRegularFiles, verifyRelease } from '../../scripts/packageWindows.mjs'

async function fixture(t) {
  const temporaryRoot = resolve('.vite/release-unit-tests')
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(join(temporaryRoot, 'package-'))
  t.after(async () => {
    assert.equal(dirname(directory), temporaryRoot)
    await rm(directory, { recursive: true, force: true })
  })
  for (const folder of ['assets', 'data', 'licenses']) await mkdir(join(directory, folder))
  const names = ['decimal-LICENSE.txt', 'echarts-d3-LICENSE.txt', 'echarts-LICENSE.txt', 'echarts-NOTICE.txt', 'inter-LICENSE.txt', 'pinia-LICENSE.txt', 'tslib-LICENSE.txt', 'tslib-NOTICE.txt', 'vue-LICENSE.txt', 'zrender-LICENSE.txt']
  for (const name of names) await writeFile(join(directory, 'licenses', name), name)
  await writeFile(join(directory, 'index.html'), '<script src="/assets/index-12345678.js"></script><link href="/assets/index-12345678.css">')
  await writeFile(join(directory, 'assets/index-12345678.js'), 'console.log("public")')
  await writeFile(join(directory, 'assets/index-12345678.css'), 'body { color: green; }')
  await writeFile(join(directory, 'favicon.svg'), '<svg/>')
  await writeFile(join(directory, 'data/csv-template.csv'), 'timestamp,open,high,low,close\n')
  return directory
}

test('发行白名单排除已知私用价格、元信息及本机清单', async t => {
  const directory = await fixture(t)
  for (const file of ['eurusd-20240304-08.csv', 'eurusd-20240304-08.csv.metadata.json', 'gbpusd-20240304-08.csv', 'gbpusd-20240304-08.csv.metadata.json', 'manifest.json', 'simulation-calibration.json', 'README.md']) await writeFile(join(directory, 'data', file), 'private fixture')
  const files = await collectPublicFiles(directory)
  assert.deepEqual(files.filter(file => file.startsWith('data/')), ['data/csv-template.csv'])
  assert.ok(files.includes('assets/index-12345678.js'))
  assert.ok(files.includes('licenses/echarts-NOTICE.txt'))
})

test('未知数据或伪装资产使发行失败，原构建文件保留', async t => {
  const directory = await fixture(t)
  const unexpectedPath = join(directory, 'data/my-personal-history.csv')
  await writeFile(unexpectedPath, 'private custom source')
  await assert.rejects(collectPublicFiles(directory), /白名单外.*my-personal-history/)
  assert.equal(await readFile(unexpectedPath, 'utf8'), 'private custom source')
  await rm(unexpectedPath)
  await writeFile(join(directory, 'assets/private.json'), '{"account":"private"}')
  await assert.rejects(collectPublicFiles(directory), /白名单外.*private.json/)
})

test('缺许可、悬空入口及符号链接均拒绝打包', async t => {
  const directory = await fixture(t)
  await rm(join(directory, 'licenses/echarts-NOTICE.txt'))
  await assert.rejects(collectPublicFiles(directory), /缺少发行必需文件/)
  await writeFile(join(directory, 'licenses/echarts-NOTICE.txt'), 'notice')
  await writeFile(join(directory, 'index.html'), '<script src="/assets/index-missing.js"></script>')
  await assert.rejects(collectPublicFiles(directory), /入口引用未纳入/)
  await symlink(join(directory, 'licenses'), join(directory, 'linked-files'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(listRegularFiles(directory), /符号链接/)
})

test('发行清单拒绝增加未记录文件', async t => {
  const directory = await fixture(t)
  const release = join(directory, '发行包')
  await mkdir(release)
  await writeFile(join(release, 'release-manifest.json'), JSON.stringify({ formatVersion: 1, appName: 'FX 练习室', files: [] }))
  await writeFile(join(release, 'personal-backup.json'), '{}')
  await assert.rejects(verifyRelease(release), /文件范围与清单不一致/)
  assert.equal(await hashFile(join(release, 'personal-backup.json')), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
})
