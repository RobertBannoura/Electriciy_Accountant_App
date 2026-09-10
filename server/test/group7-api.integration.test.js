import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import Decimal from 'decimal.js'

const databaseUrl = process.env.GROUP7_INTEGRATION_DATABASE_URL
const D = Decimal.clone({ precision: 100 })

test(
  'Group 7 purchases, average cost, returns, and expenses work against PostgreSQL',
  { skip: databaseUrl ? false : 'GROUP7_INTEGRATION_DATABASE_URL is not configured' },
  async () => {
    process.env.DATABASE_URL = databaseUrl
    process.env.NODE_ENV = 'test'
    const [{ app }, { pool }, { provisionAdmin }] = await Promise.all([
      import('../src/app.js'), import('../src/db/pool.js'), import('../src/auth/provision-admin.js'),
    ])
    const adminUsername = 'group7_integration_admin'
    const adminPassword = randomBytes(32).toString('base64url')
    await provisionAdmin(pool, {
      username: adminUsername,
      password: adminPassword,
      displayName: 'Integration Test Admin',
    })
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}/api`

    try {
      const login = await jsonRequest(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminUsername, password: adminPassword }),
      })
      assert.equal(login.response.status, 201)
      const token = login.body.token
      const storesResponse = await apiRequest(baseUrl, '/stores', { token })
      const store = storesResponse.body.stores.find((row) => row.code === 'AL_SALAM_ELECTRIC')
      const otherStore = storesResponse.body.stores.find((row) => row.code === 'SHOWROOM')
      assert.ok(store && otherStore)
      const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`

      const category = await apiRequest(baseUrl, '/categories', {
        token, method: 'POST', body: { name: `Group 7 QA ${unique}` },
      })
      assert.equal(category.response.status, 201)
      const product = await apiRequest(baseUrl, '/products', {
        token, method: 'POST', body: {
          name: `QA cable ${unique}`, categoryId: category.body.category.id,
          saleUnit: 'متر', currentPurchasePrice: '10', defaultSalePrice: '30',
          inventorySettings: [
            { storeId: store.id, reorderLevel: '2', openingQuantity: '10' },
            { storeId: otherStore.id, reorderLevel: '2', openingQuantity: '0' },
          ],
        },
      })
      assert.equal(product.response.status, 201)
      const productId = product.body.product.id
      const supplier = await apiRequest(baseUrl, '/suppliers', {
        token, storeId: store.id, method: 'POST', body: { name: `QA supplier ${unique}` },
      })
      const customer = await apiRequest(baseUrl, '/customers', {
        token, storeId: store.id, method: 'POST', body: { name: `QA customer ${unique}` },
      })
      assert.equal(supplier.response.status, 201)
      assert.equal(customer.response.status, 201)

      const startingCash = await pool.query("SELECT balance::TEXT AS balance FROM store_cash_balances WHERE store_id = $1 AND currency_code = 'ILS'", [store.id])
      const startingBank = await pool.query('SELECT balance_ils::TEXT AS balance FROM store_bank_balances WHERE store_id = $1', [store.id])
      const startingCashBalance = startingCash.rows[0]?.balance ?? '0'
      const startingBankBalance = startingBank.rows[0]?.balance ?? '0'

      const purchase = await apiRequest(baseUrl, '/purchases', {
        token, storeId: store.id, method: 'POST', body: {
          supplierId: supplier.body.supplier.id, documentNumber: `P-${unique}`,
          businessDate: '2026-09-09', items: [{ productId, quantity: '10', purchasePrice: '20' }],
          payments: [{ method: 'cash', amount: '5' }, { method: 'bank', amount: '5' }],
        },
      })
      assert.equal(purchase.response.status, 201)
      money(purchase.body.purchase.total, '200')
      money(purchase.body.purchase.remaining_due, '190')
      money(purchase.body.purchase.items[0].purchase_price, '20')
      money(purchase.body.purchase.items[0].weighted_average_cost_after, '15')
      await assertInventory(pool, store.id, productId, '20', '300', '15')
      await assertInventory(pool, otherStore.id, productId, '0', '0', '0')

      const sale = await apiRequest(baseUrl, '/sales', {
        token, storeId: store.id, method: 'POST', body: {
          invoiceNumber: `S-${unique}`, date: '2026-09-09',
          customerId: customer.body.customer.id, invoiceDiscount: '0',
          items: [{ productId, quantity: '4', actualPrice: '30', discount: '0' }],
          payments: [],
        },
      })
      assert.equal(sale.response.status, 201)
      money(sale.body.sale.cost_total, '60')
      money(sale.body.sale.gross_profit, '60')
      money(sale.body.sale.items[0].unit_cost_snapshot, '15')
      await assertInventory(pool, store.id, productId, '16', '240', '15')

      const saleSources = await apiRequest(baseUrl, '/returns/customer/sources', { token, storeId: store.id })
      assert.equal(saleSources.response.status, 200)
      const saleSource = saleSources.body.documents.find((row) => row.id === sale.body.sale.id)
      assert.equal(saleSource.items[0].returnable_quantity, '4.000')
      const customerReturn = await apiRequest(baseUrl, '/returns/customer', {
        token, storeId: store.id, method: 'POST', body: {
          sourceDocumentId: sale.body.sale.id,
          items: [{ sourceItemId: sale.body.sale.items[0].id, quantity: '2' }],
        },
      })
      assert.equal(customerReturn.response.status, 201)
      money(customerReturn.body.return.total, '60')
      money(customerReturn.body.return.cost_total, '30')
      await assertInventory(pool, store.id, productId, '18', '270', '15')
      money(await partyBalance(pool, 'customer_balances', 'customer_id', customer.body.customer.id), '60')

      const excessiveCustomerReturn = await apiRequest(baseUrl, '/returns/customer', {
        token, storeId: store.id, method: 'POST', body: {
          sourceDocumentId: sale.body.sale.id,
          items: [{ sourceItemId: sale.body.sale.items[0].id, quantity: '3' }],
        },
      })
      assert.equal(excessiveCustomerReturn.response.status, 409)
      assert.equal(excessiveCustomerReturn.body.error.code, 'RETURN_QUANTITY_EXCEEDED')
      await assertInventory(pool, store.id, productId, '18', '270', '15')

      const purchaseSources = await apiRequest(baseUrl, '/returns/supplier/sources', { token, storeId: store.id })
      assert.equal(purchaseSources.response.status, 200)
      const purchaseSource = purchaseSources.body.documents.find((row) => row.id === purchase.body.purchase.id)
      assert.equal(purchaseSource.items[0].returnable_quantity, '10')
      const supplierReturn = await apiRequest(baseUrl, '/returns/supplier', {
        token, storeId: store.id, method: 'POST', body: {
          sourceDocumentId: purchase.body.purchase.id,
          items: [{ sourceItemId: purchase.body.purchase.items[0].id, quantity: '3' }],
        },
      })
      assert.equal(supplierReturn.response.status, 201)
      money(supplierReturn.body.return.total, '60')
      money(supplierReturn.body.return.inventory_cost_total, '60')
      money(supplierReturn.body.return.cost_variance, '0')
      money(supplierReturn.body.return.items[0].unitInventoryCostSnapshot, '20')
      await assertInventory(pool, store.id, productId, '15', '210', '14')
      money(await partyBalance(pool, 'supplier_balances', 'supplier_id', supplier.body.supplier.id), '130')

      const excessiveSupplierReturn = await apiRequest(baseUrl, '/returns/supplier', {
        token, storeId: store.id, method: 'POST', body: {
          sourceDocumentId: purchase.body.purchase.id,
          items: [{ sourceItemId: purchase.body.purchase.items[0].id, quantity: '8' }],
        },
      })
      assert.equal(excessiveSupplierReturn.response.status, 409)
      assert.equal(excessiveSupplierReturn.body.error.code, 'RETURN_QUANTITY_EXCEEDED')

      const latestPurchase = await apiRequest(baseUrl, '/purchases', {
        token, storeId: store.id, method: 'POST', body: {
          supplierId: supplier.body.supplier.id, documentNumber: `P2-${unique}`,
          businessDate: '2026-09-09', items: [{ productId, quantity: '5', purchasePrice: '30' }],
          payments: [],
        },
      })
      assert.equal(latestPurchase.response.status, 201)
      await assertInventory(pool, store.id, productId, '20', '360', '18')
      const historical = await pool.query(
        `SELECT products.current_purchase_price::TEXT AS latest,
          first_item.unit_cost::TEXT AS historical_purchase,
          sale_items.unit_cost_snapshot::TEXT AS historical_sale_cost,
          sales.gross_profit::TEXT AS historical_profit
         FROM products
         INNER JOIN purchase_items AS first_item ON first_item.id = $2::BIGINT
         INNER JOIN sale_items ON sale_items.id = $3::BIGINT
         INNER JOIN sales ON sales.id = sale_items.sale_id
         WHERE products.id = $1::BIGINT`,
        [productId, purchase.body.purchase.items[0].id, sale.body.sale.items[0].id],
      )
      money(historical.rows[0].latest, '30')
      money(historical.rows[0].historical_purchase, '20')
      money(historical.rows[0].historical_sale_cost, '15')
      money(historical.rows[0].historical_profit, '60')

      const createdExpenseIds = []
      for (const [categoryName, amount, paymentMethod] of [
        ['كهرباء', '50', 'cash'], ['أجار', '25', 'bank'],
      ]) {
        const expense = await apiRequest(baseUrl, '/expenses', {
          token, storeId: store.id, method: 'POST', body: {
            amount, category: categoryName, date: '2026-09-09', paymentMethod,
          },
        })
        assert.equal(expense.response.status, 201)
        createdExpenseIds.push(expense.body.expense.id)
      }
      const expenseList = await apiRequest(baseUrl, '/expenses', { token, storeId: store.id })
      assert.deepEqual(expenseList.body.categories, ['كهرباء', 'أجار', 'رواتب', 'مواصلات', 'صيانة', 'مشتريات للمحل', 'أخرى'])
      assert.equal(createdExpenseIds.every((id) => expenseList.body.expenses.some((expense) => expense.id === id)), true)
      const cash = await pool.query("SELECT balance::TEXT AS balance FROM store_cash_balances WHERE store_id = $1 AND currency_code = 'ILS'", [store.id])
      const bank = await pool.query('SELECT balance_ils::TEXT AS balance FROM store_bank_balances WHERE store_id = $1', [store.id])
      money(new D(cash.rows[0].balance).minus(startingCashBalance), '-55')
      money(new D(bank.rows[0].balance).minus(startingBankBalance), '-30')

      const invalidExpenseCount = Number((await pool.query('SELECT COUNT(*) AS count FROM expenses')).rows[0].count)
      const invalidExpense = await apiRequest(baseUrl, '/expenses', {
        token, storeId: store.id, method: 'POST', body: {
          amount: '10', category: 'دخل متنوع', date: '2026-09-09', paymentMethod: 'cash',
        },
      })
      assert.equal(invalidExpense.response.status, 400)
      assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM expenses')).rows[0].count), invalidExpenseCount)

      const receivedCheck = await apiRequest(baseUrl, `/customers/${customer.body.customer.id}/payments`, {
        token, storeId: store.id, method: 'POST', body: {
          payments: [{
            method: 'check', currency: 'ILS', amount: '30',
            checkNumber: `CUSTOMER-CHECK-${unique}`, dueDate: '2026-10-01',
          }],
        },
      })
      assert.equal(receivedCheck.response.status, 201)
      const transferredCheckId = receivedCheck.body.payment.payments[0].id
      const checkPurchase = await apiRequest(baseUrl, '/purchases', {
        token, storeId: store.id, method: 'POST', body: {
          supplierId: supplier.body.supplier.id, documentNumber: `P-CHECKS-${unique}`,
          businessDate: '2026-09-09', items: [{ productId, quantity: '2', purchasePrice: '30' }],
          payments: [
            { method: 'owner_check', amount: '30', checkNumber: `OWNER-CHECK-${unique}`, dueDate: '2026-10-01' },
            { method: 'transferred_customer_check', checkId: transferredCheckId },
          ],
        },
      })
      assert.equal(checkPurchase.response.status, 201)
      money(checkPurchase.body.purchase.paid_total, '60')
      money(checkPurchase.body.purchase.remaining_due, '0')
      assert.deepEqual(
        checkPurchase.body.purchase.payments.map((payment) => payment.method).sort(),
        ['owner_check', 'transferred_customer_check'],
      )
      const ownerCheckId = checkPurchase.body.purchase.payments.find((payment) => payment.method === 'owner_check').id
      const purchaseChecks = await pool.query(
        `SELECT id::TEXT AS id, supplier_id::TEXT AS supplier_id,
          purchase_id::TEXT AS purchase_id, is_owner_issued, transferred_at
         FROM checks WHERE id = ANY($1::BIGINT[]) ORDER BY id`,
        [[transferredCheckId, ownerCheckId]],
      )
      assert.equal(purchaseChecks.rowCount, 2)
      for (const check of purchaseChecks.rows) {
        assert.equal(check.supplier_id, supplier.body.supplier.id)
        assert.equal(check.purchase_id, checkPurchase.body.purchase.id)
      }
      assert.equal(purchaseChecks.rows.find((check) => check.id === ownerCheckId).is_owner_issued, true)
      assert.ok(purchaseChecks.rows.find((check) => check.id === transferredCheckId).transferred_at)

      const originals = await pool.query(
        `SELECT (SELECT quantity FROM sale_items WHERE id = $1) AS sale_quantity,
          (SELECT quantity FROM purchase_items WHERE id = $2) AS purchase_quantity`,
        [sale.body.sale.items[0].id, purchase.body.purchase.items[0].id],
      )
      money(originals.rows[0].sale_quantity, '4')
      money(originals.rows[0].purchase_quantity, '10')
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await pool.end()
    }
  },
)

