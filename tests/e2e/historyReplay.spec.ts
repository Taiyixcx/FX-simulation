import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import type { MarketFrame } from '../../src/engine/types'
import { countSessions, readSnapshot, waitSaved } from './sessionDatabase'

// Generated fixtures exercise the normalized CSV interface; they are not historical quotes.
const MIXED_ASK_CSV = [
  'timestamp,open,high,low,close,ask',
  '2024-03-04T08:01:00Z,1.10000,1.10040,1.09980,1.10020,1.10035',
  '2024-03-04T16:02:00+08:00,1.10020,1.10070,1.10010,1.10050,',
  '2024-03-04T08:05:00Z,1.10050,1.10120,1.10040,1.10100,1.10125',
  '2024-03-04T08:06:00Z,1.10100,1.10130,1.10090,1.10110,1.10150',
].join('\n')

interface PersistedPractice {
  id: string
  pair: string
  frames: MarketFrame[]
  frameStartIndex: number
  account: {
    balanceUsd: string
    position: { id: string; direction: string; entryPrice: string } | null
  }
  trades: { id: string; entryPrice: string; exitPrice: string; realizedPnlUsd: string }[]
}

async function readAllStores(page: Page): Promise<Record<string, unknown[]>> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fx-simulation')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const storeNames = Array.from(database.objectStoreNames)
      return await new Promise<Record<string, unknown[]>>((resolve, reject) => {
        const records: Record<string, unknown[]> = {}
        const transaction = database.transaction(storeNames, 'readonly')
        for (const name of storeNames) {
          const request = transaction.objectStore(name).getAll()
          request.onsuccess = () => { records[name] = request.result as unknown[] }
        }
        transaction.oncomplete = () => resolve(records)
        transaction.onabort = () => reject(transaction.error ?? new Error('读取测试数据库失败'))
      })
    } finally { database.close() }
  })
}

async function openHistoryPanel(page: Page): Promise<void> {
  const csvFile = page.getByLabel(/^CSV\s*文件$/)
  if (!await csvFile.isVisible()) await page.getByLabel('历史数据管理', { exact: true }).locator('summary').click()
  await expect(csvFile).toBeVisible()
}

async function selectCsv(page: Page, csv: string, pair = 'EUR/USD'): Promise<void> {
  await openHistoryPanel(page)
  await page.getByLabel(/^CSV\s*货币对/).selectOption(pair)
  await page.getByLabel(/^来源名称/).fill('P2 生成测试样例')
  await page.getByLabel(/^CSV\s*文件$/).setInputFiles({
    name: 'p2-generated-example.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  })
}

async function importDataset(page: Page, csv = MIXED_ASK_CSV, pair = 'EUR/USD'): Promise<void> {
  await selectCsv(page, csv, pair)
  await page.getByRole('button', { name: /^导入\s*CSV$/ }).click()
  const datasets = page.getByLabel(/^历史数据集/)
  await expect.poll(async () => datasets.locator('option').evaluateAll(options =>
    options.filter(option => (option as HTMLOptionElement).value !== '').length)).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: '开始历史练习', exact: true })).toBeEnabled()
}

async function startHistory(page: Page, csv = MIXED_ASK_CSV, pair = 'EUR/USD'): Promise<void> {
  await importDataset(page, csv, pair)
  await page.getByRole('button', { name: '开始历史练习', exact: true }).click()
  await expect(page.getByTestId('history-source')).toBeVisible()
  await waitSaved(page)
}

