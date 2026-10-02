import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createExpense } from '../src/expenses/create-expense.js'
import { DEFAULT_EXPENSE_CATEGORIES, parseExpenseInput } from '../src/expenses/expense-input.js'
import { createCustomerReturn } from '../src/returns/create-customer-return.js'
import { createSupplierReturn } from '../src/returns/create-supplier-return.js'
import { parseReturnInput } from '../src/returns/return-input.js'

test('return input requires one original document and unique positive item quantities', () => {
  assert.deepEqual(parseReturnInput({
    saleId: '12', items: [{ saleItemId: '31', quantity: '2.500' }],
  }), { value: { sourceDocumentId: '12', items: [{ sourceItemId: '31', quantity: '2.500' }] } })
  assert.ok(parseReturnInput({ saleId: '12', items: [
    { saleItemId: '31', quantity: '1' }, { saleItemId: '31', quantity: '1' },
  ] }).error)
  assert.ok(parseReturnInput({ saleId: '12', items: [{ saleItemId: '31', quantity: '0' }] }).error)
})

test('expense input keeps the default choices and accepts a bounded custom category', () => {
  assert.deepEqual(DEFAULT_EXPENSE_CATEGORIES, [
    'كهرباء', 'أجار', 'رواتب', 'مواصلات', 'صيانة', 'مشتريات للمحل', 'أخرى',
  ])
  assert.deepEqual(parseExpenseInput({
    amount: '125.50', category: 'صيانة', date: '2026-09-09',
    paymentMethod: 'bank', notes: 'فاتورة صيانة',
  }), { value: {
    amount: '125.50', category: 'صيانة', expenseDate: '2026-09-09',
    paymentMethod: 'bank_card', notes: 'فاتورة صيانة',
  } })
  assert.equal(parseExpenseInput({ amount: '1', category: '  رسوم بلدية  ', date: '2026-09-09', paymentMethod: 'cash' }).value.category, 'رسوم بلدية')
  for (const category of ['', '   ', 'أ'.repeat(101), 123]) {
    assert.ok(parseExpenseInput({ amount: '1', category, date: '2026-09-09', paymentMethod: 'cash' }).error)
  }
})

test('expense schema permits named categories while bounding recorded values', async () => {
  const migration = await readFile(new URL('../db/migrations/0029_custom_expense_categories.sql', import.meta.url), 'utf8')
  assert.match(migration, /DROP CONSTRAINT expenses_recorded_values/)
  assert.match(migration, /CHAR_LENGTH\(expense_category\) BETWEEN 1 AND 100/)
  assert.match(migration, /expense_category = BTRIM\(expense_category\)/)
})

function expensePool({ failMovement = false } = {}) {
  const commands = []
  const client = {
    async query(sql) {
      const statement = sql.trim().replace(/\s+/g, ' ')
      commands.push(statement)
      if (statement.startsWith('SELECT id FROM stores')) return { rowCount: 1, rows: [{ id: '1' }] }
      if (statement.startsWith('INSERT INTO expenses')) return { rowCount: 1, rows: [{ id: '7', store_id: '1', category: 'كهرباء', amount: '50', date: '2026-09-09', payment_method: 'cash' }] }
      if (failMovement && (statement.startsWith('INSERT INTO financial_movements') || statement.startsWith('INSERT INTO bank_movements'))) throw new Error('ledger failed')
      return { rowCount: 1, rows: [] }
    },
    release() {},
  }
  return { commands, pool: { async connect() { return client } } }
}

test('expense and the correct cash movement commit atomically', async () => {
  const fake = expensePool()
  await createExpense({
    databasePool: fake.pool, storeId: '1', userId: '2',
    input: { amount: '50', category: 'كهرباء', expenseDate: '2026-09-09', paymentMethod: 'cash', notes: null },
  })
  assert.ok(fake.commands.some((sql) => sql.startsWith('INSERT INTO expenses')))
  assert.ok(fake.commands.some((sql) => sql.startsWith('INSERT INTO financial_movements')))
  assert.ok(!fake.commands.some((sql) => sql.startsWith('INSERT INTO bank_movements')))
  assert.equal(fake.commands.at(-1), 'COMMIT')
})

test('bank expense reduces only the bank ledger', async () => {
  const fake = expensePool()
  await createExpense({
    databasePool: fake.pool, storeId: '1', userId: '2',
    input: { amount: '75', category: 'أجار', expenseDate: '2026-09-09', paymentMethod: 'bank_card', notes: null },
  })
  assert.ok(fake.commands.some((sql) => sql.startsWith('INSERT INTO bank_movements')))
  assert.ok(!fake.commands.some((sql) => sql.startsWith('INSERT INTO financial_movements')))
  assert.equal(fake.commands.at(-1), 'COMMIT')
})

