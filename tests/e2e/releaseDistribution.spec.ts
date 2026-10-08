import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { advanceSimulation } from '../../src/engine/simulationSource'
import type { PracticeSnapshot } from '../../src/storage/historicalSessionSnapshot'
import { readSnapshot, waitSaved } from './sessionDatabase'

test.skip(!process.env.FX_E2E_RELEASE_ZIP && !process.env.FX_E2E_RELEASE_DIR, '发行验收需要 FX_E2E_RELEASE_ZIP 指向已生成的 Windows 发行 ZIP。')

async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('link', { name: '练习与备份', exact: true }).click()
  await expect(page.getByRole('button', { name: '导出完整备份', exact: true })).toBeVisible()
}

test('公开发行只提供完整运行资源和生成模板，不暴露私人CSV或不存在的历史入口', async ({ page, request }) => {
  const errors: string[] = []
  const requests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', resource => requests.push(resource.url()))
  await page.goto('/')
  await waitSaved(page)
  await page.getByLabel('历史数据管理', { exact: true }).locator('summary').click()
  await expect(page.getByRole('button', { name: '载入本机样本', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('本机样本', { exact: true })).toHaveCount(0)

  const manifest = await request.get('/data/manifest.json')
  expect(manifest.status()).toBe(200)
  expect(await manifest.json()).toEqual({ version: 1, samples: [] })
  for (const path of [
    '/imports/private-release-check.csv',
    '/runtime/node.exe',
    '/scripts/startLocal.mjs',
    '/package.json',
    '/.git/config',
    '/data/eurusd-20240304-08.csv',
    '/data/gbpusd-20240304-08.csv',
  ]) expect((await request.get(path)).status(), path).toBe(404)
  for (const name of [
    'decimal-LICENSE.txt', 'echarts-LICENSE.txt', 'echarts-NOTICE.txt',
    'echarts-d3-LICENSE.txt', 'inter-LICENSE.txt', 'pinia-LICENSE.txt',
    'tslib-LICENSE.txt', 'tslib-NOTICE.txt', 'vue-LICENSE.txt', 'zrender-LICENSE.txt',
  ]) {
    const license = await request.get(`/licenses/${name}`)
    expect(license.status(), name).toBe(200)
    expect((await license.body()).length, name).toBeGreaterThan(100)
  }
  const template = await request.get('/data/csv-template.csv')
  expect(template.status()).toBe(200)
  const csv = await template.body()
  await page.getByLabel(/^CSV\s*文件$/).setInputFiles({ name: '生成格式示例.csv', mimeType: 'text/csv', buffer: csv })
  await page.getByRole('button', { name: /^导入\s*CSV$/ }).click()
  await expect(page.getByRole('button', { name: '开始历史练习', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '开始历史练习', exact: true }).click()
  await waitSaved(page)
  await expect(page.getByTestId('history-source')).toContainText('真实性未核实')
  await expect(page.getByTestId('progress')).toContainText('已暂停')
  expect(requests.filter(url => new URL(url).origin !== 'http://127.0.0.1:4173')).toEqual([])
  expect(errors).toEqual([])
})

test('发行包离线持仓刷新后保持暂停，完整备份在新浏览器恢复并继续原下一根', async ({ browser }) => {
  const sourceContext = await browser.newContext({ proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost' } })
  const targetContext = await browser.newContext({ proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost' } })
  const source = await sourceContext.newPage()
  const target = await targetContext.newPage()
  const errors: string[] = []
  const requests: string[] = []
  for (const page of [source, target]) {
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', resource => requests.push(resource.url()))
  }
  try {
    await source.goto('/')
    await waitSaved(source)
    await source.locator('.trade-learning > summary').click()
    await source.getByLabel('下单前进场理由（可选）', { exact: true }).fill('发行包备份验证：保留原持仓与报价')
    await source.getByRole('button', { name: '买跌（做空）', exact: true }).click()
    await waitSaved(source)
    await source.getByRole('button', { name: '下一根', exact: true }).click()
    await waitSaved(source)
    const original = await readSnapshot<PracticeSnapshot>(source)
    expect(original.account.position?.direction).toBe('short')
    await source.reload()
    await waitSaved(source)
    expect(await readSnapshot(source)).toEqual(original)
    await expect(source.getByTestId('progress')).toContainText('已暂停')

    await openLibrary(source)
    const downloadEvent = source.waitForEvent('download')
    await source.getByRole('button', { name: '导出完整备份', exact: true }).click()
    const downloadPath = await (await downloadEvent).path()
    if (!downloadPath) throw new Error('未取得发行包完整备份文件。')
    const json = await readFile(downloadPath, 'utf8')
    await target.goto('/')
    await waitSaved(target)
    await openLibrary(target)
    await target.getByLabel('选择备份文件').setInputFiles({ name: '发行包备份.json', mimeType: 'application/json', buffer: Buffer.from(json) })
    await expect(target.getByLabel('恢复预览')).toContainText('1 个练习')
    await target.getByLabel('恢复后打开备份中的原练习（暂停）').check()
    await target.getByRole('button', { name: '确认追加恢复', exact: true }).click()
    await expect(target.locator('.library-notice')).toContainText('已恢复')
    await waitSaved(target)
    const restored = await readSnapshot<PracticeSnapshot>(target)
    expect(restored.id).not.toBe(original.id)
    expect(restored.account).toEqual(original.account)
    expect(restored.frames).toEqual(original.frames)
    expect(restored.sourceState).toEqual(original.sourceState)
    await expect(target.getByTestId('progress')).toContainText('已暂停')
    await target.getByText('查看与修订本笔计划', { exact: true }).click()
    await expect(target.locator('.annotation-editor')).toContainText('发行包备份验证：保留原持仓与报价')
    if (original.schemaVersion !== 3) throw new Error('发行验证预期为模拟持仓。')
    const next = advanceSimulation(original.sourceState)!
    await target.getByRole('button', { name: '下一根', exact: true }).click()
    await waitSaved(target)
    expect((await readSnapshot<PracticeSnapshot>(target)).frames.at(-1)).toEqual(next.frame)
    await target.getByRole('button', { name: '平仓', exact: true }).click()
    await waitSaved(target)
    const closed = await readSnapshot<PracticeSnapshot>(target)
    expect(closed.account.position).toBeNull()
    expect(closed.trades).toHaveLength(1)
    expect(requests.filter(url => new URL(url).origin !== 'http://127.0.0.1:4173')).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await sourceContext.close()
    await targetContext.close()
  }
})
