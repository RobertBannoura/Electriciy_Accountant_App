import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseMaintenanceInput,
  parseMaintenanceReversalInput,
} from '../src/maintenance/maintenance-input.js'
import {
  createMaintenance,
  reverseMaintenance,
} from '../src/maintenance/maintenance-service.js'

function payment(method, amount, extra = {}) {
  return {
    method,
    currency: 'ILS',
    originalAmount: amount,
    exchangeRate: null,
    convertedIlsAmount: amount,
    reference: null,
    ...extra,
  }
}

test('maintenance input needs only an item snapshot, amount, date, and optional payments', () => {
  const parsed = parseMaintenanceInput({
    itemDescription: 'مضخة مياه خارجية',
    amount: '100.50',
    date: '2026-09-08',
    payments: [{ method: 'cash', currency: 'ILS', amount: '100.50' }],
  })
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.value.itemDescription, 'مضخة مياه خارجية')
  assert.equal(parsed.value.customerId, null)
  assert.equal(parsed.value.amount, '100.50')
  assert.equal('productId' in parsed.value, false)
})

test('maintenance validates half-shekel amounts and explicit reversal reasons', () => {
  assert.match(parseMaintenanceInput({ itemDescription: 'جهاز', amount: '10.25', date: '2026-09-08' }).error, /0\.50/)
  assert.match(parseMaintenanceReversalInput({}).error, /سبب العكس/)
  assert.equal(parseMaintenanceReversalInput({ reason: 'إدخال مكرر' }).value.reason, 'إدخال مكرر')
})

function creationDatabase({ failOnAudit = false } = {}) {
  const state = { commands: [], maintenance: [], payments: [], checks: [], cash: [], bank: [], ledger: [], audit: [], released: false }
  const client = {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, ' ').trim()
      state.commands.push(statement)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rowCount: null, rows: [] }
      if (statement.startsWith('SELECT id FROM stores')) return { rowCount: 1, rows: [{ id: '2' }] }
      if (statement.includes('FROM customers') && statement.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ id: '9', name: 'أحمد' }] }
      if (statement.startsWith('INSERT INTO maintenance_records')) {
        state.maintenance.push(params)
        return { rowCount: 1, rows: [{ id: '31', store_id: '2', customer_id: params[1], item_description: params[2], maintenance_details: params[3], amount_ils: params[4], business_date: params[5], paid_total_ils: params[6], remaining_due_ils: params[7], notes: params[8] }] }
      }
      if (statement.startsWith('INSERT INTO payments')) {
        state.payments.push(params)
        return { rowCount: 1, rows: [{ id: `4${state.payments.length}`, method: params[7], currency: params[4], original_amount: params[3], exchange_rate: params[5], converted_ils_amount: params[6], reference: params[8] }] }
      }
      if (statement.startsWith('INSERT INTO checks')) {
        state.checks.push(params)
        return { rowCount: 1, rows: [{ id: '51', method: 'check', currency: 'ILS', original_amount: params[5], converted_ils_amount: params[5] }] }
      }
      if (statement.startsWith('INSERT INTO financial_movements')) { state.cash.push(params); return { rowCount: 1, rows: [] } }
      if (statement.startsWith('INSERT INTO bank_movements')) { state.bank.push(params); return { rowCount: 1, rows: [] } }
      if (statement.startsWith('INSERT INTO customer_ledger')) { state.ledger.push(params); return { rowCount: 1, rows: [] } }
      if (statement.startsWith('INSERT INTO audit_log')) {
        state.audit.push(params)
        if (failOnAudit) throw new Error('audit failed')
        return { rowCount: 1, rows: [] }
      }
      throw new Error(`Unexpected query: ${statement}`)
    },
    release() { state.released = true },
  }
  return { databasePool: { connect: async () => client }, state }
}

const mixedMaintenance = {
  customerId: '9', itemDescription: 'مولد كهرباء', maintenanceDetails: null,
  amount: '1000', businessDate: '2026-09-08', notes: null,
  payments: [
    payment('cash', '300'),
    payment('cash', '100', { currency: 'USD', exchangeRate: '3', convertedIlsAmount: '300' }),
    payment('bank_card', '100', { reference: 'POS-1' }),
    payment('check', '100', { checkNumber: '77', bankName: null, dueDate: '2026-10-01' }),
  ],
}

test('maintenance creation atomically records mixed settlement and exact debt without inventory', async () => {
  const { databasePool, state } = creationDatabase()
  const result = await createMaintenance({ databasePool, input: mixedMaintenance, storeId: '2', userId: '5' })
  assert.equal(result.paid_total_ils, '800')
  assert.equal(result.remaining_due_ils, '200')
  assert.equal(state.cash.length, 2)
  assert.equal(state.cash[1][2], 'USD')
  assert.equal(state.bank.length, 1)
  assert.equal(state.checks.length, 1)
  assert.deepEqual(state.ledger.map((row) => [row[2], row[3]]), [
    ['debit', '1000'], ['credit', '300'], ['credit', '300'],
    ['credit', '100'], ['credit', '100'],
  ])
  assert.equal(state.commands.some((command) => command.includes('inventory_')), false)
  assert.equal(state.audit.length, 5)
  assert.deepEqual(state.audit.map((row) => row[2]), [
    'maintenance', 'payment', 'payment', 'payment', 'payment',
  ])
  assert.equal(state.commands.at(-1), 'COMMIT')
})

