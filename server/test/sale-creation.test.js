import assert from 'node:assert/strict'
import test from 'node:test'
import Decimal from 'decimal.js'
import { createSale } from '../src/sales/create-sale.js'

function fakeDatabase({
  balanceQuantity = '20',
  failOnSecondItem = false,
  failOnBankMovement = false,
} = {}) {
  const state = {
    commands: [], itemInserts: [], movementInserts: [], paymentInserts: [],
    cashMovements: [], bankMovements: [], checkInserts: [], ledgerInserts: [],
    costMovements: [],
    released: false,
  }
  const client = {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, ' ').trim()
      state.commands.push(statement)

      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rowCount: null, rows: [] }
      }
      if (statement.startsWith('SELECT id FROM stores')) {
        return { rowCount: 1, rows: [{ id: '2' }] }
      }
      if (statement.startsWith('SELECT id FROM customers')) {
        return { rowCount: 1, rows: [{ id: '9' }] }
      }
      if (statement.includes('FROM store_inventory AS inventory')) {
        return {
          rowCount: 1,
          rows: [{ id: '7', name: 'سلك نحاس', sale_unit: 'متر', original_price: '12.50' }],
        }
      }
      if (statement.includes('FROM store_inventory_balances')) {
        return { rowCount: 1, rows: [{ product_id: '7', quantity: balanceQuantity }] }
      }
      if (statement.includes('FROM store_inventory_cost_balances')) {
        return { rowCount: 1, rows: [{ quantity: balanceQuantity, inventory_value: new Decimal(balanceQuantity).mul('5').toFixed(), weighted_average_cost: '5' }] }
      }
      if (statement.startsWith('INSERT INTO sales')) {
        state.saleInsert = params
        return {
          rowCount: 1,
          rows: [{
            id: '41', store_id: '2', customer_id: null, customer_project_id: null,
            invoice_number: 'S-41', business_date: '2026-09-08', status: 'recorded',
            currency_code: 'ILS', items_subtotal: params[5], invoice_discount: params[6],
            total: params[7], paid_total: params[8], remaining_due: params[9],
            cost_total: params[10], gross_profit: params[11],
            created_at: '2026-09-08T10:00:00.000Z',
          }],
        }
      }
      if (statement.startsWith('INSERT INTO sale_items')) {
        state.itemInserts.push(params)
        if (failOnSecondItem && state.itemInserts.length === 2) {
          throw new Error('simulated item failure')
        }
        return {
          rowCount: 1,
          rows: [{
            id: String(100 + state.itemInserts.length), product_id: params[1],
            description: params[2], quantity: params[3], original_price: params[4],
            actual_price: params[5], discount: params[6], total: params[7],
          }],
        }
      }
      if (statement.startsWith('INSERT INTO inventory_movements')) {
        state.movementInserts.push(params)
        return { rowCount: 1, rows: [{ id: '501', occurred_at: '2026-09-08T10:00:00.000Z' }] }
      }
      if (statement.startsWith('INSERT INTO inventory_cost_movements')) {
        state.costMovements.push(params)
        return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO payments')) {
        state.paymentInserts.push(params)
        return {
          rowCount: 1,
          rows: [{
            id: '301', method: params[7], currency: params[4],
            original_amount: params[3], exchange_rate: params[5],
            converted_ils_amount: params[6], reference: params[8],
          }],
        }
      }
      if (statement.startsWith('INSERT INTO financial_movements')) {
        state.cashMovements.push(params)
        return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO bank_movements')) {
        state.bankMovements.push(params)
        if (failOnBankMovement) throw new Error('simulated bank ledger failure')
        return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO checks')) {
        state.checkInserts.push(params)
        return {
          rowCount: 1,
          rows: [{
            id: '401', method: 'check', currency: 'ILS',
            original_amount: params[5], exchange_rate: null,
            converted_ils_amount: params[5], check_number: params[3],
            bank_name: params[4], due_date: params[6], status: 'pending',
          }],
        }
      }
      if (statement.startsWith('INSERT INTO customer_ledger')) {
        state.ledgerInserts.push(params)
        return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO audit_log')) return { rowCount: 1, rows: [] }
      throw new Error(`Unexpected query: ${statement}`)
    },
    release() {
      state.released = true
    },
  }
  return { databasePool: { connect: async () => client }, state }
}

const input = {
  invoiceNumber: 'S-41',
  businessDate: '2026-09-08',
  customerId: null,
  customerProjectId: null,
  invoiceDiscount: '1',
  items: [
    { productId: '7', quantity: '1', actualPrice: '10.50', discount: '0.50' },
    { productId: '7', quantity: '2.5', actualPrice: '10.50', discount: '0' },
  ],
  payments: [{
    method: 'cash', currency: 'USD', originalAmount: '11.75',
    exchangeRate: '3', convertedIlsAmount: '35.25', reference: null,
  }],
}

test('sale creation stores server totals and database original prices then deducts once per product', async () => {
  const { databasePool, state } = fakeDatabase()
  const sale = await createSale({ databasePool, input, storeId: '2', userId: '5' })

  assert.deepEqual(state.saleInsert.slice(0, 5), ['2', null, null, 'S-41', '2026-09-08'])
  assert.deepEqual(state.saleInsert.slice(5), ['36.25', '1', '35.25', '35.25', '0', '17.5', '17.75', '5'])
  assert.equal(state.itemInserts.length, 2)
  assert.equal(state.itemInserts[0][4], '12.50')
  assert.equal(state.itemInserts[0][7], '10')
  assert.equal(state.itemInserts[1][7], '26.25')
  assert.equal(state.movementInserts.length, 1)
  assert.deepEqual(state.movementInserts[0].slice(0, 4), ['2', '7', '-3.5', '41'])
  assert.deepEqual(state.costMovements[0].slice(0, 6), ['2', '7', '501', '-3.5', '5', '-17.5'])
  assert.equal(state.paymentInserts.length, 1)
  assert.deepEqual(state.cashMovements[0].slice(0, 3), ['2', '11.75', 'USD'])
  assert.equal(sale.total, '35.25')
  assert.equal(sale.remaining_due, '0')
  assert.equal(sale.items.length, 2)
  assert.equal(state.commands.at(-1), 'COMMIT')
  assert.equal(state.released, true)
})