async function assertInventory(pool, storeId, productId, quantity, value, average) {
  const result = await pool.query(
    `SELECT balances.quantity::TEXT AS quantity,
      costs.inventory_value::TEXT AS inventory_value,
      costs.weighted_average_cost::TEXT AS weighted_average_cost
     FROM store_inventory_balances AS balances
     INNER JOIN store_inventory_cost_balances AS costs
       ON costs.store_id = balances.store_id AND costs.product_id = balances.product_id
     WHERE balances.store_id = $1::BIGINT AND balances.product_id = $2::BIGINT`,
    [storeId, productId],
  )
  money(result.rows[0].quantity, quantity)
  money(result.rows[0].inventory_value, value)
  money(result.rows[0].weighted_average_cost, average)
}

async function partyBalance(pool, view, idColumn, id) {
  assert.ok(['customer_balances', 'supplier_balances'].includes(view))
  assert.ok(['customer_id', 'supplier_id'].includes(idColumn))
  const result = await pool.query(`SELECT balance_ils::TEXT AS balance FROM ${view} WHERE ${idColumn} = $1::BIGINT`, [id])
  return result.rows[0].balance
}

function money(actual, expected) {
  assert.equal(new D(actual).toFixed(), new D(expected).toFixed())
}

async function apiRequest(baseUrl, path, { token, storeId, method, body } = {}) {
  const headers = new Headers(body ? { 'Content-Type': 'application/json' } : undefined)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (storeId) headers.set('X-Store-Id', storeId)
  if (method && !['GET', 'HEAD'].includes(method.toUpperCase())) headers.set('X-Request-Id', crypto.randomUUID())
  return jsonRequest(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}
