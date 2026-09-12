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

export function formatIls(value: string) {
  return `₪${formatMoney(value)}`
}
