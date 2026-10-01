import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { SessionSnapshot } from '../../src/storage/sessionSnapshot'

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('已保存到本机')
}

async function readSnapshot(page: Page): Promise<SessionSnapshot> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fx-simulation', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<SessionSnapshot>((resolve, reject) => {
        const transaction = database.transaction(['settings', 'sessions'], 'readonly')
        const pointer = transaction.objectStore('settings').get('current')
        pointer.onsuccess = () => {
          const snapshot = transaction.objectStore('sessions').get((pointer.result as { id: string }).id)
          snapshot.onsuccess = () => resolve(snapshot.result as SessionSnapshot)
        }
        transaction.onabort = () => reject(transaction.error)
      })
    } finally { database.close() }
  })
}

test('多空交易、逐根推进及刷新恢复同一快照并暂停', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto('/')
  await waitSaved(page)
  await expect(page.getByTestId('progress')).toContainText('1 / 1440 根 · 已暂停')
  await page.getByRole('button', { name: '买涨（做多）', exact: true }).click()
  await waitSaved(page)
  await expect(page.getByTestId('position-pnl')).toContainText('亏损 -')
  await expect(page.getByRole('button', { name: '买跌（做空）', exact: true })).toBeDisabled()
  const opened = await readSnapshot(page)
  await page.reload()
  await waitSaved(page)
  expect(await readSnapshot(page)).toEqual(opened)
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '下一根', exact: true }).click()
  await waitSaved(page)
  await expect(page.getByTestId('progress')).toContainText('2 / 1440')
  await page.getByRole('button', { name: '平仓', exact: true }).click()
  await waitSaved(page)
  const closed = await readSnapshot(page)
  expect(closed.account.position).toBeNull()
  expect(closed.trades).toHaveLength(1)
  await page.getByRole('button', { name: '买跌（做空）', exact: true }).click()
  await waitSaved(page)
  await expect(page.getByTestId('position-pnl')).toContainText('亏损 -')
  await page.getByRole('button', { name: '平仓', exact: true }).click()
  await waitSaved(page)
  expect((await readSnapshot(page)).trades).toHaveLength(2)
  await page.getByLabel('速度').selectOption('10')
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await expect(page.getByTestId('progress')).toContainText('12 / 1440')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await waitSaved(page)
  const paused = await readSnapshot(page)
  await page.waitForTimeout(1100)
  expect(await readSnapshot(page)).toEqual(paused)
  await page.getByRole('button', { name: 'K 线', exact: true }).click()
  await expect(page.getByRole('button', { name: 'K 线', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '折线', exact: true }).click()
  expect(pageErrors).toEqual([])
})

test('无效金额被解释；切换品种保存旧练习并创建独立资金', async ({ page }) => {
  await page.goto('/')
  await waitSaved(page)
  const oldSnapshot = await readSnapshot(page)
  for (const input of ['0', '-1', '1.001', 'abc', '10000.01']) {
    await page.getByLabel('交易金额（USD）').fill(input)
    await expect(page.getByRole('button', { name: '买涨（做多）', exact: true })).toBeDisabled()
    await expect(page.locator('#amount-error')).toBeVisible()
  }
  await page.getByLabel('货币对').selectOption('GBP/USD')
  await waitSaved(page)
  const newSnapshot = await readSnapshot(page)
  expect(newSnapshot.id).not.toBe(oldSnapshot.id)
  expect(newSnapshot.pair).toBe('GBP/USD')
  expect(newSnapshot.account.balanceUsd).toBe('10000')
  await expect(page.getByText('1.5 pip', { exact: true })).toBeVisible()
  const savedSessionCount = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('fx-simulation'); request.onsuccess = () => resolve(request.result) })
    const count = await new Promise<number>(resolve => { const request = database.transaction('sessions').objectStore('sessions').count(); request.onsuccess = () => resolve(request.result) })
    database.close()
    return count
  })
  expect(savedSessionCount).toBe(2)
})

test('写入失败保留未保存持仓，重试只保存一次交易', async ({ page }) => {
  await page.goto('/')
  await waitSaved(page)
  const previous = await readSnapshot(page)
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put
    let shouldFail = true
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'sessions' && shouldFail) { shouldFail = false; throw new DOMException('模拟磁盘配额不足', 'QuotaExceededError') }
      return originalPut.apply(this, args)
    }
  })
  await page.getByRole('button', { name: '买涨（做多）', exact: true }).click()
  await expect(page.getByTestId('save-status')).toHaveText('保存失败')
  await expect(page.getByRole('alert')).toContainText('模拟磁盘配额不足')
  await expect(page.getByRole('button', { name: '下一根', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '平仓', exact: true })).toBeDisabled()
  await page.screenshot({ path: 'test-results/design-save-failure.png', fullPage: true })
  expect(await readSnapshot(page)).toEqual(previous)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前快照', exact: true }).click()
  expect((await downloadPromise).suggestedFilename()).toMatch(/^fx-snapshot-.+\.json$/)
  await page.getByRole('button', { name: '重试保存', exact: true }).click()
  await waitSaved(page)
  const retried = await readSnapshot(page)
  expect(retried.account.position?.direction).toBe('long')
  expect(retried.trades).toHaveLength(0)
  await page.getByRole('button', { name: '平仓', exact: true }).click()
  await waitSaved(page)
  expect((await readSnapshot(page)).trades).toHaveLength(1)
})

test('两个窗口同时练习时旧窗口不会覆盖已保存进度', async ({ page, context }) => {
  await page.goto('/')
  await waitSaved(page)
  const otherPage = await context.newPage()
  await otherPage.goto('/')
  await waitSaved(otherPage)
  await page.getByRole('button', { name: '下一根', exact: true }).click()
  await waitSaved(page)
  const current = await readSnapshot(page)
  await otherPage.getByRole('button', { name: '买跌（做空）', exact: true }).click()
  await expect(otherPage.getByTestId('save-status')).toHaveText('保存失败')
  await expect(otherPage.getByRole('alert')).toContainText('另一窗口已更新练习')
  expect(await readSnapshot(page)).toEqual(current)
})

for (const width of [1440, 1024, 390]) {
  test(`${width}px 布局及键盘交易，文字放大后无整页横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/')
    await waitSaved(page)
    await expect(page.getByTestId('market-chart').locator('canvas').first()).toBeVisible()
    await page.getByLabel('交易金额（USD）').fill('500')
    await page.getByRole('button', { name: '买涨（做多）', exact: true }).focus()
    await page.keyboard.press('Enter')
    await waitSaved(page)
    await page.getByRole('button', { name: '平仓', exact: true }).focus()
    await page.keyboard.press('Enter')
    await waitSaved(page)
    expect((await readSnapshot(page)).trades).toHaveLength(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/workspace-${width}.png`, fullPage: true })
    await page.addStyleTag({ content: 'html { font-size: 32px !important; }' })
    await expect(page.getByLabel('交易金额（USD）')).toHaveCSS('font-size', '40px')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('button', { name: '买跌（做空）', exact: true }).focus()
    await page.keyboard.press('Enter')
    await waitSaved(page)
    await expect(page.getByRole('button', { name: '平仓', exact: true })).toBeEnabled()
    await page.screenshot({ path: `test-results/workspace-${width}-large-text.png`, fullPage: true })
  })
}
