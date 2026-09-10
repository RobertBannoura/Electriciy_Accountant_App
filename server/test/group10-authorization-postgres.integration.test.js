import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'

const databaseUrl = process.env.GROUP10_INTEGRATION_DATABASE_URL

test(
  'Group 10 authorization and relationship boundaries hold in disposable PostgreSQL',
  { skip: databaseUrl ? false : 'GROUP10_INTEGRATION_DATABASE_URL is not configured' },
  async (t) => {
    process.env.DATABASE_URL = databaseUrl
    process.env.NODE_ENV = 'test'

    const [{ app }, { pool }, { hashPassword }] = await Promise.all([
      import('../src/app.js'),
      import('../src/db/pool.js'),
      import('../src/auth/password.js'),
    ])

    await assertDisposableDatabase(pool)
    const password = randomBytes(32).toString('base64url')
    await pool.query(
      `INSERT INTO users (username, password_hash, display_name, role, is_active)
       VALUES ('group10_admin', $1, 'Group 10 disposable admin', 'admin', TRUE)`,
      [await hashPassword(password)],
    )

    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${address.port}/api`
    let token

    const api = (path, options = {}) => apiRequest(baseUrl, path, { token, ...options })

    try {
      const login = await jsonRequest(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'group10_admin', password }),
      })
      assert.equal(login.response.status, 201, JSON.stringify(login.body))
      token = login.body.token

      const stores = (await api('/stores')).body.stores
      const storeOne = stores[0]
      const storeTwo = stores[1]
      assert.ok(storeOne && storeTwo)

      const category = await create(api, '/categories', {
        name: 'Group 10 authorization category',
      })
      const product = await create(api, '/products', {
        name: 'Group 10 two-store product',
        categoryId: category.id,
        saleUnit: 'قطعة',
        currentPurchasePrice: '10',
        defaultSalePrice: '20',
        inventorySettings: [
          { storeId: storeOne.id, reorderLevel: '2', openingQuantity: '50' },
          { storeId: storeTwo.id, reorderLevel: '2', openingQuantity: '50' },
        ],
      })
      const storeTwoOnlyProduct = await create(api, '/products', {
        name: 'Group 10 store-two-only product',
        categoryId: category.id,
        saleUnit: 'قطعة',
        currentPurchasePrice: '5',
        defaultSalePrice: '12',
        inventorySettings: [
          { storeId: storeTwo.id, reorderLevel: '1', openingQuantity: '10' },
        ],
      })

      const customerOne = await create(api, '/customers', { name: 'Group 10 customer one' }, storeOne.id)
      const customerTwo = await create(api, '/customers', { name: 'Group 10 customer two' }, storeOne.id)
      const customerNoDebt = await create(api, '/customers', { name: 'Group 10 no-debt customer' }, storeOne.id)
      const projectTwo = await create(
        api,
        `/customers/${customerTwo.id}/projects`,
        { name: 'Group 10 customer-two project' },
        storeOne.id,
      )
      const supplierOne = await create(api, '/suppliers', { name: 'Group 10 supplier one' }, storeOne.id)
      const supplierNoDebt = await create(api, '/suppliers', { name: 'Group 10 no-debt supplier' }, storeOne.id)

      const saleOne = await createSale(api, storeOne.id, {
        invoiceNumber: 'G10-SALE-ONE', customerId: customerOne.id,
        productId: product.id, quantity: '2', price: '20',
      })
      const saleTwo = await createSale(api, storeOne.id, {
        invoiceNumber: 'G10-SALE-TWO', customerId: customerTwo.id,
        productId: product.id, quantity: '1', price: '20',
      })
      const saleOtherStore = await createSale(api, storeTwo.id, {
        invoiceNumber: 'G10-SALE-OTHER-STORE', customerId: customerOne.id,
        productId: product.id, quantity: '1', price: '20',
      })
      const purchaseOne = await createPurchase(api, storeOne.id, supplierOne.id, product.id, 'G10-PURCHASE-ONE')
      const purchaseTwo = await createPurchase(api, storeOne.id, supplierOne.id, product.id, 'G10-PURCHASE-TWO')
      const maintenance = await create(api, '/maintenance', {
        customerId: customerOne.id,
        itemDescription: 'Group 10 maintenance item',
        maintenanceDetails: 'Authorization boundary test',
        amount: '10',
        date: '2026-09-10',
        payments: [],
      }, storeOne.id)
      const checkPayment = await create(api, `/customers/${customerOne.id}/payments`, {
        payments: [{
          method: 'check', currency: 'ILS', amount: '5',
          checkNumber: 'G10-CHECK-ONE', dueDate: '2026-12-31',
        }],
      }, storeOne.id)
      const checkId = checkPayment.payments[0].id

      await t.test('SQL injection probes are inert and mass-assigned fields never reach PostgreSQL', async () => {
        const before = await pool.query(
          `SELECT
             (SELECT COUNT(*)::INTEGER FROM users) AS users,
             (SELECT COUNT(*)::INTEGER FROM customers) AS customers,
             (SELECT COUNT(*)::INTEGER FROM schema_migrations) AS migrations`,
        )
        const injectionPayloads = ["'", "' OR '1'='1", "'; DROP TABLE users; --", '%27']

        for (const payload of injectionPayloads) {
          const search = await api(`/customers?search=${encodeURIComponent(payload)}`, {
            storeId: storeOne.id,
          })
          assert.equal(search.response.status, 200, JSON.stringify(search.body))
          assert.deepEqual(search.body.customers, [])

          const pathProbe = await api(`/customers/${encodeURIComponent(payload)}`, {
            storeId: storeOne.id,
          })
          assertError(pathProbe, 400, 'INVALID_CUSTOMER_ID')
        }

        const afterProbes = await pool.query(
          `SELECT
             (SELECT COUNT(*)::INTEGER FROM users) AS users,
             (SELECT COUNT(*)::INTEGER FROM customers) AS customers,
             (SELECT COUNT(*)::INTEGER FROM schema_migrations) AS migrations`,
        )
        assert.deepEqual(afterProbes.rows, before.rows)

        const xssPayload = '<script>alert(1)</script>'
        const created = await api('/customers', {
          method: 'POST',
          storeId: storeOne.id,
          body: {
            name: xssPayload,
            balance: '999999',
            role: 'admin',
            store_id: storeTwo.id,
            storeId: storeTwo.id,
          },
        })
        assert.equal(created.response.status, 201, JSON.stringify(created.body))
        assert.equal(created.body.customer.name, xssPayload)
        assert.equal(Object.hasOwn(created.body.customer, 'role'), false)
        assert.equal(Object.hasOwn(created.body.customer, 'store_id'), false)
        assert.equal((await pool.query(
          'SELECT name FROM customers WHERE id = $1::BIGINT',
          [created.body.customer.id],
        )).rows[0].name, xssPayload)
      })

      await t.test('validated header store controls manual inventory and rejected writes are inert', async () => {
        const before = await inventoryFacts(pool, product.id, storeOne.id, storeTwo.id)
        const body = {
          storeId: storeOne.id,
          movementType: 'correction',
          quantityDelta: '1',
          reason: 'Group 10 authorized adjustment',
        }

        const missing = await api(`/products/${product.id}/inventory-movements`, {
          method: 'POST', body,
        })
        assertError(missing, 400, 'STORE_CONTEXT_REQUIRED')

        const malformed = await api(`/products/${product.id}/inventory-movements`, {
          method: 'POST', storeId: 'not-a-store', body,
        })
        assertError(malformed, 400, 'STORE_CONTEXT_REQUIRED')

        const nonexistent = await api(`/products/${product.id}/inventory-movements`, {
          method: 'POST', storeId: '999999999999',
          body: { ...body, storeId: '999999999999' },
        })
        assertError(nonexistent, 404, 'STORE_NOT_FOUND')

        const mismatch = await api(`/products/${product.id}/inventory-movements`, {
          method: 'POST', storeId: storeOne.id,
          body: { ...body, storeId: storeTwo.id },
        })
        assertError(mismatch, 409, 'STORE_CONTEXT_MISMATCH')
        assert.deepEqual(await inventoryFacts(pool, product.id, storeOne.id, storeTwo.id), before)

        await pool.query('UPDATE stores SET is_active = FALSE WHERE id = $1::BIGINT', [storeTwo.id])
        const inactive = await api(`/products/${product.id}/inventory-movements`, {
          method: 'POST', storeId: storeTwo.id,
          body: { ...body, storeId: storeTwo.id },
        })
        assertError(inactive, 404, 'STORE_NOT_FOUND')
        assertError(
          await api(`/products?storeId=${storeTwo.id}`),
          404,
          'STORE_NOT_FOUND',
        )
        assertError(
          await api(`/products/${product.id}/inventory-movements?storeId=${storeTwo.id}`),
          404,
          'STORE_NOT_FOUND',
        )
        await pool.query('UPDATE stores SET is_active = TRUE WHERE id = $1::BIGINT', [storeTwo.id])
        assert.deepEqual(await inventoryFacts(pool, product.id, storeOne.id, storeTwo.id), before)

        const accepted = await api(`/products/${product.id}/inventory-movements`, {
          method: 'POST', storeId: storeOne.id, body,
        })
        assert.equal(accepted.response.status, 201, JSON.stringify(accepted.body))
        const after = await inventoryFacts(pool, product.id, storeOne.id, storeTwo.id)
        assert.equal(Number(after.storeOneQuantity), Number(before.storeOneQuantity) + 1)
        assert.equal(after.storeTwoQuantity, before.storeTwoQuantity)
        assert.equal(after.manualMovementCount, before.manualMovementCount + 1)
      })

      await t.test('customer/project and store/product substitutions are rejected atomically', async () => {
        const saleCount = await count(pool, 'sales')
        const wrongProject = await api('/sales', {
          method: 'POST', storeId: storeOne.id,
          body: saleBody({
            invoiceNumber: 'G10-WRONG-PROJECT', customerId: customerOne.id,
            customerProjectId: projectTwo.id, productId: product.id,
          }),
        })
        assertError(wrongProject, 404, 'SALE_PROJECT_NOT_FOUND')

        const wrongStoreProduct = await api('/sales', {
          method: 'POST', storeId: storeOne.id,
          body: saleBody({
            invoiceNumber: 'G10-WRONG-STORE-PRODUCT', customerId: customerOne.id,
            productId: storeTwoOnlyProduct.id,
          }),
        })
        assertError(wrongStoreProduct, 404, 'SALE_PRODUCT_NOT_AVAILABLE')
        assert.equal(await count(pool, 'sales'), saleCount)

        const bodyStoreCannotOverride = await api('/sales', {
          method: 'POST', storeId: storeOne.id,
          body: { ...saleBody({
            invoiceNumber: 'G10-BODY-STORE-IGNORED', customerId: customerOne.id,
            productId: product.id,
          }), storeId: storeTwo.id },
        })
        assert.equal(bodyStoreCannotOverride.response.status, 201, JSON.stringify(bodyStoreCannotOverride.body))
        assert.equal(bodyStoreCannotOverride.body.sale.store_id, storeOne.id)

        const statement = await api(
          `/customers/${customerOne.id}/statement?projectId=${projectTwo.id}`,
          { storeId: storeOne.id },
        )
        assertError(statement, 404, 'CUSTOMER_PROJECT_NOT_FOUND')
      })

      await t.test('sale and purchase return lines cannot be substituted across parents or stores', async () => {
        const before = {
          customerReturns: await count(pool, 'customer_returns'),
          supplierReturns: await count(pool, 'supplier_returns'),
          inventory: await inventoryFacts(pool, product.id, storeOne.id, storeTwo.id),
        }
        const wrongSaleLine = await api('/returns/customer', {
          method: 'POST', storeId: storeOne.id,
          body: {
            sourceDocumentId: saleOne.id,
            items: [{ sourceItemId: saleTwo.items[0].id, quantity: '1' }],
          },
        })
        assertError(wrongSaleLine, 409, 'RETURN_ITEM_NOT_IN_SALE')

        const wrongStoreSale = await api('/returns/customer', {
          method: 'POST', storeId: storeOne.id,
          body: {
            sourceDocumentId: saleOtherStore.id,
            items: [{ sourceItemId: saleOtherStore.items[0].id, quantity: '1' }],
          },
        })
        assertError(wrongStoreSale, 404, 'SALE_NOT_FOUND')

        const wrongPurchaseLine = await api('/returns/supplier', {
          method: 'POST', storeId: storeOne.id,
          body: {
            sourceDocumentId: purchaseOne.id,
            items: [{ sourceItemId: purchaseTwo.items[0].id, quantity: '1' }],
          },
        })
        assertError(wrongPurchaseLine, 409, 'RETURN_ITEM_NOT_IN_PURCHASE')
        assert.equal(await count(pool, 'customer_returns'), before.customerReturns)
        assert.equal(await count(pool, 'supplier_returns'), before.supplierReturns)
        assert.deepEqual(await inventoryFacts(pool, product.id, storeOne.id, storeTwo.id), before.inventory)
      })

      await t.test('checks, payments, and maintenance cannot cross store or account relationships', async () => {
        const checkBefore = await pool.query(
          'SELECT status, supplier_id::TEXT AS supplier_id FROM checks WHERE id = $1::BIGINT',
          [checkId],
        )
        const crossStoreClear = await api(`/checks/${checkId}/clear`, {
          method: 'POST', storeId: storeTwo.id, body: {},
        })
        assertError(crossStoreClear, 404, 'CHECK_NOT_FOUND')

        const invalidSupplier = await api(`/checks/${checkId}/transfer`, {
          method: 'POST', storeId: storeOne.id,
          body: { supplierId: '999999999999', transferDate: '2026-09-10' },
        })
        assertError(invalidSupplier, 404, 'SUPPLIER_NOT_FOUND')
        assert.deepEqual((await pool.query(
          'SELECT status, supplier_id::TEXT AS supplier_id FROM checks WHERE id = $1::BIGINT',
          [checkId],
        )).rows, checkBefore.rows)

        const transferred = await api(`/checks/${checkId}/transfer`, {
          method: 'POST', storeId: storeOne.id,
          body: { supplierId: supplierOne.id, transferDate: '2026-09-10' },
        })
        assert.equal(transferred.response.status, 201, JSON.stringify(transferred.body))
        const reused = await api(`/checks/${checkId}/transfer`, {
          method: 'POST', storeId: storeOne.id,
          body: { supplierId: supplierOne.id, transferDate: '2026-09-10' },
        })
        assertError(reused, 409, 'CHECK_ALREADY_TRANSFERRED')
        assert.equal((await pool.query(
          `SELECT COUNT(*)::INTEGER AS count FROM supplier_ledger
           WHERE source_type = 'check_transfer' AND source_id = $1::BIGINT`,
          [checkId],
        )).rows[0].count, 1)

        const paymentsBefore = await count(pool, 'payments')
        const wrongCustomer = await api(`/customers/${customerNoDebt.id}/payments`, {
          method: 'POST', storeId: storeOne.id,
          body: {
            customerId: customerOne.id,
            payments: [{ method: 'cash', currency: 'ILS', amount: '1' }],
          },
        })
        assertError(wrongCustomer, 409, 'CUSTOMER_PAYMENT_EXCEEDS_DEBT')
        const wrongSupplier = await api(`/suppliers/${supplierNoDebt.id}/payments`, {
          method: 'POST', storeId: storeOne.id,
          body: {
            supplierId: supplierOne.id,
            payments: [{ method: 'cash', amount: '1' }],
          },
        })
        assertError(wrongSupplier, 409, 'SUPPLIER_PAYMENT_EXCEEDS_DEBT')
        assert.equal(await count(pool, 'payments'), paymentsBefore)

        const reversalsBefore = await count(pool, 'maintenance_reversals')
        const crossStoreReversal = await api(`/maintenance/${maintenance.id}/reversal`, {
          method: 'POST', storeId: storeTwo.id,
          body: { reason: 'Must not cross stores' },
        })
        assertError(crossStoreReversal, 404, 'MAINTENANCE_NOT_FOUND')
        assert.equal(await count(pool, 'maintenance_reversals'), reversalsBefore)
      })

      await t.test('random and sequential substitutions fail safely; admin diagnostics remain intended', async () => {
        const original = await api(`/customers/${customerOne.id}`, { storeId: storeOne.id })
        const random = await api('/customers/999999999999', { storeId: storeOne.id })
        assertError(random, 404, 'CUSTOMER_NOT_FOUND')

        const sequentialMissingId = String(Number(customerNoDebt.id) + 100000)
        const update = await api(`/customers/${sequentialMissingId}`, {
          method: 'PATCH', storeId: storeOne.id,
          body: { name: 'Must not exist' },
        })
        assertError(update, 404, 'CUSTOMER_NOT_FOUND')
        const unchanged = await api(`/customers/${customerOne.id}`, { storeId: storeOne.id })
        assert.equal(unchanged.body.customer.name, original.body.customer.name)

        const verification = await api('/verification/financial')
        assert.equal(verification.response.status, 200, JSON.stringify(verification.body))
        assert.equal(verification.body.status, 'ok')

        const migrationsBefore = await count(pool, 'schema_migrations')
        const invalidBackup = await api('/backups/verify', {
          method: 'POST', body: { schemaVersion: 999, data: {} },
        })
        assert.ok([400, 409].includes(invalidBackup.response.status), JSON.stringify(invalidBackup.body))
        assert.equal(await count(pool, 'schema_migrations'), migrationsBefore)
      })
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await pool.end()
    }
  },
)

async function assertDisposableDatabase(pool) {
  const result = await pool.query(
    'SELECT current_database() AS database, inet_server_port() AS port',
  )
  assert.match(result.rows[0].database, /^group10_authz_[a-z0-9]+$/)
  assert.ok(Number(result.rows[0].port) >= 55000)
}

async function create(api, path, body, storeId) {
  const result = await api(path, { method: 'POST', body, storeId })
  assert.equal(result.response.status, 201, `${path}: ${JSON.stringify(result.body)}`)
  return result.body.category
    ?? result.body.product
    ?? result.body.customer
    ?? result.body.project
    ?? result.body.supplier
    ?? result.body.maintenance
    ?? result.body.payment
}

async function createSale(api, storeId, values) {
  const result = await api('/sales', {
    method: 'POST', storeId, body: saleBody(values),
  })
  assert.equal(result.response.status, 201, JSON.stringify(result.body))
  return result.body.sale
}

function saleBody({ invoiceNumber, customerId, customerProjectId, productId }) {
  return {
    invoiceNumber,
    date: '2026-09-10',
    customerId,
    customerProjectId,
    invoiceDiscount: '0',
    items: [{ productId, quantity: '1', actualPrice: '20', discount: '0' }],
    payments: [],
  }
}

async function createPurchase(api, storeId, supplierId, productId, documentNumber) {
  const result = await api('/purchases', {
    method: 'POST', storeId,
    body: {
      supplierId, documentNumber, businessDate: '2026-09-10',
      items: [{ productId, quantity: '2', purchasePrice: '10' }],
      payments: [],
    },
  })
  assert.equal(result.response.status, 201, JSON.stringify(result.body))
  return result.body.purchase
}

async function inventoryFacts(pool, productId, storeOneId, storeTwoId) {
  const result = await pool.query(
    `SELECT
       (SELECT quantity::TEXT FROM store_inventory_balances
        WHERE product_id = $1::BIGINT AND store_id = $2::BIGINT) AS store_one_quantity,
       (SELECT quantity::TEXT FROM store_inventory_balances
        WHERE product_id = $1::BIGINT AND store_id = $3::BIGINT) AS store_two_quantity,
       (SELECT COUNT(*)::INTEGER FROM inventory_movements
        WHERE product_id = $1::BIGINT AND source_type = 'manual_inventory') AS manual_movement_count`,
    [productId, storeOneId, storeTwoId],
  )
  return {
    storeOneQuantity: result.rows[0].store_one_quantity,
    storeTwoQuantity: result.rows[0].store_two_quantity,
    manualMovementCount: result.rows[0].manual_movement_count,
  }
}

async function count(pool, table) {
  const allowed = new Set([
    'sales', 'customer_returns', 'supplier_returns', 'payments',
    'maintenance_reversals', 'schema_migrations',
  ])
  assert.ok(allowed.has(table))
  const result = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${table}`)
  return result.rows[0].count
}

function assertError(result, status, code) {
  assert.equal(result.response.status, status, JSON.stringify(result.body))
  assert.equal(result.body.error.code, code)
}

async function apiRequest(baseUrl, path, options) {
  const headers = new Headers(options.body === undefined
    ? undefined
    : { 'Content-Type': 'application/json' })
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`)
  if (options.storeId !== undefined) headers.set('X-Store-Id', options.storeId)
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
    headers.set('X-Request-Id', crypto.randomUUID())
  }
  return jsonRequest(`${baseUrl}${path}`, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}
