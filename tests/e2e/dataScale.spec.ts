import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { waitSaved, readSnapshot } from './sessionDatabase'
import type { HistoricalSessionSnapshot } from '../../src/storage/historicalSessionSnapshot'

test.use({ launchOptions: { args: ['--enable-precise-memory-info'] } })

for (const frameCount of [7_000, 50_000, 200_000]) {
test(`${frameCount}根生成CSV分批导入可交互且冷恢复保持首根可见、账户一致`, async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const rows = Array.from({ length: frameCount }, (_, index) => `${new Date(Date.UTC(2024, 0, 1, 0, index + 1)).toISOString()},1.1,1.1,1.1,1.1,1.1001`)
  const csv = ['timestamp,open,high,low,close,ask', ...rows].join('\n')
  await page.goto('/')
  await waitSaved(page)
  await page.evaluate(() => {
    const readHeap = () => (Reflect.get(performance, 'memory') as { usedJSHeapSize: number } | undefined)?.usedJSHeapSize ?? null
    const probe = { maximumTickGapMs: 0, longTasks: [] as number[], lastTick: performance.now(), initialHeapBytes: readHeap(), maximumHeapBytes: readHeap() }
    Reflect.set(window, '__fxScaleProbe', probe)
    setInterval(() => {
      const now = performance.now(); probe.maximumTickGapMs = Math.max(probe.maximumTickGapMs, now - probe.lastTick); probe.lastTick = now
      const heap = readHeap()
      if (heap !== null) probe.maximumHeapBytes = Math.max(probe.maximumHeapBytes ?? 0, heap)
    }, 25)
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => probe.longTasks.push(...list.getEntries().map(entry => entry.duration))).observe({ type: 'longtask', buffered: false })
  })
  await page.getByLabel('历史数据管理', { exact: true }).locator('summary').click()
  await page.getByLabel('来源名称', { exact: true }).fill('生成性能测试数据，不是真实历史')
  await page.getByLabel('CSV 文件', { exact: true }).setInputFiles({ name: 'generated-200000.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await page.evaluate(() => {
    const probe = Reflect.get(window, '__fxScaleProbe') as { maximumTickGapMs: number; longTasks: number[]; lastTick: number }
    probe.maximumTickGapMs = 0; probe.longTasks = []; probe.lastTick = performance.now()
  })
  const started = Date.now()
  await page.getByRole('button', { name: '导入 CSV', exact: true }).click()
  await expect(page.locator('.import-progress')).toBeVisible()
  const interactionStarted = Date.now()
  await page.getByRole('button', { name: 'K 线', exact: true }).click()
  await expect(page.getByRole('button', { name: 'K 线', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const interactionMs = Date.now() - interactionStarted
  await expect(page.locator('.import-message')).toContainText(frameCount.toLocaleString('zh-CN'), { timeout: 120_000 })
  const importMs = Date.now() - started
  const responsiveness = await page.evaluate(() => {
    const probe = Reflect.get(window, '__fxScaleProbe') as { maximumTickGapMs: number; longTasks: number[]; initialHeapBytes: number | null; maximumHeapBytes: number | null }
    return { maximumTickGapMs: probe.maximumTickGapMs, maximumLongTaskMs: Math.max(0, ...probe.longTasks), longTaskCount: probe.longTasks.length, approximateInitialJsHeapBytes: probe.initialHeapBytes, approximatePeakJsHeapBytes: probe.maximumHeapBytes }
  })
  await page.getByRole('button', { name: '开始历史练习', exact: true }).click()
  await expect(page.getByTestId('history-source')).toBeVisible({ timeout: 60_000 })
  await waitSaved(page)
  await expect(page.getByRole('button', { name: '下一根', exact: true })).toBeEnabled({ timeout: 60_000 })
  const before = await readSnapshot<HistoricalSessionSnapshot>(page)
  expect(before.schemaVersion).toBe(4)
  expect(before.sourceState.maxFrames).toBe(frameCount)
  await expect(page.getByTestId('market-chart')).toHaveAttribute('data-frame-count', '1')
  const reloadStarted = Date.now()
  await page.reload()
  await expect(page.getByTestId('history-source')).toBeVisible({ timeout: 60_000 })
  await waitSaved(page)
  await expect(page.getByRole('button', { name: '下一根', exact: true })).toBeEnabled({ timeout: 60_000 })
  const reloadMs = Date.now() - reloadStarted
  expect(await readSnapshot(page)).toEqual(before)
  const report = { browser: testInfo.project.name, generatedFrameCount: rows.length, csvBytes: Buffer.byteLength(csv), interactionMs, importMs, reloadMs, responsiveness, scope: 'Isolated Chromium with synthetic CSV; no user database or real market calibration.' }
  await mkdir(resolve('.vite'), { recursive: true })
  await writeFile(resolve(`.vite/browser-performance-${frameCount}.json`), JSON.stringify(report, null, 2) + '\n')
  if (frameCount === 200_000) await writeFile(resolve('.vite/browser-performance.json'), JSON.stringify(report, null, 2) + '\n')
  await testInfo.attach('browser-performance', { body: JSON.stringify(report), contentType: 'application/json' })
  expect(interactionMs).toBeLessThan(2_000)
})
}

test('取消200000根CSV导入及时响应且不留下数据集或改变当前会话', async ({ page }, testInfo) => {
  const rows = Array.from({ length: 200_000 }, (_, index) => `${new Date(Date.UTC(2024, 0, 1, 0, index + 1)).toISOString()},1.1,1.1,1.1,1.1,1.1001`)
  await page.goto('/')
  await waitSaved(page)
  const original = await readSnapshot(page)
  await page.getByLabel('历史数据管理', { exact: true }).locator('summary').click()
  await page.getByLabel('来源名称', { exact: true }).fill('生成取消测试数据')
  await page.getByLabel('CSV 文件', { exact: true }).setInputFiles({ name: 'cancel.csv', mimeType: 'text/csv', buffer: Buffer.from(['timestamp,open,high,low,close,ask', ...rows].join('\n')) })
  await page.getByRole('button', { name: '导入 CSV', exact: true }).click()
  await expect(page.locator('.import-progress')).toBeVisible()
  const started = Date.now()
  await page.getByRole('button', { name: '取消导入', exact: true }).click()
  await expect(page.locator('.import-message')).toContainText('取消')
  const cancelMs = Date.now() - started
  expect(await readSnapshot(page)).toEqual(original)
  const datasetCount = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fx-simulation')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction('datasets', 'readonly')
        let count = -1
        const request = transaction.objectStore('datasets').count()
        request.onsuccess = () => { count = request.result }
        transaction.oncomplete = () => resolve(count)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally { database.close() }
  })
  expect(datasetCount).toBe(0)
  const report = { cancelMs, frameCount: rows.length, datasetCount, originalSessionPreserved: true }
  await writeFile(resolve('.vite/browser-cancellation.json'), JSON.stringify(report, null, 2) + '\n')
  await testInfo.attach('browser-cancellation', { body: JSON.stringify(report), contentType: 'application/json' })
  expect(cancelMs).toBeLessThan(2_000)
})
