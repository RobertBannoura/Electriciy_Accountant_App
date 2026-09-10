import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import Decimal from 'decimal.js'

const databaseUrl = process.env.GROUP5_INTEGRATION_DATABASE_URL
const MoneyDecimal = Decimal.clone({ precision: 100 })

test(
  'Group 5 sales, debt, payments, and store inventory work against PostgreSQL',
  { skip: databaseUrl ? false : 'GROUP5_INTEGRATION_DATABASE_URL is not configured' },
  async (t) => {
    process.env.DATABASE_URL = databaseUrl
    process.env.NODE_ENV = 'test'

    const [{ app }, { pool }, { provisionAdmin }] = await Promise.all([
      import('../src/app.js'),
      import('../src/db/pool.js'),
      import('../src/auth/provision-admin.js'),
    ])
    const adminUsername = 'group5_integration_admin'
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
      const token = login.body.token
      const stores = await apiRequest(baseUrl, '/stores', { token })
      const [store, otherStore] = stores.body.stores
      assert.ok(store)
      assert.ok(otherStore, 'Group 5 inventory coverage requires the two configured stores')

      const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const category = await apiRequest(baseUrl, '/categories', {
        token,
        method: 'POST',
        body: { name: `تصنيف اختبار البيع ${unique}` },
      })
      assert.equal(category.response.status, 201)

      const pieceProduct = await createProduct(baseUrl, token, {
        name: `قاطع اختبار ${unique}`,
        categoryId: category.body.category.id,
        saleUnit: 'قطعة',
        defaultSalePrice: '1000',
        inventorySettings: [
          { storeId: store.id, reorderLevel: '1', openingQuantity: '100' },
          { storeId: otherStore.id, reorderLevel: '1', openingQuantity: '100' },
        ],
      })
      const meterProduct = await createProduct(baseUrl, token, {
        name: `سلك اختبار ${unique}`,
        categoryId: category.body.category.id,
        saleUnit: 'متر',
        defaultSalePrice: '10',
        inventorySettings: [
          { storeId: store.id, reorderLevel: '1', openingQuantity: '100' },
          { storeId: otherStore.id, reorderLevel: '1', openingQuantity: '100' },
        ],
      })

      await t.test('missing and nonexistent web store contexts are rejected before a sale write', async () => {
        const body = {
          invoiceNumber: `NO-STORE-${unique}`,
          date: '2026-09-08',
          customerId: null,
          invoiceDiscount: '0',
          items: [{ productId: pieceProduct.id, quantity: '1', actualPrice: '50', discount: '0' }],
          payments: [{ method: 'cash', currency: 'ILS', amount: '50' }],
        }
        const missing = await apiRequest(baseUrl, '/sales', {
          token, method: 'POST', body,
        })
        assert.equal(missing.response.status, 400)
        assert.equal(missing.body.error.code, 'STORE_CONTEXT_REQUIRED')

        const nonexistent = await apiRequest(baseUrl, '/sales', {
          token, storeId: '999999999999', method: 'POST', body,
        })
        assert.equal(nonexistent.response.status, 404)
        assert.equal(nonexistent.body.error.code, 'STORE_NOT_FOUND')
        assert.equal((await pool.query(
          'SELECT 1 FROM sales WHERE document_number = $1',
          [body.invoiceNumber],
        )).rowCount, 0)
      })

      await t.test('shared customer directory remains business-wide in either store context', async () => {
        const customer = await createCustomer(baseUrl, token, store.id, `عميل مشترك ${unique}`)
        const firstStoreDirectory = await apiRequest(baseUrl, '/customers', {
          token, storeId: store.id,
        })
        const otherStoreDirectory = await apiRequest(baseUrl, '/customers', {
          token, storeId: otherStore.id,
        })
        assert.ok(firstStoreDirectory.body.customers.some((row) => row.id === customer.id))
        assert.ok(otherStoreDirectory.body.customers.some((row) => row.id === customer.id))
      })

      await t.test('fully paid sale leaves no customer debt', async () => {
        const customer = await createCustomer(baseUrl, token, store.id, `عميل مدفوع ${unique}`)
        const created = await createSale(baseUrl, token, store.id, {
          invoiceNumber: `FULL-${unique}`,
          customerId: customer.id,
          productId: pieceProduct.id,
          quantity: '1',
          actualPrice: '100',
          payments: [{ method: 'cash', currency: 'ILS', amount: '100' }],
        })

        assert.equal(created.response.status, 201)
        assertMoney(created.body.sale.total, '100')
        assertMoney(created.body.sale.paid_total, '100')
        assertMoney(created.body.sale.remaining_due, '0')
        assertMoney(await customerBalance(pool, customer.id), '0')
      })

      await t.test('card or bank sale records bank inflow without touching physical cash', async () => {
        const customer = await createCustomer(baseUrl, token, store.id, `Group 9 bank customer ${unique}`)
        const created = await createSale(baseUrl, token, store.id, {
          invoiceNumber: `BANK-${unique}`,
          customerId: customer.id,
          productId: pieceProduct.id,
          quantity: '1',
          actualPrice: '120',
          payments: [{ method: 'bank_card', amount: '120', reference: `CARD-${unique}` }],
        })

        assert.equal(created.response.status, 201)
        assertMoney(created.body.sale.paid_total, '120')
        assertMoney(created.body.sale.remaining_due, '0')
        const movementFacts = await pool.query(
          `SELECT
             (SELECT COUNT(*)::INTEGER FROM bank_movements AS bank
              INNER JOIN payments ON payments.id = bank.source_id
              WHERE payments.sale_id = $1::BIGINT AND payments.payment_method = 'bank_card'
                AND bank.source_type = 'sale_payment' AND bank.amount_ils = 120) AS bank_count,
             (SELECT COUNT(*)::INTEGER FROM financial_movements AS cash
              INNER JOIN payments ON payments.id = cash.source_id
              WHERE payments.sale_id = $1::BIGINT) AS cash_count`,
          [created.body.sale.id],
        )
        assert.deepEqual(movementFacts.rows[0], { bank_count: 1, cash_count: 0 })
      })

      let debtCustomer
      await t.test('partially paid sale increases customer debt by only the remainder', async () => {
        debtCustomer = await createCustomer(baseUrl, token, store.id, `عميل آجل ${unique}`)
        const created = await createSale(baseUrl, token, store.id, {
          invoiceNumber: `DEBT-${unique}`,
          customerId: debtCustomer.id,
          productId: pieceProduct.id,
          quantity: '1',
          actualPrice: '1000',
          payments: [{ method: 'cash', currency: 'ILS', amount: '400' }],
        })

        assert.equal(created.response.status, 201)
        assertMoney(created.body.sale.total, '1000')
        assertMoney(created.body.sale.paid_total, '400')
        assertMoney(created.body.sale.remaining_due, '600')
        assertMoney(await customerBalance(pool, debtCustomer.id), '600')
      })

      await t.test('anonymous sale must be fully paid and creates no customer ledger rows', async () => {
        const created = await createSale(baseUrl, token, store.id, {
          invoiceNumber: `ANON-${unique}`,
          productId: pieceProduct.id,
          quantity: '1',
          actualPrice: '50',
          payments: [{ method: 'cash', currency: 'ILS', amount: '50' }],
        })

        assert.equal(created.response.status, 201)
        assert.equal(created.body.sale.customer_id, null)
        assertMoney(created.body.sale.remaining_due, '0')
        const ledger = await pool.query(
          "SELECT 1 FROM customer_ledger WHERE source_type = 'sale' AND source_id = $1::BIGINT",
          [created.body.sale.id],
        )
        assert.equal(ledger.rowCount, 0)

        const unpaid = await createSale(baseUrl, token, store.id, {
          invoiceNumber: `ANON-DEBT-${unique}`,
          productId: pieceProduct.id,
          quantity: '1',
          actualPrice: '50',
          payments: [],
        })
        assert.equal(unpaid.response.status, 400)
        assert.equal(unpaid.body.error.code, 'INVALID_SALE_PAYMENTS')
      })

      await t.test('mixed cash, foreign cash, and check payment leaves the exact debt', async () => {
        const customer = await createCustomer(baseUrl, token, store.id, `عميل مختلط ${unique}`)
        const created = await createSale(baseUrl, token, store.id, {
          invoiceNumber: `MIXED-${unique}`,
          customerId: customer.id,
          productId: pieceProduct.id,
          quantity: '1',
          actualPrice: '1000',
          payments: [
            { method: 'cash', currency: 'ILS', amount: '300' },
            { method: 'cash', currency: 'USD', amount: '100', exchangeRate: '3' },
            {
              method: 'check', amount: '200', checkNumber: `CHK-${unique}`,
              bankName: 'بنك الاختبار', dueDate: '2026-10-01',
            },
          ],
        })

        assert.equal(created.response.status, 201)
        assertMoney(created.body.sale.paid_total, '800')
        assertMoney(created.body.sale.remaining_due, '200')
        assertMoney(await customerBalance(pool, customer.id), '200')

        const ledger = await pool.query(
          `
            SELECT direction, amount_ils::TEXT AS amount_ils, source_type
            FROM customer_ledger
            WHERE customer_id = $1::BIGINT
            ORDER BY id
          `,
          [customer.id],
        )
        assert.deepEqual(ledger.rows.map((row) => row.direction), [
          'debit', 'credit', 'credit', 'credit',
        ])
        assert.deepEqual(ledger.rows.map((row) => row.source_type), [
          'sale', 'sale_payment', 'sale_payment', 'sale_check',
        ])
        assert.deepEqual(ledger.rows.map((row) => new MoneyDecimal(row.amount_ils).toFixed()), [
          '1000', '300', '300', '200',
        ])
      })

      await t.test('foreign customer payment retains its amount, rate, and physical currency', async () => {
        assert.ok(debtCustomer)
        const receipt = await apiRequest(baseUrl, `/customers/${debtCustomer.id}/payments`, {
          token,
          storeId: store.id,
          method: 'POST',
          body: {
            payments: [
              { method: 'cash', currency: 'USD', amount: '100', exchangeRate: '3' },
            ],
          },
        })

        assert.equal(receipt.response.status, 201)
        assertMoney(receipt.body.payment.total_ils, '300')
        assertMoney(receipt.body.payment.balance_before_ils, '600')
        assertMoney(receipt.body.payment.balance_after_ils, '300')
        const paymentId = receipt.body.payment.payments[0].id

        const snapshots = await pool.query(
          `
            SELECT original_amount::TEXT AS original_amount,
                   exchange_rate::TEXT AS exchange_rate,
                   converted_ils_amount::TEXT AS converted_ils_amount,
                   currency_code, sale_id
            FROM payments
            WHERE id = $1::BIGINT
          `,
          [paymentId],
        )
        assert.equal(snapshots.rows[0].currency_code, 'USD')
        assert.equal(snapshots.rows[0].sale_id, null)
        assertMoney(snapshots.rows[0].original_amount, '100')
        assertMoney(snapshots.rows[0].exchange_rate, '3')
        assertMoney(snapshots.rows[0].converted_ils_amount, '300')

        const cash = await pool.query(
          `
            SELECT amount::TEXT AS amount, currency_code
            FROM financial_movements
            WHERE source_type = 'customer_payment' AND source_id = $1::BIGINT
          `,
          [paymentId],
        )
        assert.equal(cash.rowCount, 1)
        assert.equal(cash.rows[0].currency_code, 'USD')
        assertMoney(cash.rows[0].amount, '100')
      })

      await t.test('bank customer payment affects the bank ledger and never physical cash', async () => {
        assert.ok(debtCustomer)
        const receipt = await apiRequest(baseUrl, `/customers/${debtCustomer.id}/payments`, {
          token,
          storeId: store.id,
          method: 'POST',
          body: {
            payments: [{ method: 'bank_card', amount: '100', reference: `BANK-${unique}` }],
          },
        })

        assert.equal(receipt.response.status, 201)
        assertMoney(receipt.body.payment.balance_after_ils, '200')
        const paymentId = receipt.body.payment.payments[0].id
        const bank = await pool.query(
          `
            SELECT amount_ils::TEXT AS amount_ils
            FROM bank_movements
            WHERE source_type = 'customer_payment' AND source_id = $1::BIGINT
          `,
          [paymentId],
        )
        assert.equal(bank.rowCount, 1)
        assertMoney(bank.rows[0].amount_ils, '100')
        const cash = await pool.query(
          `
            SELECT 1 FROM financial_movements
            WHERE source_type = 'customer_payment' AND source_id = $1::BIGINT
          `,
          [paymentId],
        )
        assert.equal(cash.rowCount, 0)
        assertMoney(await customerBalance(pool, debtCustomer.id), '200')
      })

      let meterSale
      await t.test('meter products deduct fractional quantities', async () => {
        meterSale = await createSale(baseUrl, token, store.id, {
          invoiceNumber: `METER-${unique}`,
          productId: meterProduct.id,
          quantity: '2.5',
          actualPrice: '10',
          payments: [{ method: 'cash', currency: 'ILS', amount: '25' }],
        })

        assert.equal(meterSale.response.status, 201)
        assertMoney(meterSale.body.sale.total, '25')
        const movement = await pool.query(
          `
            SELECT quantity_delta::TEXT AS quantity_delta
            FROM inventory_movements
            WHERE source_type = 'sale' AND source_id = $1::BIGINT
          `,
          [meterSale.body.sale.id],
        )
        assert.equal(movement.rowCount, 1)
        assertMoney(movement.rows[0].quantity_delta, '-2.5')
      })

      await t.test('كهرباء السلام context deducts only كهرباء السلام inventory', async () => {
        assert.ok(meterSale)
        assertMoney(await inventoryBalance(pool, store.id, meterProduct.id), '97.5')
        assertMoney(await inventoryBalance(pool, otherStore.id, meterProduct.id), '100')
        assert.equal(meterSale.body.sale.store_id, store.id)
      })

      await t.test('المعرض context deducts only المعرض inventory', async () => {
        const otherStoreSale = await createSale(baseUrl, token, otherStore.id, {
          invoiceNumber: `OTHER-STORE-${unique}`,
          productId: meterProduct.id,
          quantity: '4',
          actualPrice: '10',
          payments: [{ method: 'cash', currency: 'ILS', amount: '40' }],
        })

        assert.equal(otherStoreSale.response.status, 201)
        assert.equal(otherStoreSale.body.sale.store_id, otherStore.id)
        assertMoney(await inventoryBalance(pool, store.id, meterProduct.id), '97.5')
        assertMoney(await inventoryBalance(pool, otherStore.id, meterProduct.id), '96')
      })
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await pool.end()
    }
  },
)