test('a failed expense balance movement rolls the expense back', async () => {
  const fake = expensePool({ failMovement: true })
  await assert.rejects(createExpense({
    databasePool: fake.pool, storeId: '1', userId: '2',
    input: { amount: '50', category: 'رواتب', expenseDate: '2026-09-09', paymentMethod: 'bank_card', notes: null },
  }), /ledger failed/)
  assert.equal(fake.commands.at(-1), 'ROLLBACK')
  assert.ok(!fake.commands.includes('COMMIT'))
})

function returnPool(kind, previousQuantity = '0', manual = false, tracksInventory = !manual) {
  const commands = []
  const calls = []
  const client = {
    async query(sql, params = []) {
      const statement = sql.trim().replace(/\s+/g, ' ')
      commands.push(statement)
      calls.push({ statement, params })
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [], rowCount: null }
      if (kind === 'customer' && statement.includes('FROM sales') && statement.endsWith('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: '10', customer_id: '3', items_subtotal: '100', total: '90', document_number: 'S-10' }] }
      }
      if (kind === 'supplier' && statement.includes('FROM purchases') && statement.endsWith('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: '20', supplier_id: '4', document_number: 'P-20' }] }
      }
      if (statement.includes('FROM sale_items AS item')) {
        return { rowCount: 1, rows: [{ id: '11', product_id: manual ? null : '5', tracks_inventory: tracksInventory, description: 'سلك', quantity: '2', line_total: '100', unit_cost_snapshot: tracksInventory ? '10' : '0', unit_name: manual ? null : 'قطعة' }] }
      }
      if (statement.includes('FROM purchase_items AS item')) {
        return { rowCount: 1, rows: [{ id: '21', product_id: manual ? null : '5', tracks_inventory: tracksInventory, description: 'سلك', quantity: '5', unit_cost: '20', unit_name: manual ? null : 'قطعة' }] }
      }
      if (statement.includes('FROM customer_return_items') || statement.includes('FROM supplier_return_items')) {
        return previousQuantity === '0'
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ source_item_id: kind === 'customer' ? '11' : '21', returned_quantity: previousQuantity, returned_total: kind === 'customer' ? '90' : undefined }] }
      }
      if (statement.includes('FROM store_inventory_balances')) return { rowCount: 1, rows: [{ product_id: '5', quantity: '10' }] }
      if (statement.includes('FROM store_inventory_cost_balances')) return { rowCount: 1, rows: [{ quantity: '10', inventory_value: '100', weighted_average_cost: '10' }] }
      if (statement.startsWith('INSERT INTO customer_returns')) return { rowCount: 1, rows: [{ id: '30', document_number: 'CR-1', business_date: '2026-09-09', total: '45', cost_total: '10', gross_profit_reversal: '35' }] }
      if (statement.startsWith('INSERT INTO supplier_returns')) return { rowCount: 1, rows: [{ id: '40', document_number: 'PR-1', business_date: '2026-09-09', total: '40', inventory_cost_total: '40', cost_variance: '0' }] }
      if (statement.startsWith('INSERT INTO inventory_movements')) return { rowCount: 1, rows: [{ id: '50', occurred_at: '2026-09-09' }] }
      assert.ok(params.length > 0, `Unexpected parameterless query: ${statement}`)
      return { rowCount: 1, rows: [] }
    },
    release() {},
  }
  return { commands, calls, pool: { async connect() { return client } } }
}

test('customer return atomically restores original cost and credits the customer', async () => {
  const fake = returnPool('customer')
  const saved = await createCustomerReturn({
    databasePool: fake.pool, storeId: '1', userId: '2',
    input: { sourceDocumentId: '10', items: [{ sourceItemId: '11', quantity: '1' }] },
  })
  assert.equal(saved.total, '45')
  assert.ok(fake.commands.some((sql) => sql.startsWith('INSERT INTO customer_return_items')))
  assert.ok(fake.commands.some((sql) => sql.includes("'customer_return'")))
  assert.ok(fake.commands.some((sql) => sql.startsWith('INSERT INTO customer_ledger')))
  assert.ok(fake.commands.indexOf('SELECT id FROM customers WHERE id = $1::BIGINT FOR UPDATE')
    < fake.commands.findIndex((sql) => sql.startsWith('INSERT INTO customer_ledger')))
  assert.ok(fake.commands.findIndex((sql) => sql.startsWith('SELECT id FROM products'))
    < fake.commands.findIndex((sql) => sql.includes('FROM sale_items AS item')))
  assert.equal(fake.commands.at(-1), 'COMMIT')
})

