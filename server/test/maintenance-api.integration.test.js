import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import Decimal from 'decimal.js'

const databaseUrl = process.env.GROUP5_INTEGRATION_DATABASE_URL
const MoneyDecimal = Decimal.clone({ precision: 100 })

test(
  'maintenance income, settlement, debt, isolation, and reversal work against PostgreSQL',
  { skip: databaseUrl ? false : 'GROUP5_INTEGRATION_DATABASE_URL is not configured' },
  async (t) => {
    process.env.DATABASE_URL = databaseUrl
    process.env.NODE_ENV = 'test'

    const [{ app }, { pool }] = await Promise.all([
      import('../src/app.js'),
      import('../src/db/pool.js'),
    ])
    const { provisionAdmin } = await import('../src/auth/provision-admin.js')
    const adminUsername = 'maintenance_integration_admin'
    const adminPassword = 'maintenance-integration-password'
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
      assert.ok(otherStore)
      const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`

      await t.test('1. fully paid customer maintenance leaves no debt and is searchable', async () => {
        const customer = await createCustomer(baseUrl, token, store.id, `صيانة مدفوعة ${unique}`)
        const created = await createMaintenance(baseUrl, token, store.id, {
          customerId: customer.id,
          itemDescription: `مضخة ${unique}`,
          amount: '100',
          payments: [{ method: 'cash', currency: 'ILS', amount: '100' }],
        })
        assert.equal(created.response.status, 201)
        assertMoney(created.body.maintenance.remaining_due_ils, '0')
        assertMoney(await customerBalance(pool, customer.id), '0')
        const listed = await apiRequest(baseUrl, `/maintenance?search=${encodeURIComponent(`مضخة ${unique}`)}&date=2026-09-08`, { token, storeId: store.id })
        assert.ok(listed.body.maintenance.some((row) => row.id === created.body.maintenance.id))
      })

      await t.test('2. partially paid maintenance creates only the remaining customer debt', async () => {
        const customer = await createCustomer(baseUrl, token, store.id, `صيانة آجل ${unique}`)
        const created = await createMaintenance(baseUrl, token, store.id, {
          customerId: customer.id, itemDescription: `مولد ${unique}`, amount: '1000',
          payments: [{ method: 'cash', currency: 'ILS', amount: '400' }],
        })
        assert.equal(created.response.status, 201)
        assertMoney(created.body.maintenance.paid_total_ils, '400')
        assertMoney(created.body.maintenance.remaining_due_ils, '600')
        assertMoney(await customerBalance(pool, customer.id), '600')
      })

      await t.test('3. anonymous maintenance must be fully paid', async () => {
        const paid = await createMaintenance(baseUrl, token, store.id, {
          itemDescription: `مروحة ${unique}`, amount: '50',
          payments: [{ method: 'cash', currency: 'ILS', amount: '50' }],
        })
        assert.equal(paid.response.status, 201)
        assert.equal(paid.body.maintenance.customer_id, null)
        const unpaid = await createMaintenance(baseUrl, token, store.id, {
          itemDescription: `مروحة غير مدفوعة ${unique}`, amount: '50', payments: [],
        })
        assert.equal(unpaid.response.status, 400)
        assert.equal(unpaid.body.error.code, 'INVALID_MAINTENANCE_PAYMENTS')
      })

      await t.test('4. mixed payment methods produce exact settlement and debt', async () => {
        const customer = await createCustomer(baseUrl, token, store.id, `صيانة مختلطة ${unique}`)
        const created = await createMaintenance(baseUrl, token, store.id, {
          customerId: customer.id, itemDescription: `كمبروسر ${unique}`, amount: '1000',
          payments: [
            { method: 'cash', currency: 'ILS', amount: '300' },
            { method: 'cash', currency: 'USD', amount: '100', exchangeRate: '3' },
            { method: 'bank_card', amount: '100', reference: `POS-${unique}` },
          ],
        })
        assert.equal(created.response.status, 201)
        assertMoney(created.body.maintenance.paid_total_ils, '700')
        assertMoney(await customerBalance(pool, customer.id), '300')
      })

      await t.test('5. USD cash keeps the original amount, rate, and physical currency', async () => {
        const created = await createMaintenance(baseUrl, token, store.id, {
          itemDescription: `دريل دولار ${unique}`, amount: '300',
          payments: [{ method: 'cash', currency: 'USD', amount: '100', exchangeRate: '3' }],
        })
        assert.equal(created.response.status, 201)
        const payment = await pool.query('SELECT original_amount::TEXT, exchange_rate::TEXT, converted_ils_amount::TEXT, currency_code FROM payments WHERE maintenance_id = $1', [created.body.maintenance.id])
        assert.equal(payment.rows[0].currency_code, 'USD')
        assertMoney(payment.rows[0].original_amount, '100')
        assertMoney(payment.rows[0].exchange_rate, '3')
        assertMoney(payment.rows[0].converted_ils_amount, '300')
        const cash = await pool.query("SELECT amount::TEXT, currency_code FROM financial_movements WHERE source_type = 'maintenance_payment' AND source_id = $1", [created.body.maintenance.payments[0].id])
        assert.equal(cash.rows[0].currency_code, 'USD')
        assertMoney(cash.rows[0].amount, '100')
      })

      await t.test('6. JOD cash also requires and stores a manual rate', async () => {
        const created = await createMaintenance(baseUrl, token, store.id, {
          itemDescription: `دريل دينار ${unique}`, amount: '50',
          payments: [{ method: 'cash', currency: 'JOD', amount: '10', exchangeRate: '5' }],
        })
        assert.equal(created.response.status, 201)
        const payment = await pool.query('SELECT original_amount::TEXT, exchange_rate::TEXT, converted_ils_amount::TEXT, currency_code FROM payments WHERE maintenance_id = $1', [created.body.maintenance.id])
        assert.equal(payment.rows[0].currency_code, 'JOD')
        assertMoney(payment.rows[0].converted_ils_amount, '50')
      })

      await t.test('7. bank/card maintenance payment touches bank ledger, not physical cash', async () => {
        const created = await createMaintenance(baseUrl, token, store.id, {
          itemDescription: `لوحة بنك ${unique}`, amount: '200',
          payments: [{ method: 'bank_card', amount: '200', reference: `BANK-${unique}` }],
        })
        assert.equal(created.response.status, 201)
        const paymentId = created.body.maintenance.payments[0].id
        assert.equal((await pool.query("SELECT 1 FROM bank_movements WHERE source_type = 'maintenance_payment' AND source_id = $1", [paymentId])).rowCount, 1)
        assert.equal((await pool.query("SELECT 1 FROM financial_movements WHERE source_type = 'maintenance_payment' AND source_id = $1", [paymentId])).rowCount, 0)
      })

      await t.test('8. a check immediately reduces maintenance debt', async () => {
        const customer = await createCustomer(baseUrl, token, store.id, `عميل شيك صيانة ${unique}`)
        const created = await createMaintenance(baseUrl, token, store.id, {
          customerId: customer.id, itemDescription: `جهاز شيك ${unique}`, amount: '500',
          payments: [{ method: 'check', amount: '300', checkNumber: `CHK-${unique}`, dueDate: '2026-10-01' }],
        })
        assert.equal(created.response.status, 201)
        assertMoney(created.body.maintenance.remaining_due_ils, '200')
        assertMoney(await customerBalance(pool, customer.id), '200')
        assert.equal((await pool.query('SELECT 1 FROM checks WHERE maintenance_id = $1', [created.body.maintenance.id])).rowCount, 1)
      })

      await t.test('9. maintenance creates no inventory or COGS movement', async () => {
        const created = await createMaintenance(baseUrl, token, store.id, {
          itemDescription: `جهاز خارجي ${unique}`, amount: '75',
          payments: [{ method: 'cash', currency: 'ILS', amount: '75' }],
        })
        assert.equal(created.response.status, 201)
        const movements = await pool.query(
          "SELECT 1 FROM inventory_movements WHERE source_type = 'maintenance' AND source_id = $1",
          [created.body.maintenance.id],
        )
        assert.equal(movements.rowCount, 0)
      })

      await t.test('10. reversal restores customer, cash, and bank balances and preserves original', async () => {
        const customer = await createCustomer(baseUrl, token, store.id, `عكس صيانة ${unique}`)
        const created = await createMaintenance(baseUrl, token, store.id, {
          customerId: customer.id, itemDescription: `جهاز للعكس ${unique}`, amount: '500',
          payments: [
            { method: 'cash', currency: 'ILS', amount: '100' },
            { method: 'bank_card', amount: '200', reference: `REV-${unique}` },
          ],
        })
        assertMoney(await customerBalance(pool, customer.id), '200')
        const reversed = await apiRequest(baseUrl, `/maintenance/${created.body.maintenance.id}/reversal`, {
          token, storeId: store.id, method: 'POST', body: { reason: 'اختبار عكس كامل' },
        })
        assert.equal(reversed.response.status, 201)
        assertMoney(await customerBalance(pool, customer.id), '0')
        const original = await pool.query('SELECT item_description, amount_ils::TEXT FROM maintenance_records WHERE id = $1', [created.body.maintenance.id])
        assert.equal(original.rowCount, 1)
        assert.equal(original.rows[0].item_description, `جهاز للعكس ${unique}`)
        const cashNet = await pool.query(
          `
            SELECT COALESCE(SUM(
              CASE financial_movements.direction
                WHEN 'inflow' THEN financial_movements.amount
                ELSE -financial_movements.amount
              END
            ), 0)::TEXT AS amount
            FROM financial_movements
            INNER JOIN payments ON payments.id = financial_movements.source_id
            WHERE payments.maintenance_id = $1::BIGINT
               OR payments.maintenance_reversal_id = $2::BIGINT
          `,
          [created.body.maintenance.id, reversed.body.reversal.id],
        )
        const bankNet = await pool.query(
          `
            SELECT COALESCE(SUM(
              CASE bank_movements.direction
                WHEN 'inflow' THEN bank_movements.amount_ils
                ELSE -bank_movements.amount_ils
              END
            ), 0)::TEXT AS amount
            FROM bank_movements
            INNER JOIN payments ON payments.id = bank_movements.source_id
            WHERE payments.maintenance_id = $1::BIGINT
               OR payments.maintenance_reversal_id = $2::BIGINT
          `,
          [created.body.maintenance.id, reversed.body.reversal.id],
        )
        assertMoney(cashNet.rows[0].amount, '0')
        assertMoney(bankNet.rows[0].amount, '0')
        assert.equal((await pool.query("SELECT 1 FROM audit_log WHERE entity_type = 'maintenance' AND entity_id = $1 AND action = 'reverse'", [created.body.maintenance.id])).rowCount, 1)
      })

      await t.test('11. maintenance uses the explicitly selected store context', async () => {
        const created = await createMaintenance(baseUrl, token, otherStore.id, {
          itemDescription: `صيانة المعرض ${unique}`,
          amount: '80',
          payments: [{ method: 'cash', currency: 'ILS', amount: '80' }],
        })
        assert.equal(created.response.status, 201)
        assert.equal(created.body.maintenance.store_id, otherStore.id)

        const firstStoreList = await apiRequest(baseUrl, `/maintenance?search=${encodeURIComponent(`صيانة المعرض ${unique}`)}`, {
          token, storeId: store.id,
        })
        const otherStoreList = await apiRequest(baseUrl, `/maintenance?search=${encodeURIComponent(`صيانة المعرض ${unique}`)}`, {
          token, storeId: otherStore.id,
        })
        assert.equal(firstStoreList.body.maintenance.length, 0)
        assert.ok(otherStoreList.body.maintenance.some((row) => row.id === created.body.maintenance.id))
      })
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await pool.end()
    }
  },
)

function createCustomer(baseUrl, token, storeId, name) {
  return apiRequest(baseUrl, '/customers', { token, storeId, method: 'POST', body: { name } })
    .then((created) => {
      assert.equal(created.response.status, 201)
      return created.body.customer
    })
}

function createMaintenance(baseUrl, token, storeId, {
  customerId = null, itemDescription, amount, payments,
}) {
  return apiRequest(baseUrl, '/maintenance', {
    token, storeId, method: 'POST',
    body: { customerId, itemDescription, amount, businessDate: '2026-09-08', payments },
  })
}

async function customerBalance(pool, customerId) {
  const result = await pool.query('SELECT balance_ils::TEXT AS balance_ils FROM customer_balances WHERE customer_id = $1', [customerId])
  return result.rows[0].balance_ils
}

function assertMoney(actual, expected) {
  assert.equal(new MoneyDecimal(actual).toFixed(), new MoneyDecimal(expected).toFixed())
}

async function apiRequest(baseUrl, path, options) {
  const headers = new Headers(options.body ? { 'Content-Type': 'application/json' } : undefined)
  headers.set('Authorization', `Bearer ${options.token}`)
  if (options.storeId) headers.set('X-Store-Id', options.storeId)
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