test('导入混合 Ask，历史仅暴露已推进前缀，缺口与末尾允许最后报价平仓', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await waitSaved(page)
  const simulation = await readSnapshot<PersistedPractice>(page)
  await importDataset(page)
  expect(await readSnapshot(page)).toEqual(simulation)
  expect(await countSessions(page)).toBe(1)
  await page.getByRole('button', { name: '开始历史练习', exact: true }).click()
  await expect(page.getByTestId('history-source')).toBeVisible()
  await waitSaved(page)
  const initial = await readSnapshot<PersistedPractice>(page)
  expect(initial.id).not.toBe(simulation.id)
  expect(initial.account.balanceUsd).toBe('10000.00')
  expect(initial.frames).toHaveLength(1)
  expect(initial.frames[0]!.quote.bidPrice).toBe('1.1002')
  expect(initial.frames[0]!.quote.askPrice).toBe('1.10035')
  await expect(page.getByTestId('history-source')).toContainText('源文件 Ask')
  await expect(page.getByTestId('history-source')).toContainText('真实性未核实')
  await expect(page.getByTestId('progress')).toContainText('1 / 4 根')
  const chart = page.getByTestId('market-chart')
  const instanceId = await chart.getAttribute('data-chart-instance-id')
  await expect(chart).toHaveAttribute('data-frame-count', '1')
  await expect(chart).toHaveAttribute('data-last-timestamp', String(Date.parse('2024-03-04T08:01:00Z')))
  await chart.focus()
  await page.keyboard.press('End')
  await page.keyboard.press('+')
  await expect(chart).toHaveAttribute('data-viewport-end-time', String(initial.frames[0]!.quote.timestampMs))
  await page.getByRole('button', { name: '买涨（做多）', exact: true }).click()
  await waitSaved(page)
  expect((await readSnapshot<PersistedPractice>(page)).account.position?.entryPrice).toBe('1.10035')
  await page.getByRole('button', { name: '下一根', exact: true }).click()
  await waitSaved(page)
  await expect(chart).toHaveAttribute('data-frame-count', '2')
  await expect(page.getByTestId('ask-price')).toHaveText('1.10060')
  await expect(page.getByTestId('history-source')).toContainText('训练 Ask')
  await expect(page.getByTestId('history-gap')).toHaveCount(0)
  await page.getByRole('button', { name: '下一根', exact: true }).click()
  await waitSaved(page)
  await expect(chart).toHaveAttribute('data-frame-count', '3')
  await expect(chart).toHaveAttribute('data-last-timestamp', String(Date.parse('2024-03-04T08:05:00Z')))
  await expect(page.getByTestId('history-gap')).toContainText('3 分钟')
  await expect(page.getByTestId('history-source')).toContainText('源文件 Ask')
  await page.getByLabel('速度', { exact: true }).selectOption('10')
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await expect(page.getByTestId('progress')).toContainText('4 / 4 根 · 已结束')
  await waitSaved(page)
  await expect(chart).toHaveAttribute('data-frame-count', '4')
  await expect(chart).toHaveAttribute('data-chart-instance-id', instanceId!)
  await expect(page.getByRole('button', { name: '下一根', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '平仓', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '平仓', exact: true }).click()
  await waitSaved(page)
  const closed = await readSnapshot<PersistedPractice>(page)
  expect(closed.account.position).toBeNull()
  expect(closed.trades).toHaveLength(1)
  expect(closed.trades[0]!.entryPrice).toBe('1.10035')
  expect(closed.trades[0]!.exitPrice).toBe('1.1011')
  expect(await readSnapshot(page, simulation.id)).toEqual(simulation)
  expect(errors).toEqual([])
})

test('错误 CSV 逐行报告多个字段，导入失败不会改写当前练习或已有数据集', async ({ page }) => {
  await page.goto('/')
  await waitSaved(page)
  await startHistory(page)
  await page.getByRole('button', { name: '买跌（做空）', exact: true }).click()
  await waitSaved(page)
  const database = await readAllStores(page)
  const invalidCsv = [
    'timestamp,open,high,low,close,ask',
    '2024-03-04T08:01:00Z,1.1,1.0,1.2,1.1,1.0',
    '2024-03-04T16:01:00+08:00,-1,NaN,1.1,1.1,',
    '2024-03-04T08:00:00,1.1,1.2,1.0,1.1,1.2',
  ].join('\n')
  await selectCsv(page, invalidCsv)
  await page.getByRole('button', { name: /^导入\s*CSV$/ }).click()
  const errors = page.getByLabel('历史数据导入错误', { exact: true })
  await expect(errors).toContainText(/2.*(high|low)/s)
  await expect(errors).toContainText(/3.*timestamp/s)
  await expect(errors).toContainText(/4.*timestamp/s)
  expect(await readAllStores(page)).toEqual(database)
  await expect(page.getByRole('button', { name: '平仓', exact: true })).toBeEnabled()
})

