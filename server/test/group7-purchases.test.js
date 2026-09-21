import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createPurchase } from '../src/purchases/create-purchase.js'
import { parsePurchaseInput } from '../src/purchases/purchase-input.js'
import { parseSupplierPaymentInput } from '../src/suppliers/supplier-payment-input.js'
import { createSupplierPayment } from '../src/suppliers/create-supplier-payment.js'

const purchaseInput = {
  supplierId: '8',
  documentNumber: 'P-77',
  businessDate: '2026-09-09',
  notes: null,
  items: [{ productId: '7', quantity: '2', purchasePrice: '50' }],
  payments: [
    { method: 'cash', amount: '20' },
    { method: 'bank', amount: '10', reference: 'WIRE-1' },
    { method: 'owner_check', amount: '15', checkNumber: 'OWN-1', dueDate: '2026-10-01' },
    { method: 'transferred_customer_check', checkId: '31' },
  ],
}

test('purchase and supplier payment inputs cover all four settlement methods', () => {
  const parsed = parsePurchaseInput(purchaseInput)
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.value.payments.map((payment) => payment.method), [
    'cash', 'bank', 'owner_check', 'transferred_customer_check',
  ])
  assert.equal(parsePurchaseInput({ ...purchaseInput, documentNumber: '' }).value.documentNumber, null)
  assert.equal(parsePurchaseInput({ ...purchaseInput, documentNumber: '   ' }).value.documentNumber, null)
  assert.equal(parsePurchaseInput({ ...purchaseInput, documentNumber: undefined }).value.documentNumber, null)
  assert.match(parsePurchaseInput({ ...purchaseInput, documentNumber: 'x'.repeat(101) }).error, /رقم فاتورة الشراء/)

  assert.match(parsePurchaseInput({ ...purchaseInput, items: [...purchaseInput.items, purchaseInput.items[0]] }).error, /تكرار/)
  assert.match(parseSupplierPaymentInput({ payments: [] }).error, /طريقة دفع/)
  assert.match(parseSupplierPaymentInput({ payments: [
    { method: 'transferred_customer_check', checkId: '31' },
    { method: 'transferred_customer_check', checkId: '31' },
  ] }).error, /مرتين/)
})

test('purchase input accepts invoice-only manual supplier lines with a required description', () => {
  const parsed = parsePurchaseInput({
    ...purchaseInput,
    items: [{ productId: null, description: 'مواد توريد خاصة', quantity: '3', purchasePrice: '12.5' }],
  })

  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.value.items[0], {
    productId: null,
    description: 'مواد توريد خاصة',
    quantity: '3',
    purchasePrice: '12.5',
  })
  assert.match(parsePurchaseInput({
    ...purchaseInput,
    items: [{ productId: null, description: '   ', quantity: '1', purchasePrice: '10' }],
  }).error, /اسم الصنف اليدوي/)
})