test('supplier return atomically reverses historical purchase cost and debits the supplier', async () => {
  const fake = returnPool('supplier')
  const saved = await createSupplierReturn({
    databasePool: fake.pool, storeId: '1', userId: '2',
    input: { sourceDocumentId: '20', items: [{ sourceItemId: '21', quantity: '2' }] },
  })
  assert.equal(saved.total, '40')
  assert.equal(saved.inventory_cost_total, '40')
  assert.equal(saved.cost_variance, '0')
  assert.ok(fake.commands.some((sql) => sql.startsWith('INSERT INTO supplier_return_items')))
  assert.ok(fake.commands.some((sql) => sql.startsWith('INSERT INTO supplier_ledger')))
  assert.ok(fake.commands.indexOf('SELECT id FROM suppliers WHERE id = $1::BIGINT FOR UPDATE')
    < fake.commands.findIndex((sql) => sql.startsWith('INSERT INTO supplier_ledger')))
  assert.ok(fake.commands.findIndex((sql) => sql.startsWith('SELECT id FROM products'))
    < fake.commands.findIndex((sql) => sql.includes('FROM purchase_items AS item')))
  assert.equal(fake.commands.at(-1), 'COMMIT')
})

test('full manual single-line sale and purchase returns reverse balances without stock movements', async () => {
  for (const [kind, create, sourceDocumentId, sourceItemId, quantity, expectedCredit] of [
    ['customer', createCustomerReturn, '10', '11', '2', '90'],
    ['supplier', createSupplierReturn, '20', '21', '5', '100'],
  ]) {
    const fake = returnPool(kind, '0', true)
    await create({
      databasePool: fake.pool, storeId: '1', userId: '2',
      input: { sourceDocumentId, items: [{ sourceItemId, quantity }] },
    })
    const itemInsert = fake.calls.find(({ statement }) => statement.startsWith(`INSERT INTO ${kind === 'customer' ? 'customer' : 'supplier'}_return_items`))
    assert.equal(itemInsert.params[2], null)
    assert.equal(itemInsert.params[5], kind === 'customer' ? '45' : '20')
    assert.equal(itemInsert.params[6], expectedCredit)
    assert.equal(itemInsert.params.at(-1), '0')
    assert.equal(fake.commands.some((statement) => statement.startsWith('INSERT INTO inventory_movements')), false)
    assert.equal(fake.commands.some((statement) => statement.startsWith('INSERT INTO inventory_cost_movements')), false)
    assert.equal(fake.commands.some((statement) => statement.startsWith(`INSERT INTO ${kind === 'customer' ? 'customer' : 'supplier'}_ledger`)), true)
    assert.equal(fake.commands.at(-1), 'COMMIT')
  }
})

test('non-showroom catalog returns reverse the account without changing stock', async () => {
  for (const [kind, create, sourceDocumentId, sourceItemId, quantity] of [
    ['customer', createCustomerReturn, '10', '11', '2'],
    ['supplier', createSupplierReturn, '20', '21', '5'],
  ]) {
    const fake = returnPool(kind, '0', false, false)
    await create({
      databasePool: fake.pool, storeId: '1', userId: '2',
      input: { sourceDocumentId, items: [{ sourceItemId, quantity }] },
    })
    const itemInsert = fake.calls.find(({ statement }) => statement.startsWith(`INSERT INTO ${kind === 'customer' ? 'customer' : 'supplier'}_return_items`))
    assert.equal(itemInsert.params[2], '5')
    assert.equal(itemInsert.params.at(-1), '0')
    assert.equal(fake.commands.some((statement) => statement.startsWith('INSERT INTO inventory_movements')), false)
    assert.equal(fake.commands.some((statement) => statement.startsWith(`INSERT INTO ${kind === 'customer' ? 'customer' : 'supplier'}_ledger`)), true)
  }
})