test('历史持仓刷新恢复原来源并暂停，切回模拟与从头练习保留旧数据', async ({ page }) => {
  await page.goto('/')
  await waitSaved(page)
  await startHistory(page)
  await page.getByRole('button', { name: '买跌（做空）', exact: true }).click()
  await waitSaved(page)
  await page.getByRole('button', { name: '下一根', exact: true }).click()
  await waitSaved(page)
  const opened = await readSnapshot<PersistedPractice>(page)
  await page.getByLabel('速度', { exact: true }).selectOption('1')
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await expect(page.getByTestId('progress')).toContainText('播放中')
  await page.reload()
  await waitSaved(page)
  await expect(page.getByTestId('history-source')).toContainText('训练 Ask')
  await expect(page.getByTestId('progress')).toContainText('2 / 4 根 · 已暂停')
  expect(await readSnapshot(page)).toEqual(opened)
  await openHistoryPanel(page)
  await page.getByRole('button', { name: '从头练习', exact: true }).click()
  await waitSaved(page)
  await expect(page.getByTestId('progress')).toContainText('1 / 4 根 · 已暂停')
  const restarted = await readSnapshot<PersistedPractice>(page)
  expect(restarted.id).not.toBe(opened.id)
  expect(restarted.account.position).toBeNull()
  expect(await readSnapshot(page, opened.id)).toEqual(opened)
  await page.getByRole('button', { name: '切回模拟练习', exact: true }).click()
  await waitSaved(page)
  await expect(page.getByTestId('history-source')).toHaveCount(0)
  await expect(page.getByTestId('progress')).toContainText('已推进 1 根 · 已暂停')
  expect(await readSnapshot(page, restarted.id)).toEqual(restarted)
  expect(await readSnapshot(page, opened.id)).toEqual(opened)
  await openHistoryPanel(page)
  await expect(page.getByRole('button', { name: '开始历史练习', exact: true })).toBeEnabled()
  expect(await countSessions(page)).toBe(4)
})

test('历史推进保存失败保留数据库，重试保持相同报价并只保存一次', async ({ page }) => {
  await page.goto('/')
  await waitSaved(page)
  await startHistory(page)
  await page.getByRole('button', { name: '买涨（做多）', exact: true }).click()
  await waitSaved(page)
  const previous = await readSnapshot<PersistedPractice>(page)
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put
    let shouldFail = true
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'sessions' && shouldFail) {
        shouldFail = false
        throw new DOMException('历史推进保存配额不足', 'QuotaExceededError')
      }
      return originalPut.apply(this, args)
    }
  })
  await page.getByRole('button', { name: '下一根', exact: true }).click()
  await expect(page.getByTestId('save-status')).toHaveText('保存失败')
  await expect(page.locator('#session-error')).toContainText('历史推进保存配额不足')
  await expect(page.getByRole('button', { name: '下一根', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '平仓', exact: true })).toBeDisabled()
  await expect(page.getByTestId('ask-price')).toHaveText('1.10060')
  expect(await readSnapshot(page)).toEqual(previous)
  await page.getByRole('button', { name: '重试保存', exact: true }).click()
  await waitSaved(page)
  const retried = await readSnapshot<PersistedPractice>(page)
  expect(retried.id).toBe(previous.id)
  expect(retried.frames).toHaveLength(2)
  expect(retried.account.position).toEqual(previous.account.position)
  await expect(page.getByTestId('progress')).toContainText('2 / 4 根 · 已暂停')
  await page.getByRole('button', { name: '平仓', exact: true }).click()
  await waitSaved(page)
  expect((await readSnapshot<PersistedPractice>(page)).trades).toHaveLength(1)
})

test('数据集写请求成功后事务中止不会改动已有数据或当前持仓', async ({ page }) => {
  await page.goto('/')
  await waitSaved(page)
  await startHistory(page)
  await page.getByRole('button', { name: '买涨（做多）', exact: true }).click()
  await waitSaved(page)
  const database = await readAllStores(page)
  await page.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add
    let shouldFail = true
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) {
      const request = originalAdd.apply(this, args)
      if (this.name === 'datasets' && shouldFail) {
        shouldFail = false
        const transaction = this.transaction
        request.addEventListener('success', () => transaction.abort())
      }
      return request
    }
  })
  await selectCsv(page, MIXED_ASK_CSV.replace('1.10035', '1.10036'))
  await page.getByRole('button', { name: /^导入\s*CSV$/ }).click()
  await expect(page.getByRole('alert')).toContainText('导入事务未完成')
  expect(await readAllStores(page)).toEqual(database)
  await expect(page.getByRole('button', { name: '平仓', exact: true })).toBeEnabled()
})

