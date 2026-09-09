import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  BASE_CURRENCY,
  MoneyValidationError,
  SUPPORTED_CURRENCIES,
  convertForeignToIls,
  createPaymentMoneySnapshot,
  isValidIlsStep,
  roundIlsToHalfShekel,
} from '../src/money/money.js'

test('declares ILS as the base and only supports ILS, USD, and JOD', () => {
  assert.equal(BASE_CURRENCY, 'ILS')
  assert.deepEqual(SUPPORTED_CURRENCIES, ['ILS', 'USD', 'JOD'])
})

test('money implementation contains no Number-based financial operations', async () => {
  const source = await readFile(
    new URL('../src/money/money.js', import.meta.url),
    'utf8',
  )

  assert.match(source, /from 'decimal\.js'/)
  assert.doesNotMatch(source, /\b(?:Number|parseFloat|parseInt)\s*\(/)
  assert.doesNotMatch(source, /\bMath\./)
})

test('validates exact half-shekel increments', () => {
  for (const amount of ['0', '0.50', '10', '10.50', '11', '-0.50']) {
    assert.equal(isValidIlsStep(amount), true, amount)
  }

  for (const amount of ['10.10', '10.25', '', 'NaN', '1,000', null, 10.5]) {
    assert.equal(isValidIlsStep(amount), false, String(amount))
  }
})

test('handles very large valid ILS values without Number conversion', () => {
  const amount = `${'9'.repeat(500)}.50`

  assert.equal(isValidIlsStep(amount), true)
  assert.deepEqual(
    createPaymentMoneySnapshot({ currency: 'ILS', originalAmount: amount }),
    {
      currency: 'ILS',
      originalAmount: amount,
      exchangeRate: null,
      convertedIlsAmount: amount,
    },
  )
})

test('rounds ILS to 0.50 using half-away-from-zero ties', () => {
  assert.equal(roundIlsToHalfShekel('10.24'), '10')
  assert.equal(roundIlsToHalfShekel('10.25'), '10.5')
  assert.equal(roundIlsToHalfShekel('10.75'), '11')
  assert.equal(roundIlsToHalfShekel('-10.25'), '-10.5')
  assert.equal(roundIlsToHalfShekel('-0.01'), '0')
})

test('converts foreign payments with decimal arithmetic and no implicit rounding', () => {
  assert.equal(convertForeignToIls('100', '3.00'), '300')
  assert.equal(convertForeignToIls('0.1', '0.2'), '0.02')
  assert.equal(
    convertForeignToIls('100', '3.12345678901234567890123456789'),
    '312.345678901234567890123456789',
  )

  const veryPreciseRate = `3.${'123456789'.repeat(14)}`
  assert.equal(convertForeignToIls('1', veryPreciseRate), veryPreciseRate)
  assert.equal(
    convertForeignToIls('12345678901234567890.12345', veryPreciseRate),
    convertForeignToIls('12345678901234567890.12345', veryPreciseRate),
  )
})

test('rejects unsafe Number values, negative payments, and invalid rates', () => {
  assert.throws(
    () => convertForeignToIls(0.1, '3'),
    (error) =>
      error instanceof MoneyValidationError &&
      error.code === 'INVALID_DECIMAL_STRING',
  )
  assert.throws(
    () => convertForeignToIls('-1', '3'),
    (error) => error.code === 'NEGATIVE_AMOUNT',
  )
  assert.throws(
    () => convertForeignToIls('1', '0'),
    (error) => error.code === 'INVALID_EXCHANGE_RATE',
  )
  assert.throws(
    () => convertForeignToIls('1', '-0.0001'),
    (error) => error.code === 'INVALID_EXCHANGE_RATE',
  )

  for (const malformed of ['', ' ', '.50', '1.', '01', '+1', '1e3', 'NaN']) {
    assert.throws(
      () => convertForeignToIls(malformed, '3'),
      (error) => error.code === 'INVALID_DECIMAL_STRING',
      malformed,
    )
  }
})

test('builds complete immutable snapshots for foreign payments', () => {
  const payment = createPaymentMoneySnapshot({
    currency: 'USD',
    originalAmount: '100.00',
    exchangeRate: '3.00',
  })

  assert.deepEqual(payment, {
    currency: 'USD',
    originalAmount: '100.00',
    exchangeRate: '3.00',
    convertedIlsAmount: '300',
  })
  assert.equal(Object.isFrozen(payment), true)

  const laterRate = createPaymentMoneySnapshot({
    currency: 'USD',
    originalAmount: '100.00',
    exchangeRate: '3.50',
  })

  assert.equal(payment.convertedIlsAmount, '300')
  assert.equal(payment.exchangeRate, '3.00')
  assert.equal(laterRate.convertedIlsAmount, '350')
  assert.throws(() => {
    payment.exchangeRate = '99'
  }, TypeError)
})

test('supports JOD snapshots while rejecting unsupported currencies', () => {
  assert.deepEqual(
    createPaymentMoneySnapshot({
      currency: 'JOD',
      originalAmount: '5.000',
      exchangeRate: '5.12345678901234567890123456789',
    }),
    {
      currency: 'JOD',
      originalAmount: '5.000',
      exchangeRate: '5.12345678901234567890123456789',
      convertedIlsAmount: '25.61728394506172839450617283945',
    },
  )
})

test('enforces ILS steps and currency-specific exchange-rate rules', () => {
  assert.deepEqual(
    createPaymentMoneySnapshot({ currency: 'ILS', originalAmount: '10.50' }),
    {
      currency: 'ILS',
      originalAmount: '10.50',
      exchangeRate: null,
      convertedIlsAmount: '10.50',
    },
  )
  assert.throws(
    () =>
      createPaymentMoneySnapshot({
        currency: 'ILS',
        originalAmount: '10.25',
      }),
    (error) => error.code === 'INVALID_ILS_STEP',
  )
  assert.throws(
    () =>
      createPaymentMoneySnapshot({ currency: 'JOD', originalAmount: '5' }),
    (error) => error.code === 'MISSING_EXCHANGE_RATE',
  )
  assert.throws(
    () =>
      createPaymentMoneySnapshot({
        currency: 'EUR',
        originalAmount: '5',
        exchangeRate: '4',
      }),
    (error) => error.code === 'UNSUPPORTED_CURRENCY',
  )
})