test('cumulative returns cannot exceed the quantity on the original line', async () => {
  const fake = returnPool('customer', '2')
  await assert.rejects(createCustomerReturn({
    databasePool: fake.pool, storeId: '1', userId: '2',
    input: { sourceDocumentId: '10', items: [{ sourceItemId: '11', quantity: '1' }] },
  }), (error) => error?.code === 'RETURN_QUANTITY_EXCEEDED')
  assert.ok(!fake.commands.some((sql) => sql.startsWith('INSERT INTO customer_returns')))
  assert.equal(fake.commands.at(-1), 'ROLLBACK')
})

test('returns reject a bill belonging to another party before writing movements', async () => {
  for (const [kind, create] of [['customer', createCustomerReturn], ['supplier', createSupplierReturn]]) {
    const fake = returnPool(kind)
    await assert.rejects(create({
      databasePool: fake.pool, storeId: '1', userId: '2',
      input: { partyId: '99', sourceDocumentId: '10', items: [{ sourceItemId: '11', quantity: '1' }] },
    }), (error) => error?.code === 'RETURN_PARTY_MISMATCH')
    assert.ok(!fake.commands.some((sql) => sql.startsWith('INSERT INTO')))
    assert.equal(fake.commands.at(-1), 'ROLLBACK')
  }
})

test('returns accept the selected owner and validate party identifiers', async () => {
  for (const [kind, create, partyId, sourceDocumentId, sourceItemId] of [
    ['customer', createCustomerReturn, '3', '10', '11'],
    ['supplier', createSupplierReturn, '4', '20', '21'],
  ]) {
    const parsed = parseReturnInput({ partyId, sourceDocumentId, items: [{ sourceItemId, quantity: '1' }] })
    assert.equal(parsed.value.partyId, partyId)
    const fake = returnPool(kind)
    await create({ databasePool: fake.pool, storeId: '1', userId: '2', input: parsed.value })
    assert.equal(fake.commands.at(-1), 'COMMIT')
  }
  assert.ok(parseReturnInput({ partyId: 'invalid', sourceDocumentId: '10', items: [{ sourceItemId: '11', quantity: '1' }] }).error)
})

test('return schema is append-only, linked, and prevents cumulative over-return', async () => {
  const migration = await readFile(new URL('../db/migrations/0021_returns_and_expenses.sql', import.meta.url), 'utf8')
  assert.match(migration, /CREATE TABLE customer_returns/)
  assert.match(migration, /CREATE TABLE supplier_returns/)
  assert.match(migration, /FOREIGN KEY \(sale_id, store_id\) REFERENCES sales/)
  assert.match(migration, /FOREIGN KEY \(purchase_id, store_id\) REFERENCES purchases/)
  assert.match(migration, /returned_quantity \+ NEW\.quantity > source_quantity/)
  assert.match(migration, /customer_returns_append_only/)
  assert.match(migration, /supplier_returns_append_only/)
  assert.match(migration, /CREATE VIEW store_cash_balances/)
  assert.match(migration, /CREATE VIEW store_bank_balances/)
})

test('return services only append documents, ledger entries, and inventory movements', async () => {
  const customer = await readFile(new URL('../src/returns/create-customer-return.js', import.meta.url), 'utf8')
  const supplier = await readFile(new URL('../src/returns/create-supplier-return.js', import.meta.url), 'utf8')
  assert.doesNotMatch(customer, /UPDATE\s+sales|DELETE\s+FROM\s+sales/i)
  assert.doesNotMatch(supplier, /UPDATE\s+purchases|DELETE\s+FROM\s+purchases/i)
  assert.match(customer, /INSERT INTO customer_returns/)
  assert.match(customer, /insertCustomerLedgerMovement/)
  assert.match(customer, /'customer_return'/)
  assert.match(supplier, /INSERT INTO supplier_returns/)
  assert.match(supplier, /INSERT INTO supplier_ledger/)
  assert.match(supplier, /'supplier_return'/)
})

test('Arabic UI exposes both explicit return flows and real expenses without miscellaneous income', async () => {
  const returnsPage = await readFile(new URL('../../client/src/pages/ReturnsPage.tsx', import.meta.url), 'utf8')
  const expensesPage = await readFile(new URL('../../client/src/pages/ExpensesPage.tsx', import.meta.url), 'utf8')
  const app = await readFile(new URL('../../client/src/App.tsx', import.meta.url), 'utf8')
  assert.match(returnsPage, /مرتجع مبيعات/)
  assert.match(returnsPage, /مرتجع مشتريات/)
  assert.match(app, /sales-returns/)
  assert.match(app, /purchase-returns/)
  assert.match(expensesPage, /المصاريف/)
  assert.doesNotMatch(expensesPage, /دخل متنوع/)
})