test('本机样本校验通过才保存，损坏样本不会覆盖正在使用的历史数据', async ({ page }) => {
  const sampleCsv = '\uFEFF' + MIXED_ASK_CSV
  const source = {
    label: '生成的本机加载测试样例（非真实行情）', pair: 'EUR/USD', path: 'p2-local-example.csv',
    sha256: createHash('sha256').update(sampleCsv, 'utf8').digest('hex'),
    sourceName: '本机样本加载测试', sourceUrl: 'https://example.test/generated-fixture',
    originalTimezone: 'UTC/明确偏移', conversionNotes: '生成的规范 M1 测试样例',
    conversionVersion: 'test-v1', licenseNotes: '仅为软件测试生成',
  }
  await page.route('**/data/manifest.json', route => route.fulfill({ json: {
    version: 1, samples: [source, { ...source, label: '校验不匹配的测试样例', path: 'p2-broken-example.csv', sha256: '0'.repeat(64) }],
  } }))
  await page.route('**/data/p2-*-example.csv', route => route.fulfill({ contentType: 'text/csv', body: sampleCsv }))
  await page.goto('/')
  await waitSaved(page)
  const simulation = await readSnapshot<PersistedPractice>(page)
  await openHistoryPanel(page)
  await page.getByLabel(/^本机样本/).selectOption(source.path)
  await page.getByRole('button', { name: '载入本机样本', exact: true }).click()
  await expect(page.getByRole('button', { name: '开始历史练习', exact: true })).toBeEnabled()
  expect(await readSnapshot(page)).toEqual(simulation)
  await page.getByRole('button', { name: '开始历史练习', exact: true }).click()
  await waitSaved(page)
  await expect(page.getByTestId('history-source')).toContainText('来源已核对')
  await expect(page.getByTestId('history-source')).toContainText(source.sourceName)
  const database = await readAllStores(page)
  expect((database.datasets[0] as { metadata: { fileSha256: string } }).metadata.fileSha256).toBe(source.sha256)
  await page.getByLabel(/^本机样本/).selectOption('p2-broken-example.csv')
  await page.getByRole('button', { name: '载入本机样本', exact: true }).click()
  await expect(page.getByLabel('历史数据导入错误', { exact: true })).toContainText('校验不一致')
  await expect(page.getByLabel('历史数据导入错误', { exact: true })).toBeFocused()
  expect(await readAllStores(page)).toEqual(database)
})

test('两个历史窗口的陈旧保存不会覆盖已推进的行情', async ({ page, context }) => {
  await page.goto('/')
  await waitSaved(page)
  await startHistory(page)
  const otherPage = await context.newPage()
  await otherPage.goto('/')
  await waitSaved(otherPage)
  await page.getByRole('button', { name: '下一根', exact: true }).click()
  await waitSaved(page)
  const current = await readSnapshot<PersistedPractice>(page)
  await otherPage.getByRole('button', { name: '买跌（做空）', exact: true }).click()
  await expect(otherPage.getByTestId('save-status')).toHaveText('保存失败')
  await expect(otherPage.locator('#session-error')).toContainText('另一窗口已更新练习')
  expect(await readSnapshot(page)).toEqual(current)
})

test('390px 的历史导入和键盘交易，200% 文字下仍可操作且无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/')
  await waitSaved(page)
  await selectCsv(page, MIXED_ASK_CSV, 'GBP/USD')
  await page.getByRole('button', { name: /^导入\s*CSV$/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '开始历史练习', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '开始历史练习', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('history-source')).toBeVisible()
  await waitSaved(page)
  await page.getByRole('button', { name: '下一根', exact: true }).focus()
  await page.keyboard.press('Enter')
  await waitSaved(page)
  await expect(page.getByTestId('ask-price')).toHaveText('1.10065')
  await page.getByRole('button', { name: '买跌（做空）', exact: true }).focus()
  await page.keyboard.press('Enter')
  await waitSaved(page)
  await page.addStyleTag({ content: 'html { font-size: 32px !important; }' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: '平仓', exact: true }).focus()
  await page.keyboard.press('Enter')
  await waitSaved(page)
  await expect(page.getByLabel('交易金额（USD）')).toBeFocused()
  expect((await readSnapshot<PersistedPractice>(page)).trades).toHaveLength(1)
  await page.screenshot({ path: 'test-results/history-390-large-text.png', fullPage: true })
})
