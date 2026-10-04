import { describe, expect, it } from 'vitest'
import { calculateAccount } from '../../src/engine/account'
import { MoneyDecimal } from '../../src/engine/decimal'
import { EngineError } from '../../src/engine/errors'
import { closePosition, openPosition, prepareOpenPosition, previewPositionRisk, previewTradeRisk, settleDepletedAccount } from '../../src/engine/execution'
import type { AccountState, MarketQuote, TradeDirection } from '../../src/engine/types'

const startTimestampMs = Date.UTC(2024, 2, 4, 0, 1)
function makeQuote(bidPrice: string, askPrice: string, timestampMs = startTimestampMs): MarketQuote {
  return { timestampMs, bidPrice, askPrice, askSource: 'training' }
}
const emptyAccount: AccountState = { balanceUsd: '10000.00', position: null }
const entryQuote = makeQuote('1.1000', '1.1001')

describe('execution price and settlement', () => {
  it.each([
    ['long', '1100.10', '1.1010', '1.1011', '0.90'],
    ['short', '1100.00', '1.0990', '1.0991', '0.90'],
    ['long', '1100.10', '1.1000', '1.1001', '-0.10'],
    ['short', '1100.00', '1.1000', '1.1001', '-0.10'],
    ['long', '1100.10', '1.10005', '1.10015', '-0.05'],
    ['short', '1100.00', '1.09995', '1.10005', '-0.05'],
    ['long', '1100.10', '1.0990', '1.0991', '-1.10'],
    ['short', '1100.00', '1.1010', '1.1011', '-1.10'],
  ])('settles the documented %s case at the correct quote side', (direction, notionalUsd, bidPrice, askPrice, expectedPnl) => {
    const account = openPosition(emptyAccount, entryQuote, 'EUR/USD', direction as TradeDirection, notionalUsd, 'case')
    expect(account.position?.quantityBaseUnits).toBe('1000')
    const exitQuote = makeQuote(bidPrice, askPrice, startTimestampMs + 60_000)
    const result = closePosition(account, exitQuote)
    expect(result.trade.realizedPnlUsd).toBe(expectedPnl)
    expect(result.trade.entryPrice).toBe(direction === 'long' ? '1.1001' : '1.1')
    expect(result.trade.exitPrice).toBe(new MoneyDecimal(direction === 'long' ? bidPrice : askPrice).toFixed())
    expect(result.account.balanceUsd).toBe(new MoneyDecimal('10000').plus(expectedPnl).toFixed(2))
    expect(result.account.position).toBeNull()
    expect(result.trade.reason).toBe('manual')
    expect(calculateAccount(result.account, exitQuote).reservedFundsUsd).toBe('0')
    expect(account.position).not.toBeNull()
  })

  it.each([
    ['1.000005', '0.01'],
    ['0.999995', '-0.01'],
    ['1.0000049', '0.00'],
  ])('uses HALF_UP only when settling raw profit at Bid %s', (bidPrice, expectedPnl) => {
    const account = openPosition(emptyAccount, makeQuote('1', '1'), 'EUR/USD', 'long', '1000', 'rounding')
    const exitQuote = makeQuote(bidPrice, new MoneyDecimal(bidPrice).plus('0.0001').toFixed())
    expect(calculateAccount(account, exitQuote).unrealizedPnlUsd).toBe(new MoneyDecimal(bidPrice).minus('1').times('1000').toFixed())
    expect(closePosition(account, exitQuote).trade.realizedPnlUsd).toBe(expectedPnl)
  })

  it('scales quantity and profit with the user notional amount', () => {
    const small = openPosition(emptyAccount, entryQuote, 'EUR/USD', 'long', '110.01', 'small')
    const large = openPosition(emptyAccount, entryQuote, 'EUR/USD', 'long', '1100.10', 'large')
    expect(small.position?.quantityBaseUnits).toBe('100')
    expect(large.position?.quantityBaseUnits).toBe('1000')
    const exitQuote = makeQuote('1.101', '1.1011')
    expect(closePosition(small, exitQuote).trade.realizedPnlUsd).toBe('0.09')
    expect(closePosition(large, exitQuote).trade.realizedPnlUsd).toBe('0.90')
  })

  it('allows the exact funds boundary but rejects overspending without mutation', () => {
    const account = openPosition(emptyAccount, entryQuote, 'EUR/USD', 'long', '10000', 'all')
    expect(account.position?.notionalUsd).toBe('10000.00')
    expect(() => openPosition(emptyAccount, entryQuote, 'EUR/USD', 'long', '10000.01', 'too-much')).toThrow(EngineError)
    expect(emptyAccount).toEqual({ balanceUsd: '10000.00', position: null })
  })

  it('rejects a second position and settles a closed position only once', () => {
    const account = openPosition(emptyAccount, entryQuote, 'EUR/USD', 'short', '100', 'first')
    expect(() => openPosition(account, entryQuote, 'EUR/USD', 'long', '100', 'second')).toThrow('先平仓')
    const result = closePosition(account, entryQuote)
    expect(() => closePosition(result.account, entryQuote)).toThrow('没有')
  })

  it('rejects new orders when a previous gap left a negative balance', () => {
    expect(() => openPosition({ balanceUsd: '-2.00', position: null }, entryQuote, 'EUR/USD', 'long', '1', 'new')).toThrow('可用资金')
  })
})

