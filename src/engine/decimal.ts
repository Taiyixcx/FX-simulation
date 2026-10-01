import Decimal from 'decimal.js'
import { EngineError, type EngineErrorCode } from './errors'

/** Keep this policy local so other libraries cannot change the account arithmetic. */
export const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
})

export function decimalToString(decimal: Decimal): string {
  return decimal.toFixed()
}

export function readDecimalString(
  input: string,
  field: string,
  errorCode: EngineErrorCode = 'invalid-account',
): Decimal {
  if (typeof input !== 'string' || !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(input)) {
    throw new EngineError(errorCode, `${field}必须是有效的十进制数。`)
  }
  const decimal = new MoneyDecimal(input)
  if (!decimal.isFinite()) {
    throw new EngineError(errorCode, `${field}必须是有限数值。`)
  }
  return decimal
}

export function validateTimestamp(
  timestampMs: number,
  errorCode: EngineErrorCode,
): void {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > 8.64e15) {
    throw new EngineError(errorCode, '行情时间无效。')
  }
}
