import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCustomerPaymentInput } from '../src/customers/customer-payment-input.js'
import { createCustomerPayment } from '../src/customers/create-customer-payment.js'

test('customer payment input accepts mixed receipts and exact foreign snapshots', () => {
  const parsed = parseCustomerPaymentInput({
    notes: 'دفعة حساب',
    payments: [
      { method: 'cash', currency: 'USD', amount: '100', exchangeRate: '3' },
      { method: 'bank_card', amount: '100' },
      { method: 'check', amount: '200', checkNumber: '19', dueDate: '2026-10-01' },
    ],
  })

  assert.equal(parsed.error, undefined)
  assert.equal(parsed.value.payments[0].convertedIlsAmount, '300')
  assert.equal(parsed.value.payments[1].currency, 'ILS')
  assert.equal(parsed.value.payments[2].checkNumber, '19')
  assert.equal(parsed.value.payments[2].notes, 'دفعة حساب')
  assert.equal(parsed.value.notes, 'دفعة حساب')
})

test('customer payment input also preserves a JOD cash snapshot', () => {
  const parsed = parseCustomerPaymentInput({
    payments: [{ method: 'cash', currency: 'JOD', amount: '10', exchangeRate: '5' }],
  })

  assert.equal(parsed.error, undefined)
  assert.equal(parsed.value.payments[0].currency, 'JOD')
  assert.equal(parsed.value.payments[0].originalAmount, '10')
  assert.equal(parsed.value.payments[0].exchangeRate, '5')
  assert.equal(parsed.value.payments[0].convertedIlsAmount, '50')
})

test('customer payment requires at least one real payment row', () => {
  assert.match(parseCustomerPaymentInput({ payments: [] }).error, /طريقة دفع/)
})

function fakeDatabase({ balance = '1000', failOnBank = false } = {}) {
  const state = {
    commands: [], payments: [], checks: [], cash: [], bank: [], ledger: [], released: false,
  }
  const client = {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, ' ').trim()
      state.commands.push(statement)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) {
        return { rowCount: null, rows: [] }
      }
      if (statement.startsWith('SELECT id FROM stores')) {
        return { rowCount: 1, rows: [{ id: '2' }] }
      }
      if (statement.includes('FROM customers') && statement.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: '9', name: 'أحمد' }] }
      }
      if (statement.includes('FROM customer_balances')) {
        return { rowCount: 1, rows: [{ balance_ils: balance }] }
      }
      if (statement.startsWith('INSERT INTO payments')) {
        state.payments.push(params)
        return {
          rowCount: 1,
          rows: [{
            id: String(100 + state.payments.length), method: params[7],
            currency: params[4], original_amount: params[3],
            exchange_rate: params[5], converted_ils_amount: params[6],
            reference: params[8],
          }],
        }
      }
      if (statement.startsWith('INSERT INTO checks')) {
        state.checks.push(params)
        return {
          rowCount: 1,
          rows: [{
            id: '201', method: 'check', currency: 'ILS',
            original_amount: params[5], exchange_rate: null,
            converted_ils_amount: params[5], check_number: params[3],
            bank_name: params[4], due_date: params[6], status: 'pending',
          }],
        }
      }
      if (statement.startsWith('INSERT INTO financial_movements')) {
        state.cash.push(params)
        return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO bank_movements')) {
        state.bank.push(params)
        if (failOnBank) throw new Error('bank write failed')
        return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO customer_ledger')) {
        state.ledger.push(params)
        return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO audit_log')) return { rowCount: 1, rows: [] }
      throw new Error(`Unexpected query: ${statement}`)
    },
    release() { state.released = true },
  }
  return { databasePool: { connect: async () => client }, state }
}

const mixedInput = {
  notes: 'دفعة مختلطة',
  payments: [
    {
      method: 'cash', currency: 'USD', originalAmount: '100',
      exchangeRate: '3', convertedIlsAmount: '300', reference: null,
    },
    {
      method: 'bank_card', currency: 'ILS', originalAmount: '100',
      exchangeRate: null, convertedIlsAmount: '100', reference: 'POS-4',
    },
    {
      method: 'check', currency: 'ILS', originalAmount: '200',
      exchangeRate: null, convertedIlsAmount: '200', checkNumber: '19',
      bankName: null, dueDate: '2026-10-01',
    },
  ],
}

test('customer mixed payment atomically writes cash, bank, check, and ledger credits', async () => {
  const { databasePool, state } = fakeDatabase()
  const result = await createCustomerPayment({
    databasePool, customerId: '9', input: mixedInput, storeId: '2', userId: '5',
  })

  assert.equal(result.total_ils, '600')
  assert.equal(result.balance_before_ils, '1000')
  assert.equal(result.balance_after_ils, '400')
  assert.equal(state.cash.length, 1)
  assert.equal(state.cash[0][1], '100')
  assert.equal(state.cash[0][2], 'USD')
  assert.equal(state.bank.length, 1)
  assert.equal(state.checks.length, 1)
  assert.deepEqual(
    state.ledger.map((params) => [params[2], params[3], params[4]]),
    [
      ['credit', '300', 'payment'],
      ['credit', '100', 'payment'],
      ['credit', '200', 'check'],
    ],
  )
  assert.equal(state.commands.at(-1), 'COMMIT')
  assert.equal(state.released, true)
})

test('customer payment rejects overpayment before writing records', async () => {
  const { databasePool, state } = fakeDatabase({ balance: '500' })
  await assert.rejects(
    createCustomerPayment({
      databasePool, customerId: '9', input: mixedInput, storeId: '2', userId: null,
    }),
    (error) => error?.code === 'CUSTOMER_PAYMENT_EXCEEDS_DEBT',
  )
  assert.equal(state.payments.length, 0)
  assert.equal(state.ledger.length, 0)
  assert.equal(state.commands.at(-1), 'ROLLBACK')
})

test('failure in any financial ledger rolls the entire customer payment back', async () => {
  const { databasePool, state } = fakeDatabase({ failOnBank: true })
  await assert.rejects(
    createCustomerPayment({
      databasePool, customerId: '9', input: mixedInput, storeId: '2', userId: null,
    }),
    /bank write failed/,
  )
  assert.equal(state.commands.at(-1), 'ROLLBACK')
  assert.ok(!state.commands.includes('COMMIT'))
})

test('giro check stores its original owner and still reduces the delivering customer balance', async () => {
  const parsed = parseCustomerPaymentInput({
    payments: [{
      method: 'check', amount: '200', checkNumber: 'G-21', dueDate: '2026-11-01',
      isGiro: true, originalOwnerName: 'يوسف', originalOwnerPhone: '0599000000',
    }],
  })
  const { databasePool, state } = fakeDatabase({ balance: '500' })

  const result = await createCustomerPayment({
    databasePool,
    customerId: '9',
    input: parsed.value,
    storeId: '2',
    userId: '5',
  })

  assert.equal(result.balance_before_ils, '500')
  assert.equal(result.balance_after_ils, '300')
  assert.deepEqual(state.checks[0].slice(11), [true, 'يوسف', '0599000000'])
  assert.deepEqual(state.ledger[0].slice(2, 5), ['credit', '200', 'check'])
})
