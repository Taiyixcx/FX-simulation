import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import {
  calculateAccount,
  validateAccountState,
  validateMarketQuote,
  validateNotionalUsd,
} from '../../src/engine/account'
import { MoneyDecimal } from '../../src/engine/decimal'
import { openPosition } from '../../src/engine/execution'
import type { AccountState, MarketQuote } from '../../src/engine/types'

const quote: MarketQuote = {
  timestampMs: Date.UTC(2024, 2, 4, 0, 1),
  bidPrice: '1.1000',
  askPrice: '1.1001',
  askSource: 'training',
}
const emptyAccount: AccountState = { balanceUsd: '10000.00', position: null }

describe('account valuation', () => {
  it('starts with independent settled funds and no unrealized amounts', () => {
    expect(calculateAccount(emptyAccount, quote)).toEqual({
      balanceUsd: '10000.00',
      reservedFundsUsd: '0',
      unrealizedPnlUsd: '0',
      equityUsd: '10000',
      availableFundsUsd: '10000',
    })
  })

  it('reserves the notional without subtracting it from the settled balance', () => {
    const account = openPosition(emptyAccount, quote, 'EUR/USD', 'long', '1100.10', 'long-1')
    expect(calculateAccount(account, quote)).toEqual({
      balanceUsd: '10000.00',
      reservedFundsUsd: '1100.1',
      unrealizedPnlUsd: '-0.1',
      equityUsd: '9999.9',
      availableFundsUsd: '8899.8',
    })
    expect(emptyAccount.position).toBeNull()
  })

  it('marks a short position to Ask and recomputes instead of accumulating each tick', () => {
    const account = openPosition(emptyAccount, quote, 'EUR/USD', 'short', '1100', 'short-1')
    const laterQuote = { ...quote, timestampMs: quote.timestampMs + 60_000, bidPrice: '1.0990', askPrice: '1.0991' }
    const firstMetrics = calculateAccount(account, laterQuote)
    expect(firstMetrics.unrealizedPnlUsd).toBe('0.9')
    expect(firstMetrics.equityUsd).toBe('10000.9')
    expect(calculateAccount(account, laterQuote)).toEqual(firstMetrics)
    expect(calculateAccount(account, quote).unrealizedPnlUsd).toBe('-0.1')
  })

  it('keeps precision in quantities and floating profit until settlement', () => {
    const account = openPosition(emptyAccount, quote, 'EUR/USD', 'long', '100', 'precise')
    const quantity = new MoneyDecimal('100').div('1.1001')
    expect(account.position?.quantityBaseUnits).toBe(quantity.toFixed())
    expect(account.position?.quantityBaseUnits.length).toBeGreaterThan(30)
    expect(calculateAccount(account, quote).unrealizedPnlUsd).toBe(quantity.times('-0.0001').toFixed())
  })

  it('floors available funds at zero while preserving negative equity', () => {
    const account = openPosition({ balanceUsd: '100.00', position: null }, quote, 'EUR/USD', 'short', '100', 'gap')
    const metrics = calculateAccount(account, { ...quote, bidPrice: '4', askPrice: '4.0001' })
    expect(new MoneyDecimal(metrics.equityUsd).lt(0)).toBe(true)
    expect(metrics.availableFundsUsd).toBe('0')
  })

  it('accepts negative settled balances after a gap, with no new available funds', () => {
    expect(calculateAccount({ balanceUsd: '-12.34', position: null }, quote)).toMatchObject({
      balanceUsd: '-12.34',
      equityUsd: '-12.34',
      availableFundsUsd: '0',
    })
  })

  it('rejects prices from before the position was opened', () => {
    const account = openPosition(emptyAccount, quote, 'EUR/USD', 'long', '100', 'time')
    expect(() => calculateAccount(account, { ...quote, timestampMs: quote.timestampMs - 60_000 })).toThrow('入场前')
  })
})

describe('financial validation', () => {
  it('keeps the 40-digit HALF_UP policy independent of Decimal global settings', () => {
    const previousPrecision = Decimal.precision
    const previousRounding = Decimal.rounding
    try {
      Decimal.set({ precision: 4, rounding: Decimal.ROUND_DOWN })
      expect(MoneyDecimal.precision).toBe(40)
      expect(new MoneyDecimal('1').div('3').toFixed()).toBe(`0.${'3'.repeat(40)}`)
      expect(new MoneyDecimal('-0.005').toDecimalPlaces(2).toFixed(2)).toBe('-0.01')
    } finally {
      Decimal.set({ precision: previousPrecision, rounding: previousRounding })
    }
  })

  it.each(['0', '-1', 'NaN', 'Infinity', '1e3', '1.001', '1.000', '', ' 1', '1,000'])('rejects invalid user USD amount %s', (input) => {
    expect(() => validateNotionalUsd(input)).toThrow()
  })

  it.each(['0.01', '.50', '100', '1234.56'])('accepts positive cent inputs %s', (input) => {
    expect(() => validateNotionalUsd(input)).not.toThrow()
  })

  it.each([
    { bidPrice: '0' },
    { askPrice: '1.0999' },
    { bidPrice: 'NaN' },
    { bidPrice: '1e-3' },
    { timestampMs: Number.NaN },
    { timestampMs: 0.5 },
    { askSource: 'unknown' },
  ])('rejects malformed market quotes %o', (invalidFields) => {
    expect(() => validateMarketQuote({ ...quote, ...invalidFields } as MarketQuote)).toThrow()
  })

  it('rejects fractional-cent settled money and tampered quantity', () => {
    expect(() => validateAccountState({ balanceUsd: '100.001', position: null })).toThrow()
    const account = openPosition(emptyAccount, quote, 'EUR/USD', 'long', '1100.10', 'tampered')
    const position = account.position!
    expect(() => validateAccountState({ ...account, position: { ...position, quantityBaseUnits: '999' } })).toThrow()
  })
})
