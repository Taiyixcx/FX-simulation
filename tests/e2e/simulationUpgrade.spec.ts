import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { advanceSimulation } from '../../src/engine/simulationSource'
import type { SessionSnapshot } from '../../src/storage/sessionSnapshot'
import { extendSession, makeLegacySession, makeSession } from '../unit/sessionFixture'

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('已保存到本机')
}

async function writeSnapshot(page: Page, savedSnapshot: { id: string; revision: number }) {
  await page.evaluate(async (snapshot) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('fx-simulation', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['settings', 'sessions'], 'readwrite')
        transaction.objectStore('sessions').put(snapshot)
        transaction.objectStore('settings').put({ id: snapshot.id, revision: snapshot.revision }, 'current')
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
      })
    } finally { database.close() }
  }, savedSnapshot)
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
          const request = transaction.objectStore('sessions').get((pointer.result as { id: string }).id)
          request.onsuccess = () => resolve(request.result as SessionSnapshot)
        }
        transaction.onabort = () => reject(transaction.error)
      })
    } finally { database.close() }
  })
}

test('切换练习情景需创建独立会话，刷新后情景保持且暂停', async ({ page }) => {
  await page.goto('/')
  await waitSaved(page)
  const original = await readSnapshot(page)
  expect(original.sourceState.version).toBe(2)
  expect(original.sourceState.scenario).toBe('standard')
  await page.getByLabel('新练习情景').selectOption('eventful')
  expect(await readSnapshot(page)).toEqual(original)
  await page.getByRole('button', { name: '新练习', exact: true }).focus()
  await page.keyboard.press('Enter')
  await waitSaved(page)
  const eventful = await readSnapshot(page)
  expect(eventful.id).not.toBe(original.id)
  expect(eventful.sourceState.scenario).toBe('eventful')
  expect(eventful.account).toEqual({ balanceUsd: '10000', position: null })
  await page.reload()
  await waitSaved(page)
  await expect(page.getByLabel('新练习情景')).toHaveValue('eventful')
  await expect(page.getByTestId('progress')).toContainText('已暂停')
  await page.getByLabel('货币对').selectOption('GBP/USD')
  await waitSaved(page)
  const switched = await readSnapshot(page)
  expect(switched.sourceState.scenario).toBe('eventful')
  expect(switched.id).not.toBe(eventful.id)
})

test('模拟事件与完成报价同时出现、保存和恢复，不提前公布结果', async ({ page }) => {
  let before = makeSession('EUR/USD', 1440, 'eventful')
  let after = extendSession(before)
  while (!after.sourceState.lastEvent) {
    before = after
    after = extendSession(before)
  }
  expect(before.sourceState.lastEvent).toBeNull()
  await page.goto('/')
  await waitSaved(page)
  await writeSnapshot(page, before)
  await page.reload()
  await waitSaved(page)
  await expect(page.getByTestId('simulation-event')).toHaveCount(0)
  await page.getByRole('button', { name: '下一根', exact: true }).click()
  await waitSaved(page)
  const occurred = await readSnapshot(page)
  expect(occurred.sourceState).toEqual(after.sourceState)
  expect(occurred.frames.at(-1)).toEqual(after.frames.at(-1))
  await expect(page.getByTestId('simulation-event')).toContainText(after.sourceState.lastEvent!.label)
  await page.screenshot({ path: 'test-results/simulation-event.png', fullPage: true })
  await page.reload()
  await waitSaved(page)
  expect(await readSnapshot(page)).toEqual(occurred)
  await expect(page.getByTestId('progress')).toContainText('已暂停')
  await page.getByRole('button', { name: '下一根', exact: true }).click()
  await waitSaved(page)
  const next = await readSnapshot(page)
  expect(next.frames.at(-1)).toEqual(advanceSimulation(occurred.sourceState)!.frame)
})

test('既有练习保存历史和账本，从最后报价衔接新模型并暂停恢复', async ({ page }) => {
  const legacy = makeLegacySession()
  await page.goto('/')
  await waitSaved(page)
  await writeSnapshot(page, legacy)
  await page.reload()
  await waitSaved(page)
  await expect(page.getByTestId('progress')).toContainText(`${legacy.frames.length} / ${legacy.sourceState.maxFrames} 根 · 已暂停`)
  await expect(page.getByRole('button', { name: '平仓', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '下一根', exact: true }).click()
  await waitSaved(page)
  const upgraded = await readSnapshot(page)
  expect(upgraded.schemaVersion).toBe(2)
  expect(upgraded.sourceState.version).toBe(2)
  expect(upgraded.sourceState.originFrameIndex).toBe(legacy.frames.length)
  expect(upgraded.frames.slice(0, legacy.frames.length)).toEqual(legacy.frames)
  expect(upgraded.account).toEqual(legacy.account)
  expect(upgraded.trades).toEqual(legacy.trades)
  await page.reload()
  await waitSaved(page)
  expect(await readSnapshot(page)).toEqual(upgraded)
  await page.getByRole('button', { name: '下一根', exact: true }).click()
  await waitSaved(page)
  expect((await readSnapshot(page)).frames.at(-1)).toEqual(advanceSimulation(upgraded.sourceState)!.frame)
})
