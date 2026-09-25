import Decimal from 'decimal.js'

const DisplayDecimal = Decimal.clone({ precision: 100 })

export function formatDecimal(value: string) {
  try {
    const decimal = new DisplayDecimal(value)
    const rounded = decimal.toDecimalPlaces(2)
    if (!decimal.isZero() && rounded.isZero()) return decimal.isNegative() ? '>-0.01' : '<0.01'
    return rounded.toFixed(2)
  } catch {
    return value
  }
}

export function formatMoney(value: string) {
  return formatDecimal(value)
}

export function formatQuantity(value: string) {
  try {
    const decimal = new DisplayDecimal(value)
    const rounded = decimal.toDecimalPlaces(3)
    if (!decimal.isZero() && rounded.isZero()) return decimal.isNegative() ? '>-0.001' : '<0.001'
    return rounded.toFixed()
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