describe('equity depletion', () => {
  it('rejects an equity-depleted reason while funds remain', () => {
    const account = openPosition(emptyAccount, entryQuote, 'EUR/USD', 'long', '100', 'reason')
    expect(() => closePosition(account, entryQuote, 'equity-depleted')).toThrow('尚未耗尽')
  })

  it('settles at the current visible quote and preserves a gap-caused negative balance', () => {
    const account = openPosition({ balanceUsd: '100.00', position: null }, makeQuote('1', '1'), 'EUR/USD', 'short', '100', 'gap')
    const result = settleDepletedAccount(account, makeQuote('2.5', '2.5001', startTimestampMs + 60_000))!
    expect(result.account).toEqual({ balanceUsd: '-50.01', position: null })
    expect(result.trade).toMatchObject({ exitPrice: '2.5001', realizedPnlUsd: '-150.01', reason: 'equity-depleted' })
    expect(settleDepletedAccount(result.account, makeQuote('1', '1'))).toBeNull()
  })

  it('includes the exact equity-zero boundary', () => {
    const account = openPosition({ balanceUsd: '100.00', position: null }, makeQuote('1', '1'), 'EUR/USD', 'short', '100', 'zero')
    const result = settleDepletedAccount(account, makeQuote('2', '2'))!
    expect(result.account.balanceUsd).toBe('0.00')
    expect(result.trade.realizedPnlUsd).toBe('-100.00')
  })

  it('returns null while equity is positive and checks an intermediate frame before recovery', () => {
    let account = openPosition({ balanceUsd: '100.00', position: null }, makeQuote('1', '1'), 'EUR/USD', 'short', '100', 'intermediate')
    expect(settleDepletedAccount(account, makeQuote('1.9', '1.9'))).toBeNull()
    const frames = [makeQuote('2.1', '2.1'), makeQuote('1', '1')]
    const trades = []
    for (const frame of frames) {
      const settlement = settleDepletedAccount(account, frame)
      if (settlement) {
        account = settlement.account
        trades.push(settlement.trade)
      }
    }
    expect(account.balanceUsd).toBe('-10.00')
    expect(trades).toHaveLength(1)
    expect(trades[0]?.exitPrice).toBe('2.1')
  })
})