function fakeDatabase({ failBank = false } = {}) {
  const state = { commands: [], purchaseItems: [], inventory: [], inventoryCosts: [], productPrices: [], ledgers: [], payments: [], checks: [], cash: [], bank: [], released: false }
  const client = {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, ' ').trim()
      state.commands.push(statement)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rowCount: null, rows: [] }
      if (statement.startsWith('SELECT id FROM stores')) return { rowCount: 1, rows: [{ id: '2' }] }
      if (statement.includes('FROM checks') && statement.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: '31', check_number: 'CUS-31', amount: '25' }] }
      }
      if (statement.startsWith('SELECT id::TEXT AS id, name FROM suppliers')) {
        return { rowCount: 1, rows: [{ id: '8', name: 'مورد الاختبار' }] }
      }
      if (statement.includes('FROM store_inventory AS inventory')) {
        return { rowCount: 1, rows: [{ id: '7', name: 'سلك', unit_name: 'متر' }] }
      }
      if (statement.includes('FROM store_inventory_cost_balances')) {
        return { rowCount: 1, rows: [{ quantity: '10', inventory_value: '400', weighted_average_cost: '40' }] }
      }
      if (statement.startsWith('INSERT INTO purchases')) {
        return { rowCount: 1, rows: [{ id: '77', store_id: '2', supplier_id: '8', document_number: 'P-77', business_date: '2026-09-09', status: 'recorded', currency_code: 'ILS', total: params[5], paid_total: params[6], remaining_due: params[7] }] }
      }
      if (statement.startsWith('INSERT INTO purchase_items')) {
        state.purchaseItems.push(params)
        return { rowCount: 1, rows: [{ id: '101', product_id: params[1], description: params[2], quantity: params[3], purchase_price: params[4] }] }
      }
      if (statement.startsWith('UPDATE products SET current_purchase_price')) {
        state.productPrices.push(params); return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO inventory_movements')) {
        state.inventory.push(params); return { rowCount: 1, rows: [{ id: '501', occurred_at: '2026-09-09T00:00:00.000Z' }] }
      }
      if (statement.startsWith('INSERT INTO inventory_cost_movements')) {
        state.inventoryCosts.push(params); return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO supplier_ledger')) {
        state.ledgers.push(params); return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO payments')) {
        state.payments.push(params)
        return { rowCount: 1, rows: [{ id: String(200 + state.payments.length), method: params[4], amount: params[3], converted_ils_amount: params[3] }] }
      }
      if (statement.startsWith('INSERT INTO financial_movements')) {
        state.cash.push(params); return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO bank_movements')) {
        state.bank.push(params)
        if (failBank) throw new Error('simulated bank failure')
        return { rowCount: 1, rows: [] }
      }
      if (statement.startsWith('INSERT INTO checks')) {
        state.checks.push(params)
        return { rowCount: 1, rows: [{ id: '401', method: 'owner_check', amount: params[4], check_number: params[3], due_date: params[5], status: 'pending' }] }
      }
      if (statement.startsWith('UPDATE checks')) {
        state.checks.push(params)
        return { rowCount: 1, rows: [{ id: '31', method: 'transferred_customer_check', amount: '25', check_number: 'CUS-31', due_date: '2026-10-02', status: 'pending' }] }
      }
      if (statement.startsWith('INSERT INTO audit_log')) return { rowCount: 1, rows: [] }
      throw new Error(`Unexpected query: ${statement}`)
    },
    release() { state.released = true },
  }
  return { databasePool: { connect: async () => client }, state }
}

test('purchase creation commits inventory, latest cost, debt, and mixed payments atomically', async () => {
  const { databasePool, state } = fakeDatabase()
  const purchase = await createPurchase({ databasePool, input: purchaseInput, storeId: '2', userId: '5' })

  assert.equal(purchase.total, '100')
  assert.equal(purchase.paid_total, '70')
  assert.equal(purchase.remaining_due, '30')
  assert.deepEqual(state.purchaseItems[0].slice(1, 5), ['7', 'سلك', '2', '50'])
  assert.deepEqual(state.productPrices, [['50', '7']])
  assert.deepEqual(state.inventory[0].slice(0, 5), ['2', '7', '2', '2026-09-09', '77'])
  assert.deepEqual(state.inventoryCosts[0].slice(0, 6), ['2', '7', '501', '2', '50', '100'])
  assert.equal(purchase.items[0].weighted_average_cost_after, '41.666666666667')
  assert.equal(state.payments.length, 2)
  assert.equal(state.cash.length, 1)
  assert.equal(state.bank.length, 1)
  assert.equal(state.checks.length, 2)
  assert.deepEqual(state.ledgers.map((row) => [row[2], row[3] ?? row[4]]), [
    ['100', '2026-09-09'], ['20', 'purchase_payment'], ['10', 'purchase_payment'],
    ['15', 'owner_check'], ['25', 'check_transfer'],
  ])
  assert.equal(state.commands.at(-1), 'COMMIT')
  assert.equal(state.released, true)
})

test('manual purchase lines save as supplier cost without inventory or catalog price changes', async () => {
  const { databasePool, state } = fakeDatabase()
  const purchase = await createPurchase({
    databasePool,
    storeId: '2',
    userId: '5',
    input: {
      ...purchaseInput,
      items: [{
        productId: null,
        description: 'مواد توريد خاصة',
        quantity: '3',
        purchasePrice: '10',
      }],
      payments: [],
    },
  })

  assert.equal(purchase.total, '30')
  assert.equal(purchase.remaining_due, '30')
  assert.deepEqual(state.purchaseItems[0].slice(1, 5), [null, 'مواد توريد خاصة', '3', '10'])
  assert.equal(purchase.items[0].weighted_average_cost_after, null)
  assert.equal(state.productPrices.length, 0)
  assert.equal(state.inventory.length, 0)
  assert.equal(state.inventoryCosts.length, 0)
  assert.equal(state.commands.at(-1), 'COMMIT')
})

