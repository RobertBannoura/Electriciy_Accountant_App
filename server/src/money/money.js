import Decimal from 'decimal.js'

export const BASE_CURRENCY = 'ILS'
export const SUPPORTED_CURRENCIES = Object.freeze(['ILS', 'USD', 'JOD'])

const supportedCurrencySet = new Set(SUPPORTED_CURRENCIES)
const DECIMAL_STRING_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

// Keep financial arithmetic isolated from Decimal's mutable global configuration.
const MoneyDecimal = Decimal.clone({
  precision: 100,
  rounding: Decimal.ROUND_HALF_UP,
})

const HALF_SHEKEL = new MoneyDecimal('0.5')

export class MoneyValidationError extends TypeError {
  constructor(message, code) {
    super(message)
    this.name = 'MoneyValidationError'
    this.code = code
  }
}

function parseDecimalString(value, fieldName) {
  if (typeof value !== 'string' || !DECIMAL_STRING_PATTERN.test(value)) {
    throw new MoneyValidationError(
      `${fieldName} must be a plain decimal string`,
      'INVALID_DECIMAL_STRING',
    )
  }

  const decimal = new MoneyDecimal(value)

  if (!decimal.isFinite()) {
    throw new MoneyValidationError(
      `${fieldName} must be finite`,
      'NON_FINITE_DECIMAL',
    )
  }

  return decimal
}

function requireNonnegative(decimal, fieldName) {
  if (decimal.isNegative()) {
    throw new MoneyValidationError(
      `${fieldName} must not be negative`,
      'NEGATIVE_AMOUNT',
    )
  }
}

function toDecimalString(decimal) {
  return decimal.isZero() ? '0' : decimal.toFixed()
}

export function formatMoneyDisplay(value) {
  const decimal = new MoneyDecimal(value)
  const rounded = decimal.toDecimalPlaces(2)
  if (!decimal.isZero() && rounded.isZero()) return decimal.isNegative() ? '>-0.01' : '<0.01'
  return rounded.toFixed(2)
}

function prepareExactOperation(...decimals) {
  // Decimal operation precision is derived from operand digit counts. The native
  // numbers here describe string lengths; financial values remain Decimal values.
  const precision =
    decimals.reduce((total, decimal) => total + decimal.sd(), 0) + 10
  const OperationDecimal = Decimal.clone({
    precision,
    rounding: Decimal.ROUND_HALF_UP,
  })

  return decimals.map((decimal) => new OperationDecimal(decimal.toFixed()))
}

/**
 * Returns whether a decimal-string ILS value is an exact multiple of 0.50.
 * Invalid inputs return false so this helper can be used directly by validators.
 */
export function isValidIlsStep(amount) {
  try {
    const decimal = parseDecimalString(amount, 'amount')
    const [exactAmount, exactStep] = prepareExactOperation(decimal, HALF_SHEKEL)

    return exactAmount.mod(exactStep).isZero()
  } catch (error) {
    if (error instanceof MoneyValidationError) {
      return false
    }

    throw error
  }
}

/**
 * Rounds to the nearest 0.50 ILS. Exact ties round away from zero.
 */
export function roundIlsToHalfShekel(amount) {
  const decimal = parseDecimalString(amount, 'amount')
  const [exactAmount, exactStep] = prepareExactOperation(decimal, HALF_SHEKEL)
  const rounded = exactAmount.toNearest(exactStep, Decimal.ROUND_HALF_UP)

  return toDecimalString(rounded)
}

/**
 * Converts a nonnegative foreign amount to ILS without rounding the result.
 */
export function convertForeignToIls(originalAmount, exchangeRate) {
  const amount = parseDecimalString(originalAmount, 'originalAmount')
  const rate = parseDecimalString(exchangeRate, 'exchangeRate')

  requireNonnegative(amount, 'originalAmount')

  if (!rate.gt(new MoneyDecimal('0'))) {
    throw new MoneyValidationError(
      'exchangeRate must be greater than zero',
      'INVALID_EXCHANGE_RATE',
    )
  }

  const [exactAmount, exactRate] = prepareExactOperation(amount, rate)

  return toDecimalString(exactAmount.mul(exactRate))
}

/**
 * Produces the complete immutable monetary snapshot that a payment must persist.
 * The captured exchange rate is used once and remains part of the transaction.
 */
export function createPaymentMoneySnapshot({
  currency,
  originalAmount,
  exchangeRate = null,
}) {
  if (!supportedCurrencySet.has(currency)) {
    throw new MoneyValidationError(
      `Unsupported currency: ${String(currency)}`,
      'UNSUPPORTED_CURRENCY',
    )
  }

  const amount = parseDecimalString(originalAmount, 'originalAmount')
  requireNonnegative(amount, 'originalAmount')

  if (currency === BASE_CURRENCY) {
    if (exchangeRate !== null && exchangeRate !== undefined) {
      throw new MoneyValidationError(
        'ILS payments must not include an exchange rate',
        'UNEXPECTED_EXCHANGE_RATE',
      )
    }

    if (!isValidIlsStep(originalAmount)) {
      throw new MoneyValidationError(
        'ILS amounts must use increments of 0.50',
        'INVALID_ILS_STEP',
      )
    }

    return Object.freeze({
      currency,
      originalAmount,
      exchangeRate: null,
      convertedIlsAmount: originalAmount,
    })
  }

  if (exchangeRate === null || exchangeRate === undefined) {
    throw new MoneyValidationError(
      'Foreign payments require an exchange rate',
      'MISSING_EXCHANGE_RATE',
    )
  }

  parseDecimalString(exchangeRate, 'exchangeRate')
  const convertedIlsAmount = convertForeignToIls(
    originalAmount,
    exchangeRate,
  )

  return Object.freeze({
    currency,
    originalAmount,
    exchangeRate,
    convertedIlsAmount,
  })
}