test('anonymous maintenance is rejected unless fully paid', async () => {
  const { databasePool, state } = creationDatabase()
  await assert.rejects(
    createMaintenance({
      databasePool,
      input: { ...mixedMaintenance, customerId: null, payments: [payment('cash', '300')] },
      storeId: '2', userId: null,
    }),
    (error) => error?.code === 'INVALID_MAINTENANCE_PAYMENTS',
  )
  assert.equal(state.maintenance.length, 0)
  assert.equal(state.commands.at(-1), 'ROLLBACK')
})

test('failure in the audit entry rolls all maintenance effects back', async () => {
  const { databasePool, state } = creationDatabase({ failOnAudit: true })
  await assert.rejects(
    createMaintenance({ databasePool, input: mixedMaintenance, storeId: '2', userId: null }),
    /audit failed/,
  )
  assert.equal(state.commands.at(-1), 'ROLLBACK')
  assert.equal(state.commands.includes('COMMIT'), false)
  assert.equal(state.released, true)
})

function reversalDatabase() {
  const state = { commands: [], ledger: [], outgoingPayments: [], cash: [], bank: [], checks: [], audit: [] }
  const client = {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, ' ').trim()
      state.commands.push(statement)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rowCount: null, rows: [] }
      if (statement.startsWith('SELECT id FROM stores')) return { rowCount: 1, rows: [{ id: '2' }] }
      if (statement.includes('FROM maintenance_records') && statement.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ id: '31', customer_id: '9', item_description: 'مولد', amount_ils: '1000', paid_total_ils: '700', remaining_due_ils: '300' }] }
      if (statement.includes('FROM customers') && statement.includes('FOR UPDATE')) return { rowCount: 1, rows: [{ id: '9', name: 'أحمد' }] }
      if (statement.startsWith('INSERT INTO maintenance_reversals')) return { rowCount: 1, rows: [{ id: '61', maintenance_id: '31', store_id: '2', reason: params[2] }] }
      if (statement.startsWith('SELECT id::TEXT AS id, customer_id') && statement.includes('FROM payments')) return { rowCount: 2, rows: [
        { id: '41', customer_id: '9', original_amount: '100', currency_code: 'USD', exchange_rate: '3', converted_ils_amount: '300', payment_method: 'cash', reference: null },
        { id: '42', customer_id: '9', original_amount: '200', currency_code: 'ILS', exchange_rate: null, converted_ils_amount: '200', payment_method: 'bank_card', reference: 'P' },
      ] }
      if (statement.startsWith('SELECT id::TEXT AS id, customer_id') && statement.includes('FROM checks')) return { rowCount: 1, rows: [{ id: '51', customer_id: '9', check_number: '77', bank_name: null, amount: '200', due_date: '2026-10-01' }] }
      if (statement.startsWith('INSERT INTO payments')) { state.outgoingPayments.push(params); return { rowCount: 1, rows: [{ id: `7${state.outgoingPayments.length}` }] } }
      if (statement.startsWith('INSERT INTO financial_movements')) { state.cash.push(params); return { rowCount: 1, rows: [] } }
      if (statement.startsWith('INSERT INTO bank_movements')) { state.bank.push(params); return { rowCount: 1, rows: [] } }
      if (statement.startsWith('INSERT INTO checks')) { state.checks.push(params); return { rowCount: 1, rows: [{ id: '81' }] } }
      if (statement.startsWith('INSERT INTO customer_ledger')) { state.ledger.push(params); return { rowCount: 1, rows: [] } }
      if (statement.startsWith('INSERT INTO audit_log')) { state.audit.push(params); return { rowCount: 1, rows: [] } }
      throw new Error(`Unexpected query: ${statement}`)
    },
    release() {},
  }
  return { databasePool: { connect: async () => client }, state }
}

test('explicit reversal preserves the original and reverses customer, cash, bank, and check effects', async () => {
  const { databasePool, state } = reversalDatabase()
  const reversal = await reverseMaintenance({ databasePool, maintenanceId: '31', reason: 'إدخال مكرر', storeId: '2', userId: '5' })
  assert.equal(reversal.id, '61')
  assert.equal(state.outgoingPayments.length, 2)
  assert.equal(state.cash.length, 1)
  assert.equal(state.cash[0][1], '100')
  assert.equal(state.cash[0][2], 'USD')
  assert.equal(state.bank.length, 1)
  assert.equal(state.checks.length, 1)
  assert.deepEqual(state.ledger.map((row) => [row[2], row[3]]), [
    ['credit', '1000'], ['debit', '300'], ['debit', '200'], ['debit', '200'],
  ])
  assert.equal(state.commands.some((command) => command.startsWith('UPDATE maintenance_records')), false)
  assert.equal(state.audit.length, 1)
  assert.equal(state.commands.at(-1), 'COMMIT')
})