test('a downstream accounting failure rolls the entire purchase back', async () => {
  const { databasePool, state } = fakeDatabase({ failBank: true })
  await assert.rejects(
    createPurchase({ databasePool, input: purchaseInput, storeId: '2', userId: null }),
    /simulated bank failure/,
  )
  assert.equal(state.commands.at(-1), 'ROLLBACK')
  assert.ok(!state.commands.includes('COMMIT'))
})

test('standalone supplier payments cannot exceed locked supplier debt', async () => {
  const commands = []
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim()
      commands.push(statement)
      if (['BEGIN', 'ROLLBACK'].includes(statement)) return { rowCount: null, rows: [] }
      if (statement.startsWith('SELECT id FROM stores')) return { rowCount: 1, rows: [{ id: '2' }] }
      if (statement.startsWith('SELECT id::TEXT AS id, name FROM suppliers')) return { rowCount: 1, rows: [{ id: '8', name: 'مورد' }] }
      if (statement.startsWith('SELECT balance_ils::TEXT')) return { rowCount: 1, rows: [{ balance_ils: '20' }] }
      throw new Error(`Unexpected query: ${statement}`)
    },
    release() {},
  }
  await assert.rejects(
    createSupplierPayment({
      databasePool: { connect: async () => client }, supplierId: '8', storeId: '2', userId: null,
      input: { payments: [{ method: 'cash', amount: '30', reference: null }], notes: null },
    }),
    (error) => error?.code === 'SUPPLIER_PAYMENT_EXCEEDS_DEBT',
  )
  assert.equal(commands.at(-1), 'ROLLBACK')
  assert.ok(!commands.some((statement) => statement.startsWith('INSERT INTO payments')))
})

test('purchase migration protects historical costs and links payment instruments', async () => {
  const [sql, manualItemsSql, automaticNumberSql] = await Promise.all([
    readFile(new URL('../db/migrations/0019_purchase_entry_and_supplier_payments.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/0026_manual_purchase_items.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/0028_automatic_purchase_document_numbers.sql', import.meta.url), 'utf8'),
  ])
  assert.match(sql, /CREATE TRIGGER purchase_items_immutable/)
  assert.match(sql, /ADD COLUMN purchase_id BIGINT/)
  assert.match(sql, /products\.current_purchase_price/)
  assert.match(sql, /purchase_payment_values_consistent/)
  assert.match(sql, /supplier_cash_payment_values_consistent/)
  assert.match(manualItemsSql, /purchase_items_description_not_blank/)
  assert.match(manualItemsSql, /BTRIM\(description\) <> ''/)
  assert.match(manualItemsSql, /never create stock or cost movements/)
  assert.match(automaticNumberSql, /assign_automatic_purchase_document_number/)
  assert.match(automaticNumberSql, /BEFORE INSERT ON purchases/)
  assert.match(automaticNumberSql, /NEW\.id/)
  assert.match(automaticNumberSql, /purchases_document_number_not_blank/)
})

test('purchase UI supports scanner search and all supplier settlement choices', async () => {
  const [page, editor] = await Promise.all([
    readFile(new URL('../../client/src/pages/PurchasePage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/components/SupplierPaymentEditor.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(page, /useBarcodeScanner/)
  assert.match(page, /\/products\?barcode=/)
  assert.match(page, /current_purchase_price/)
  assert.match(page, /\/purchases/)
  assert.match(page, /apiFetch\('\/categories'/)
  assert.match(page, /query\.set\('categoryId', selectedCategoryId\)/)
  assert.match(page, /اختيار سريع مثل نقطة البيع/)
  assert.match(page, /onClick=\{\(\) => setShowCatalog\(true\)\}/)
  assert.match(page, /aria-modal="true"/)
  assert.match(page, /إغلاق اختيار الأصناف/)
  assert.match(page, /aria-label="تصنيفات الأصناف"/)
  assert.match(page, /aria-label="أصناف التصنيف المحدد"/)
  assert.match(page, /onClick=\{\(\) => addProduct\(product\)\}/)
  assert.match(page, /aria-label="سطر شراء يدوي جديد"/)
  assert.match(page, /purchase-manual-draft-row sticky top-\[61px\]/)
  assert.match(page, /commitManualLine/)
  assert.match(page, /productId: null, description: line\.name\.trim\(\)/)
  assert.match(page, /سطر جديد جاهز — لا يؤثر على المخزون/)
  for (const method of ['cash', 'bank', 'owner_check', 'transferred_customer_check']) {
    assert.match(editor, new RegExp(method))
  }
})