test('sale creation accepts a database-generated invoice number and uses it in related records', async () => {
  const { databasePool, state } = fakeDatabase()

  await createSale({
    databasePool,
    input: { ...input, invoiceNumber: null },
    storeId: '2',
    userId: '5',
  })

  assert.equal(state.saleInsert[3], null)
  assert.equal(state.movementInserts[0][4], 'فاتورة بيع S-41')
})

test('failure after the sale insert rolls the whole transaction back', async () => {
  const { databasePool, state } = fakeDatabase({ failOnSecondItem: true })

  await assert.rejects(
    createSale({ databasePool, input, storeId: '2', userId: null }),
    /simulated item failure/,
  )
  assert.ok(state.commands.includes('ROLLBACK'))
  assert.ok(!state.commands.includes('COMMIT'))
  assert.equal(state.movementInserts.length, 0)
  assert.equal(state.released, true)
})

test('manual sale lines save as invoice-only revenue without inventory movements', async () => {
  const { databasePool, state } = fakeDatabase()
  const manualInput = {
    invoiceNumber: 'MANUAL-41',
    businessDate: '2026-09-11',
    customerId: null,
    customerProjectId: null,
    invoiceDiscount: '0',
    items: [{
      productId: null, description: 'أجرة تركيب', quantity: '2',
      actualPrice: '25', discount: '0',
    }],
    payments: [{
      method: 'cash', currency: 'ILS', originalAmount: '50',
      exchangeRate: null, convertedIlsAmount: '50', reference: null,
    }],
  }

  const sale = await createSale({ databasePool, input: manualInput, storeId: '2', userId: '5' })

  assert.equal(sale.total, '50')
  assert.equal(state.itemInserts.length, 1)
  assert.equal(state.itemInserts[0][1], null)
  assert.equal(state.itemInserts[0][2], 'أجرة تركيب')
  assert.deepEqual(state.itemInserts[0].slice(8, 11), ['0', '0', '50'])
  assert.equal(state.movementInserts.length, 0)
  assert.equal(state.costMovements.length, 0)
})

test('insufficient inventory rolls back before creating any sale records', async () => {
  const { databasePool, state } = fakeDatabase({ balanceQuantity: '3' })

  await assert.rejects(
    createSale({ databasePool, input, storeId: '2', userId: '5' }),
    (error) => error?.code === 'INSUFFICIENT_INVENTORY' && error?.statusCode === 409,
  )
  assert.ok(state.commands.includes('ROLLBACK'))
  assert.ok(!state.commands.some((statement) => statement.startsWith('INSERT INTO sales')))
  assert.equal(state.itemInserts.length, 0)
  assert.equal(state.movementInserts.length, 0)
})

test('mixed payments use separate cash, bank, check, and customer-ledger entries', async () => {
  const { databasePool, state } = fakeDatabase()
  const mixedInput = {
    ...input,
    customerId: '9',
    payments: [
      {
        method: 'cash', currency: 'ILS', originalAmount: '10',
        exchangeRate: null, convertedIlsAmount: '10', reference: null,
      },
      {
        method: 'bank_card', currency: 'ILS', originalAmount: '10.50',
        exchangeRate: null, convertedIlsAmount: '10.50', reference: 'POS-1',
      },
      {
        method: 'check', currency: 'ILS', originalAmount: '10',
        exchangeRate: null, convertedIlsAmount: '10', checkNumber: '77',
        bankName: 'البنك', dueDate: '2026-09-30',
      },
    ],
  }

  const sale = await createSale({ databasePool, input: mixedInput, storeId: '2', userId: '5' })

  assert.equal(sale.paid_total, '30.5')
  assert.equal(sale.remaining_due, '4.75')
  assert.equal(state.cashMovements.length, 1)
  assert.equal(state.bankMovements.length, 1)
  assert.equal(state.checkInserts.length, 1)
  assert.deepEqual(
    state.ledgerInserts.map((params) => [params[2], params[3], params[4]]),
    [
      ['debit', '35.25', 'sale'],
      ['credit', '10', 'sale_payment'],
      ['credit', '10.50', 'sale_payment'],
      ['credit', '10', 'sale_check'],
    ],
  )
})

test('a bank-ledger failure rolls back the sale, inventory, and all payment effects', async () => {
  const { databasePool, state } = fakeDatabase({ failOnBankMovement: true })
  const mixedInput = {
    ...input,
    customerId: '9',
    payments: [{
      method: 'bank_card', currency: 'ILS', originalAmount: '10',
      exchangeRate: null, convertedIlsAmount: '10', reference: null,
    }],
  }

  await assert.rejects(
    createSale({ databasePool, input: mixedInput, storeId: '2', userId: '5' }),
    /simulated bank ledger failure/,
  )
  assert.equal(state.commands.at(-1), 'ROLLBACK')
  assert.ok(!state.commands.includes('COMMIT'))
})
