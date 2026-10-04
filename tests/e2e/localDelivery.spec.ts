import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { readSnapshot, waitSaved } from './sessionDatabase'

test('本机启动入口遇到4173占用时失败，不切换端口或启动额外服务', async () => {
  const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/startLocal.mjs'), '--no-open'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => resolveResult({ code, output }))
  })
  expect(result.code).toBe(1)
  expect(result.output).toContain('4173 已被占用')
  expect(result.output).toContain('不会更换端口')
})

test('浏览器外网不可达时本机资源、交易、备注与刷新暂停恢复仍可用', async ({ browser }) => {
  // A dead proxy blocks non-loopback network at the browser transport layer.
  // This does not alter the user's operating system/network interfaces.
  const context = await browser.newContext({ proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost' } })
  const page = await context.newPage()
  const requests: string[] = []
  const errors: string[] = []
  page.on('request', request => requests.push(request.url()))
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto('http://127.0.0.1:4173')
    await waitSaved(page)
    expect(await page.evaluate(async () => {
      try { await fetch('https://example.com', { signal: AbortSignal.timeout(3_000) }); return false }
      catch { return true }
    })).toBe(true)
    const externalProbe = requests.splice(0)
    expect(externalProbe.filter(url => new URL(url).origin !== 'http://127.0.0.1:4173')).toEqual(['https://example.com/'])
    await page.getByRole('button', { name: '买涨（做多）', exact: true }).click()
    await waitSaved(page)
    await page.getByRole('button', { name: '下一根', exact: true }).click()
    await waitSaved(page)
    await page.getByRole('button', { name: '平仓', exact: true }).click()
    await waitSaved(page)
    const saved = await readSnapshot(page)
    await page.reload()
    await waitSaved(page)
    expect(await readSnapshot(page)).toEqual(saved)
    await expect(page.getByTestId('progress')).toContainText('已暂停')
    expect(requests.filter(url => new URL(url).origin !== 'http://127.0.0.1:4173')).toEqual([])
    expect(errors).toEqual([])
  } finally { await context.close() }
})