async function createProduct(baseUrl, token, body) {
  const created = await apiRequest(baseUrl, '/products', { token, method: 'POST', body })
  assert.equal(created.response.status, 201)
  return created.body.product
}

async function createCustomer(baseUrl, token, storeId, name) {
  const created = await apiRequest(baseUrl, '/customers', {
    token,
    storeId,
    method: 'POST',
    body: { name },
  })
  assert.equal(created.response.status, 201)
  return created.body.customer
}

function createSale(baseUrl, token, storeId, {
  invoiceNumber,
  customerId = null,
  productId,
  quantity,
  actualPrice,
  payments,
}) {
  return apiRequest(baseUrl, '/sales', {
    token,
    storeId,
    method: 'POST',
    body: {
      invoiceNumber,
      date: '2026-09-08',
      customerId,
      invoiceDiscount: '0',
      items: [{ productId, quantity, actualPrice, discount: '0' }],
      payments,
    },
  })
}

async function customerBalance(pool, customerId) {
  const result = await pool.query(
    'SELECT balance_ils::TEXT AS balance_ils FROM customer_balances WHERE customer_id = $1',
    [customerId],
  )
  return result.rows[0].balance_ils
}

async function inventoryBalance(pool, storeId, productId) {
  const result = await pool.query(
    `
      SELECT quantity::TEXT AS quantity
      FROM store_inventory_balances
      WHERE store_id = $1::BIGINT AND product_id = $2::BIGINT
    `,
    [storeId, productId],
  )
  return result.rows[0].quantity
}

function assertMoney(actual, expected) {
  assert.equal(new MoneyDecimal(actual).toFixed(), new MoneyDecimal(expected).toFixed())
}

async function apiRequest(baseUrl, path, options) {
  const headers = new Headers(options.body ? { 'Content-Type': 'application/json' } : undefined)
  headers.set('Authorization', `Bearer ${options.token}`)
  if (options.storeId) headers.set('X-Store-Id', options.storeId)
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
    headers.set('X-Request-Id', crypto.randomUUID())
  }
  return jsonRequest(`${baseUrl}${path}`, {
    method: options.method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}
