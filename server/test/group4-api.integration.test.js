import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

const databaseUrl = process.env.GROUP4_INTEGRATION_DATABASE_URL

test(
  'Group 4 shared parties and ILS accounting work against PostgreSQL',
  { skip: databaseUrl ? false : 'GROUP4_INTEGRATION_DATABASE_URL is not configured' },
  async () => {
    process.env.DATABASE_URL = databaseUrl
    process.env.NODE_ENV = 'test'

    const [{ app }, { pool }] = await Promise.all([
      import('../src/app.js'),
      import('../src/db/pool.js'),
    ])
    const { provisionAdmin } = await import('../src/auth/provision-admin.js')
    const adminUsername = 'group4_integration_admin'
    const adminPassword = 'group4-integration-password'
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
      const stores = await apiRequest('/stores', { token })
      const salam = stores.body.stores.find((store) => store.code === 'AL_SALAM_ELECTRIC')
      const showroom = stores.body.stores.find((store) => store.code === 'SHOWROOM')
      assert.ok(salam && showroom)

      const missingStore = await apiRequest('/customers', { token })
      assert.equal(missingStore.response.status, 400)
      assert.equal(missingStore.body.error.code, 'STORE_CONTEXT_REQUIRED')

      const createdCustomer = await apiRequest('/customers', {
        token,
        storeId: salam.id,
        method: 'POST',
        body: {
          name: 'أحمد الكهربائي',
          phone: '0599000000',
          address: 'رام الله',
          notes: 'عميل مشترك',
          balance: '999999',
        },
      })
      assert.equal(createdCustomer.response.status, 201)
      assert.equal(createdCustomer.body.customer.balance, undefined)
      assert.equal(createdCustomer.body.customer.balance_ils, '0')
      const customerId = createdCustomer.body.customer.id

      const sameCustomerFromShowroom = await apiRequest(
        '/customers?search=0599000000',
        { token, storeId: showroom.id },
      )
      assert.equal(sameCustomerFromShowroom.response.status, 200)
      assert.equal(sameCustomerFromShowroom.body.customers.length, 1)
      assert.equal(sameCustomerFromShowroom.body.customers[0].id, customerId)

      const duplicateName = await apiRequest('/customers', {
        token,
        storeId: showroom.id,
        method: 'POST',
        body: { name: 'أحمد الكهربائي' },
      })
      assert.equal(duplicateName.response.status, 201)
      assert.notEqual(duplicateName.body.customer.id, customerId)

      const project = await apiRequest(`/customers/${customerId}/projects`, {
        token,
        storeId: salam.id,
        method: 'POST',
        body: { name: 'بيت خالد', notes: 'مشروع مشترك بين المحلين' },
      })
      assert.equal(project.response.status, 201)
      const projectId = project.body.project.id

      const projectSale = await pool.query(
        `
          INSERT INTO sales (
            store_id, customer_id, customer_project_id, document_number,
            business_date, status, currency_code
          ) VALUES ($1, $2, $3, 'SHOWROOM-PROJECT', CURRENT_DATE, 'recorded', 'ILS')
          RETURNING id
        `,
        [showroom.id, customerId, projectId],
      )
      await pool.query(
        `
          INSERT INTO customer_ledger (
            store_id, customer_id, direction, amount_ils,
            occurred_at, source_type, source_id, notes
          ) VALUES
            ($1, $3, 'debit', 2000, NOW() - INTERVAL '4 days', 'opening', NULL, 'دين السلام'),
            ($2, $3, 'debit', 1500, NOW() - INTERVAL '3 days', 'opening', NULL, 'دين المعرض'),
            ($2, $3, 'debit', 50, NOW() - INTERVAL '2 days', 'sale', $4, 'بيع المشروع')
        `,
        [salam.id, showroom.id, customerId, projectSale.rows[0].id],
      )

      const usdPayment = await pool.query(
        `
          INSERT INTO payments (
            store_id, customer_id, direction, original_amount, currency_code,
            exchange_rate, converted_ils_amount, payment_method, paid_at
          ) VALUES ($1, $2, 'inflow', 100, 'USD', 3.00, 300, 'cash', NOW())
          RETURNING id, original_amount::TEXT, currency_code,
                    exchange_rate::TEXT, converted_ils_amount::TEXT
        `,
        [salam.id, customerId],
      )
      await pool.query(
        `
          INSERT INTO customer_ledger (
            store_id, customer_id, direction, amount_ils,
            occurred_at, source_type, source_id, notes
          ) VALUES ($1, $2, 'credit', 300, NOW(), 'payment', $3, 'دفعة دولار')
        `,
        [salam.id, customerId, usdPayment.rows[0].id],
      )

      const jodPayment = await pool.query(
        `
          INSERT INTO payments (
            store_id, customer_id, direction, original_amount, currency_code,
            exchange_rate, converted_ils_amount, payment_method, paid_at
          ) VALUES ($1, $2, 'inflow', 50, 'JOD', 5.00, 250, 'cash', NOW())
          RETURNING id, original_amount::TEXT, currency_code,
                    exchange_rate::TEXT, converted_ils_amount::TEXT
        `,
        [showroom.id, customerId],
      )
      await pool.query(
        `
          INSERT INTO customer_ledger (
            store_id, customer_id, direction, amount_ils,
            occurred_at, source_type, source_id, notes
          ) VALUES ($1, $2, 'credit', 250, NOW(), 'payment', $3, 'دفعة دينار')
        `,
        [showroom.id, customerId, jodPayment.rows[0].id],
      )

      assert.deepEqual(usdPayment.rows[0], {
        id: usdPayment.rows[0].id,
        original_amount: '100',
        currency_code: 'USD',
        exchange_rate: '3.00',
        converted_ils_amount: '300',
      })
      assert.deepEqual(jodPayment.rows[0], {
        id: jodPayment.rows[0].id,
        original_amount: '50',
        currency_code: 'JOD',
        exchange_rate: '5.00',
        converted_ils_amount: '250',
      })

      const customerListFromSalam = await apiRequest(
        '/customers?search=0599000000',
        { token, storeId: salam.id },
      )
      const customerListFromShowroom = await apiRequest(
        '/customers?search=0599000000',
        { token, storeId: showroom.id },
      )
      for (const list of [customerListFromSalam, customerListFromShowroom]) {
        assert.equal(list.body.customers.length, 1)
        assert.equal(list.body.customers[0].id, customerId)
        assert.equal(list.body.customers[0].balance_ils, '3000')
        assert.equal(list.body.customers[0].balances, undefined)
      }

      const customerDetail = await apiRequest(`/customers/${customerId}`, {
        token,
        storeId: showroom.id,
      })
      assert.equal(customerDetail.response.status, 200)
      assert.equal(customerDetail.body.customer.balance_ils, '3000')
      assert.equal(customerDetail.body.customer.selected_store_id, null)
      assert.deepEqual(
        customerDetail.body.customer.store_balances.map((balance) => ({
          store_name: balance.store_name,
          amount_ils: balance.amount_ils,
        })),
        [
          { store_name: 'كهرباء السلام', amount_ils: '1700' },
          { store_name: 'المعرض', amount_ils: '1300' },
        ],
      )
      assert.equal(customerDetail.body.customer.payments.length, 2)
      assert.equal(customerDetail.body.customer.recent_movements.length, 5)
      assert.deepEqual(
        new Set(customerDetail.body.customer.recent_movements.map((row) => row.store_name)),
        new Set(['كهرباء السلام', 'المعرض']),
      )

      const salamActivity = await apiRequest(
        `/customers/${customerId}?storeId=${salam.id}`,
        { token, storeId: showroom.id },
      )
      assert.equal(salamActivity.body.customer.balance_ils, '3000')
      assert.equal(salamActivity.body.customer.selected_store_id, salam.id)
      assert.equal(salamActivity.body.customer.payments.length, 1)
      assert.equal(salamActivity.body.customer.recent_movements.length, 2)
      assert.ok(
        salamActivity.body.customer.recent_movements.every(
          (movement) => movement.store_id === salam.id,
        ),
      )

      const projectActivity = await apiRequest(
        `/customers/${customerId}?projectId=${projectId}`,
        { token, storeId: salam.id },
      )
      assert.deepEqual(
        projectActivity.body.customer.recent_sales.map((sale) => sale.document_number),
        ['SHOWROOM-PROJECT'],
      )
      assert.deepEqual(
        projectActivity.body.customer.recent_movements.map((movement) => movement.notes),
        ['بيع المشروع'],
      )
      assert.equal(projectActivity.body.customer.recent_sales[0].store_id, showroom.id)

      const anotherCustomer = await apiRequest('/customers', {
        token,
        storeId: salam.id,
        method: 'POST',
        body: { name: 'عميل آخر' },
      })
      await assert.rejects(
        pool.query(
          `
            INSERT INTO sales (
              store_id, customer_id, customer_project_id, business_date, status
            ) VALUES ($1, $2, $3, CURRENT_DATE, 'recorded')
          `,
          [showroom.id, anotherCustomer.body.customer.id, projectId],
        ),
        (error) => error?.code === '23503',
      )

      const anonymousSale = await pool.query(
        `
          INSERT INTO sales (store_id, customer_id, customer_project_id, business_date, status)
          VALUES ($1, NULL, NULL, CURRENT_DATE, 'paid')
          RETURNING customer_id, customer_project_id
        `,
        [salam.id],
      )
      assert.equal(anonymousSale.rows[0].customer_id, null)
      assert.equal(anonymousSale.rows[0].customer_project_id, null)

      const ledgerRow = await pool.query(
        'SELECT id FROM customer_ledger WHERE customer_id = $1 ORDER BY id LIMIT 1',
        [customerId],
      )
      await assert.rejects(
        pool.query(
          'UPDATE customer_ledger SET amount_ils = amount_ils + 1 WHERE id = $1',
          [ledgerRow.rows[0].id],
        ),
        (error) => error?.code === '55000',
      )

      const createdSupplier = await apiRequest('/suppliers', {
        token,
        storeId: salam.id,
        method: 'POST',
        body: {
          name: 'شركة النور',
          phone: '022900000',
          address: 'الخليل',
          notes: 'مورد مشترك',
          balance: '999999',
        },
      })
      assert.equal(createdSupplier.response.status, 201)
      const supplierId = createdSupplier.body.supplier.id

      const supplierFromOtherStore = await apiRequest('/suppliers?search=022900000', {
        token,
        storeId: showroom.id,
      })
      assert.equal(supplierFromOtherStore.body.suppliers.length, 1)
      assert.equal(supplierFromOtherStore.body.suppliers[0].id, supplierId)

      await pool.query(
        `
          INSERT INTO supplier_ledger (
            store_id, supplier_id, direction, amount_ils,
            occurred_at, source_type, notes
          ) VALUES
            ($1, $3, 'credit', 3000, NOW() - INTERVAL '1 day', 'purchase', 'السلام'),
            ($2, $3, 'credit', 2000, NOW(), 'purchase', 'المعرض')
        `,
        [salam.id, showroom.id, supplierId],
      )

      const supplierDetail = await apiRequest(`/suppliers/${supplierId}`, {
        token,
        storeId: showroom.id,
      })
      assert.equal(supplierDetail.body.supplier.balance_ils, '5000')
      assert.equal(supplierDetail.body.supplier.balances, undefined)
      assert.deepEqual(
        supplierDetail.body.supplier.store_balances.map((balance) => balance.amount_ils),
        ['3000', '2000'],
      )
      assert.deepEqual(
        new Set(supplierDetail.body.supplier.recent_movements.map((row) => row.store_id)),
        new Set([salam.id, showroom.id]),
      )

      const supplierSalamActivity = await apiRequest(
        `/suppliers/${supplierId}?storeId=${salam.id}`,
        { token, storeId: showroom.id },
      )
      assert.equal(supplierSalamActivity.body.supplier.balance_ils, '5000')
      assert.equal(supplierSalamActivity.body.supplier.recent_movements.length, 1)
      assert.equal(
        supplierSalamActivity.body.supplier.recent_movements[0].store_id,
        salam.id,
      )

      const columns = await pool.query(
        `
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (
              (table_name IN ('customers', 'customer_projects', 'suppliers')
                AND column_name = 'store_id')
              OR
              (table_name IN ('customer_ledger', 'supplier_ledger')
                AND column_name IN ('amount', 'currency_code'))
            )
        `,
      )
      assert.equal(columns.rowCount, 0)

      const ledgerColumns = await pool.query(
        `
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('customer_ledger', 'supplier_ledger')
            AND column_name = 'amount_ils'
          ORDER BY table_name
        `,
      )
      assert.equal(ledgerColumns.rowCount, 2)

      await pool.query(
        `
          INSERT INTO financial_movements (
            store_id, direction, amount, currency_code,
            occurred_at, source_type, description
          ) VALUES
            ($1, 'inflow', 2000, 'ILS', NOW(), 'verification', 'شيكل'),
            ($1, 'inflow', 500, 'USD', NOW(), 'verification', 'دولار'),
            ($1, 'inflow', 200, 'JOD', NOW(), 'verification', 'دينار')
        `,
        [salam.id],
      )
      const physicalCashCurrencies = await pool.query(
        `
          SELECT currency_code, SUM(amount)::TEXT AS amount
          FROM financial_movements
          WHERE source_type = 'verification' AND store_id = $1
          GROUP BY currency_code
          ORDER BY currency_code
        `,
        [salam.id],
      )
      assert.deepEqual(physicalCashCurrencies.rows, [
        { currency_code: 'ILS', amount: '2000' },
        { currency_code: 'JOD', amount: '200' },
        { currency_code: 'USD', amount: '500' },
      ])

      async function apiRequest(path, options) {
        const headers = new Headers(options.body ? { 'Content-Type': 'application/json' } : undefined)
        headers.set('Authorization', `Bearer ${options.token}`)
        if (options.storeId) headers.set('X-Store-Id', options.storeId)
        return jsonRequest(`${baseUrl}${path}`, {
          method: options.method,
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
        })
      }
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await pool.end()
    }
  },
)

async function jsonRequest(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}
