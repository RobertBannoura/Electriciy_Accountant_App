import Decimal from 'decimal.js'

const DisplayDecimal = Decimal.clone({ precision: 100 })

export function formatDecimal(value: string) {
  try {
    return new DisplayDecimal(value).toFixed()
  } catch {
    return value
  }
}

export function formatMoney(value: string) {
  try {
    return new DisplayDecimal(value).toDecimalPlaces(2).toFixed()
  } catch {
    return value
  }
}

export function formatHalfShekel(value: string) {
  try {
    return new DisplayDecimal(value)
      .toNearest('0.5', DisplayDecimal.ROUND_HALF_UP)
      .toFixed()
  } catch {
    return value
  }
}

export function formatIls(value: string) {
  return `₪${formatMoney(value)}`
}

export function currencySymbol(currency: string | null | undefined) {
  if (currency === 'ILS') return '₪'
  if (currency === 'USD') return '$'
  if (currency === 'JOD') return 'د.أ'
  return currency ?? ''
}

export function formatCurrencyAmount(value: string, currency: string | null | undefined) {
  const amount = formatDecimal(value)
  if (currency === 'JOD') return `${amount} ${currencySymbol(currency)}`
  return `${currencySymbol(currency)}${amount}`
}