describe('new-order admission and executable-side risk preview', () => {
  it.each(['2', '3'])('rejects zero/negative entry equity at Ask %s without changing legacy ledger reconstruction', (askPrice) => {
    const wideQuote = makeQuote('1', askPrice)
    const legacy = openPosition(emptyAccount, wideQuote, 'EUR/USD', 'short', '10000', 'legacy-wide')
    expect(new MoneyDecimal(calculateAccount(legacy, wideQuote).equityUsd).lte(0)).toBe(true)
    expect(() => prepareOpenPosition(emptyAccount, wideQuote, 'EUR/USD', 'short', '10000', 'new-wide')).toThrow('点差成本')
    const preview = previewTradeRisk(emptyAccount, wideQuote, 'EUR/USD', 'short', '10000')
    expect(preview.canOpen).toBe(false)
    expect(preview.rejectionMessage).toContain('耗尽')
    expect(emptyAccount.position).toBeNull()
    expect(closePosition(legacy, wideQuote).account.position).toBeNull()
  })

  it('uses raw positive entry equity even when the displayed cents would be zero', () => {
    const quote = makeQuote('0.00000001', '1')
    expect(prepareOpenPosition(emptyAccount, quote, 'EUR/USD', 'long', '10000', 'tiny-positive').position).not.toBeNull()
    const preview = previewTradeRisk(emptyAccount, quote, 'EUR/USD', 'long', '10000')
    expect(preview.entryEquityUsd).toBe('0.0001')
    expect(preview.canOpen).toBe(true)
  })

  it.each(['long', 'short'] as const)('matches %s immediate settlement and hypothetical executable exit', direction => {
    const candidate = prepareOpenPosition(emptyAccount, entryQuote, 'EUR/USD', direction, '1000', 'preview-match')
    const hypotheticalExitPrice = direction === 'long' ? '1.1009' : '1.0992'
    const hypotheticalQuote = makeQuote(hypotheticalExitPrice, hypotheticalExitPrice)
    const preview = previewTradeRisk(emptyAccount, entryQuote, 'EUR/USD', direction, '1000', hypotheticalExitPrice)
    expect(preview.quantityBaseUnits).toBe(candidate.position!.quantityBaseUnits)
    expect(preview.usdPerPip).toBe(new MoneyDecimal(candidate.position!.quantityBaseUnits).times('0.0001').toFixed())
    expect(preview.spreadPips).toBe('1')
    expect(preview.exitQuoteSide).toBe(direction === 'long' ? 'bid' : 'ask')
    expect(preview.immediateClosePnlUsd).toBe(closePosition(candidate, entryQuote).trade.realizedPnlUsd)
    expect(preview.hypotheticalPnlUsd).toBe(closePosition(candidate, hypotheticalQuote).trade.realizedPnlUsd)
  })

  it('accepts zero spreads and rejects invalid hypothetical prices without changing the account', () => {
    const quote = makeQuote('1', '1')
    expect(previewTradeRisk(emptyAccount, quote, 'GBP/USD', 'short', '1000').immediateClosePnlUsd).toBe('0.00')
    expect(() => previewTradeRisk(emptyAccount, quote, 'EUR/USD', 'long', '1000', '0')).toThrow('正数')
    expect(() => previewTradeRisk(emptyAccount, quote, 'EUR/USD', 'long', '1000', '1e2')).toThrow('十进制')
    expect(previewTradeRisk(emptyAccount, quote, 'EUR/USD', 'long', '1000', '').hypotheticalPnlUsd).toBeNull()
  })

  it('previews a live short at the latest Ask without admitting another order or changing it', () => {
    const account = prepareOpenPosition(emptyAccount, entryQuote, 'EUR/USD', 'short', '1100', 'live-preview')
    const latest = makeQuote('1.099', '1.0991', startTimestampMs + 60_000)
    const before = structuredClone(account)
    const preview = previewPositionRisk(account, latest, '1.0981')
    expect(preview).toMatchObject({ direction: 'short', exitQuoteSide: 'ask', usdPerPip: '0.1', immediateClosePnlUsd: '0.90', hypotheticalPnlUsd: '1.90', currentEquityUsd: '10000.9' })
    expect(account).toEqual(before)
    expect(() => previewPositionRisk(emptyAccount, entryQuote)).toThrow('没有')
  })
})
