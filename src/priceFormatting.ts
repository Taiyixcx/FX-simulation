import Decimal from 'decimal.js'

export function formatUsd(amountUsd: string, includeCurrency = true): string {
  const [integer = '0', fraction = '00'] = new Decimal(amountUsd)
    .toFixed(2, Decimal.ROUND_HALF_UP).split('.')
  const formatted = `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`
  return includeCurrency ? `${formatted} USD` : formatted
}

export function formatPrice(price: string): string {
  return new Decimal(price).toFixed(5, Decimal.ROUND_HALF_UP)
}

export function getPnlTone(pnlUsd: string): 'positive' | 'negative' | 'muted' {
  const pnl = new Decimal(pnlUsd)
  return pnl.isZero() ? 'muted' : pnl.isPositive() ? 'positive' : 'negative'
}

export function formatPnl(pnlUsd: string, includeCurrency = true): string {
  const pnl = new Decimal(pnlUsd)
  const sign = pnl.isZero() ? '' : pnl.isPositive() ? '+' : '-'
  const label = pnl.isZero() ? '持平' : pnl.isPositive() ? '盈利' : '亏损'
  return `${label} ${sign}${formatUsd(pnl.abs().toString(), includeCurrency)}`
}

const timestampFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

export function formatTimestamp(timestampMs: number): string {
  return timestampFormatter.format(timestampMs)
}
