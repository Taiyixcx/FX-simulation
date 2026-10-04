import { expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseHistoryCsv } from '../../src/engine/historyCsv'
import { validateHistoryDatasetSummary } from '../../src/engine/historySource'
import { closePosition, prepareOpenPosition } from '../../src/engine/execution'
import { createHistoricalSnapshot } from '../../src/storage/historicalSessionSnapshot'
import { createSessionSummary } from '../../src/storage/sessionMetadata'
import { readSnapshot, waitSaved } from './sessionDatabase'

for (const tradeCount of [0, 500]) {
  test(`两个数据集及${tradeCount}笔闭单的列表、保存、冷恢复和完整备份恢复`, async ({ page, browser }, testInfo) => {
    test.setTimeout(180_000)
    const sources = await Promise.all(([['EUR/USD', 7_000, '1.1'], ['GBP/USD', 50_000, '1.27']] as const).map(async ([pair, count, price]) => {
      const rows = Array.from({ length: count }, (_, index) => `${new Date(Date.UTC(2024, 0, 1, 0, index + 1)).toISOString()},${price},${price},${price},${price},${Number(price) + .0001}`)
      return parseHistoryCsv(['timestamp,open,high,low,close,ask', ...rows].join('\n'), pair, { label: '生成资料库性能数据，不是真实历史' })
    }))
    const snapshot = createHistoricalSnapshot(sources[0]!, `library-scale-${tradeCount}`)
    const quote = snapshot.frames[0]!.quote
    for (let index = 0; index < tradeCount; index++) {
      snapshot.account = prepareOpenPosition(snapshot.account, quote, snapshot.pair, index % 2 ? 'short' : 'long', '1000', `scale-trade-${index}`)
      const closed = closePosition(snapshot.account, quote)
      snapshot.account = closed.account
      snapshot.trades.push(closed.trade)
    }
    snapshot.revision = 1
    await page.goto('/')
    await waitSaved(page)
    // Isolated browser fixtures use real engine-generated records and native IDB.
    // Timings start after construction; they do not include synthetic fixture work.
    await page.evaluate(async ({ datasets, head, summary, entries }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('fx-simulation')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(['datasets', 'datasetSummaries', 'sessions', 'sessionSummaries', 'settings'], 'readwrite')
          datasets.forEach(dataset => transaction.objectStore('datasets').add(dataset))
          entries.forEach(entry => transaction.objectStore('datasetSummaries').add(entry))
          transaction.objectStore('sessions').add(head)
          transaction.objectStore('sessionSummaries').add(summary)
          const settings = transaction.objectStore('settings')
          settings.put({ id: head.id, revision: head.revision }, 'current')
          const library = settings.get('library')
          library.onsuccess = () => {
            const state = library.result as { epoch: string; sequence: number; generation: number }
            settings.put({ ...state, sequence: state.sequence + 1, generation: state.generation + 1 }, 'library')
          }
          transaction.oncomplete = () => resolve()
          transaction.onabort = () => reject(transaction.error ?? new Error('隔离规模夹具写入失败'))
        })
      } finally { database.close() }
    }, {
      datasets: sources, head: snapshot, summary: createSessionSummary(snapshot, Date.now(), Date.now()),
      entries: sources.map(source => ({ id: source.id, summary: validateHistoryDatasetSummary(source), errorMessage: null })),
    })
    const reloadStarted = Date.now()
    await page.reload()
    await expect(page.getByTestId('history-source')).toBeVisible({ timeout: 60_000 })
    await waitSaved(page)
    await expect(page.getByRole('button', { name: '下一根', exact: true })).toBeEnabled()
    const reloadMs = Date.now() - reloadStarted
    expect(await readSnapshot(page)).toEqual(snapshot)
    const listStarted = Date.now()
    await page.getByRole('link', { name: '练习与备份', exact: true }).click()
    await expect(page.locator('.session-list > li')).toHaveCount(2)
    const listMs = Date.now() - listStarted
    const saveStarted = Date.now()
    await page.getByRole('button', { name: '下一根', exact: true }).click()
    await waitSaved(page)
    const saved = await readSnapshot(page)
    const saveMs = Date.now() - saveStarted
    expect(saved.trades).toHaveLength(tradeCount)
    const exportStarted = Date.now()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出完整备份', exact: true }).click()
    const pathname = await (await downloadPromise).path()
    if (!pathname) throw new Error('未取得规模备份文件')
    const json = await readFile(pathname, 'utf8')
    const exportMs = Date.now() - exportStarted
    const parsed = JSON.parse(json) as { sessions: unknown[]; datasets: unknown[] }
    expect(parsed.sessions).toHaveLength(2)
    expect(parsed.datasets).toHaveLength(2)
    const targetContext = await browser.newContext()
    let restoreMs = 0
    try {
      const target = await targetContext.newPage()
      await target.goto('/')
      await waitSaved(target)
      await target.getByRole('link', { name: '练习与备份', exact: true }).click()
      const restoreStarted = Date.now()
      await target.getByLabel('选择备份文件').setInputFiles({ name: 'scale-backup.json', mimeType: 'application/json', buffer: Buffer.from(json) })
      await expect(target.getByLabel('恢复预览')).toContainText(`${tradeCount} 笔成交`, { timeout: 90_000 })
      await target.getByLabel('恢复后打开备份中的原练习（暂停）').check()
      await target.getByRole('button', { name: '确认追加恢复', exact: true }).click()
      await expect(target.locator('.library-notice')).toContainText('已恢复', { timeout: 60_000 })
      await waitSaved(target)
      restoreMs = Date.now() - restoreStarted
      const restored = await readSnapshot(target)
      expect(restored.account).toEqual(saved.account)
      expect(restored.trades).toEqual(saved.trades)
      expect(restored.sourceState).toEqual(saved.sourceState)
      expect(restored.id).not.toBe(saved.id)
      await expect(target.getByTestId('progress')).toContainText('已暂停')
    } finally { await targetContext.close() }
    const report = {
      browser: testInfo.project.name, datasetFrameCounts: [7_000, 50_000], tradeCount,
      reloadMs, listMs, saveMs, exportMs, restoreMs, backupBytes: Buffer.byteLength(json),
      scope: 'Isolated Chromium native IndexedDB; generated quotes and real-engine closed trades. Timings exclude fixture preparation; restore includes file validation, preview, confirmation and loading.',
    }
    await mkdir(resolve('.vite'), { recursive: true })
    await writeFile(resolve(`.vite/library-performance-${tradeCount}.json`), JSON.stringify(report, null, 2) + '\n')
    await testInfo.attach('library-performance', { body: JSON.stringify(report), contentType: 'application/json' })
  })
}
