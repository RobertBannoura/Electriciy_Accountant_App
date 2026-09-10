import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import Decimal from 'decimal.js'

const databaseUrl = process.env.GROUP7_INTEGRATION_DATABASE_URL
const D = Decimal.clone({ precision: 100 })

test(
  'Group 7 supplier returns reverse historical purchase cost safely in PostgreSQL',
  { skip: databaseUrl ? false : 'GROUP7_INTEGRATION_DATABASE_URL is not configured' },
  async (t) => {
    process.env.DATABASE_URL = databaseUrl
    process.env.NODE_ENV = 'test'
    const [{ app }, { pool }, { provisionAdmin }] = await Promise.all([
      import('../src/app.js'), import('../src/db/pool.js'), import('../src/auth/provision-admin.js'),
    ])
    const adminUsername = 'group7_return_integration_admin'
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
      const stores = await apiRequest(baseUrl, '/stores', { token })
      const store = stores.body.stores.find((row) => row.code === 'AL_SALAM_ELECTRIC')
      assert.ok(store)
      const storeId = store.id
      const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const category = await apiRequest(baseUrl, '/categories', {
        token, method: 'POST', body: { name: `Supplier return cost QA ${unique}` },
      })
      assert.equal(category.response.status, 201)
      const categoryId = category.body.category.id
      const customer = await apiRequest(baseUrl, '/customers', {
        token, storeId, method: 'POST', body: { name: `Return cost customer ${unique}` },
      })
      assert.equal(customer.response.status, 201)
      const customerId = customer.body.customer.id

      const createSupplier = async (label) => {
        const result = await apiRequest(baseUrl, '/suppliers', {
          token, storeId, method: 'POST', body: { name: `${label} ${unique}` },
        })
        assert.equal(result.response.status, 201)
        return result.body.supplier
      }
      const createProduct = async (label) => {
        const result = await apiRequest(baseUrl, '/products', {
          token, method: 'POST', body: {
            name: `${label} ${unique}`, categoryId, saleUnit: 'قطعة',
            currentPurchasePrice: '0', defaultSalePrice: '30',
            inventorySettings: [{ storeId, reorderLevel: '0', openingQuantity: '0' }],
          },
        })
        assert.equal(result.response.status, 201)
        return result.body.product
      }
      const purchase = async ({ supplierId, productId, quantity, cost, label }) => {
        const result = await apiRequest(baseUrl, '/purchases', {
          token, storeId, method: 'POST', body: {
            supplierId, documentNumber: `${label}-${unique}`, businessDate: '2026-09-09',
            items: [{ productId, quantity, purchasePrice: cost }], payments: [],
          },
        })
        assert.equal(result.response.status, 201, JSON.stringify(result.body))
        return result.body.purchase
      }
      const sale = async ({ productId, quantity, label }) => {
        const result = await apiRequest(baseUrl, '/sales', {
          token, storeId, method: 'POST', body: {
            invoiceNumber: `${label}-${unique}`, date: '2026-09-09', customerId,
            invoiceDiscount: '0',
            items: [{ productId, quantity, actualPrice: '30', discount: '0' }],
            payments: [],
          },
        })
        assert.equal(result.response.status, 201, JSON.stringify(result.body))
        return result.body.sale
      }
      const supplierReturn = ({ purchaseId, purchaseItemId, quantity }) => apiRequest(
        baseUrl,
        '/returns/supplier',
        {
          token, storeId, method: 'POST', body: {
            sourceDocumentId: purchaseId,
            items: [{ sourceItemId: purchaseItemId, quantity }],
          },
        },
      )

      await t.test('partial and cross-purchase returns use immutable historical line cost', async () => {
        const supplier = await createSupplier('Historical supplier')
        const product = await createProduct('Historical product')
        const first = await purchase({
          supplierId: supplier.id, productId: product.id, quantity: '10', cost: '10', label: 'HIST-P1',
        })
        const second = await purchase({
          supplierId: supplier.id, productId: product.id, quantity: '10', cost: '20', label: 'HIST-P2',
        })

        await assertInventory(pool, storeId, product.id, '20', '300', '15')
        money(await supplierBalance(pool, supplier.id), '300')

        const returned = await supplierReturn({
          purchaseId: second.id, purchaseItemId: second.items[0].id, quantity: '5',
        })
        assert.equal(returned.response.status, 201, JSON.stringify(returned.body))
        money(returned.body.return.total, '100')
        money(returned.body.return.inventory_cost_total, '100')
        money(returned.body.return.cost_variance, '0')
        await assertInventory(pool, storeId, product.id, '15', '200', '13.333333333333')
        money(await supplierBalance(pool, supplier.id), '200')

        const persistedReturnLine = (await pool.query(
          `SELECT quantity::TEXT AS quantity,
            purchase_unit_cost_snapshot::TEXT AS purchase_unit_cost_snapshot,
            unit_inventory_cost_snapshot::TEXT AS unit_inventory_cost_snapshot,
            line_total::TEXT AS line_total, inventory_cost_total::TEXT AS inventory_cost_total
           FROM supplier_return_items WHERE purchase_item_id = $1::BIGINT`,
          [second.items[0].id],
        )).rows[0]
        money(persistedReturnLine.quantity, '5')
        money(persistedReturnLine.purchase_unit_cost_snapshot, '20')
        money(persistedReturnLine.unit_inventory_cost_snapshot, '20')
        money(persistedReturnLine.line_total, '100')
        money(persistedReturnLine.inventory_cost_total, '100')

        const originalSecond = (await pool.query(
          'SELECT quantity::TEXT AS quantity, unit_cost::TEXT AS unit_cost FROM purchase_items WHERE id = $1',
          [second.items[0].id],
        )).rows[0]
        money(originalSecond.quantity, '10')
        money(originalSecond.unit_cost, '20')

        const savedSale = await sale({ productId: product.id, quantity: '1', label: 'HIST-SALE' })
        money(savedSale.items[0].unit_cost_snapshot, '13.333333333333')
        const profitBefore = (await pool.query(
          `SELECT sale_items.unit_cost_snapshot::TEXT AS unit_cost_snapshot,
            sale_items.cost_total::TEXT AS item_cost_total,
            sales.cost_total::TEXT AS sale_cost_total,
            sales.gross_profit::TEXT AS gross_profit
           FROM sale_items INNER JOIN sales ON sales.id = sale_items.sale_id
           WHERE sale_items.id = $1::BIGINT`,
          [savedSale.items[0].id],
        )).rows[0]

        const fromFirst = await supplierReturn({
          purchaseId: first.id, purchaseItemId: first.items[0].id, quantity: '1',
        })
        assert.equal(fromFirst.response.status, 201, JSON.stringify(fromFirst.body))
        money(fromFirst.body.return.inventory_cost_total, '10')
        await assertInventory(pool, storeId, product.id, '13', '176.666666666667', '13.589743589744')
        const profitAfter = (await pool.query(
          `SELECT sale_items.unit_cost_snapshot::TEXT AS unit_cost_snapshot,
            sale_items.cost_total::TEXT AS item_cost_total,
            sales.cost_total::TEXT AS sale_cost_total,
            sales.gross_profit::TEXT AS gross_profit
           FROM sale_items INNER JOIN sales ON sales.id = sale_items.sale_id
           WHERE sale_items.id = $1::BIGINT`,
          [savedSale.items[0].id],
        )).rows[0]
        assert.deepEqual(profitAfter, profitBefore)

        const beforeRejected = await inventory(pool, storeId, product.id)
        const balanceBeforeRejected = await supplierBalance(pool, supplier.id)
        const excessive = await supplierReturn({
          purchaseId: second.id, purchaseItemId: second.items[0].id, quantity: '6',
        })
        assert.equal(excessive.response.status, 409)
        assert.equal(excessive.body.error.code, 'RETURN_QUANTITY_EXCEEDED')
        assert.deepEqual(await inventory(pool, storeId, product.id), beforeRejected)
        money(await supplierBalance(pool, supplier.id), balanceBeforeRejected)

        const returnedSources = await pool.query(
          `SELECT purchase_item_id::TEXT AS purchase_item_id, SUM(quantity)::TEXT AS quantity
           FROM supplier_return_items
           WHERE purchase_item_id = ANY($1::BIGINT[])
           GROUP BY purchase_item_id ORDER BY purchase_item_id`,
          [[first.items[0].id, second.items[0].id]],
        )
        assert.equal(returnedSources.rowCount, 2)
      })

      await t.test('a full supplier return clears quantity, value, debt, and preserves purchase', async () => {
        const supplier = await createSupplier('Full return supplier')
        const product = await createProduct('Full return product')
        const original = await purchase({
          supplierId: supplier.id, productId: product.id, quantity: '4', cost: '12.5', label: 'FULL',
        })
        const returned = await supplierReturn({
          purchaseId: original.id, purchaseItemId: original.items[0].id, quantity: '4',
        })
        assert.equal(returned.response.status, 201, JSON.stringify(returned.body))
        money(returned.body.return.total, '50')
        money(returned.body.return.inventory_cost_total, '50')
        money(returned.body.return.cost_variance, '0')
        await assertInventory(pool, storeId, product.id, '0', '0', '0')
        money(await supplierBalance(pool, supplier.id), '0')
        const originalLine = (await pool.query(
          'SELECT quantity::TEXT AS quantity, unit_cost::TEXT AS unit_cost FROM purchase_items WHERE id = $1',
          [original.items[0].id],
        )).rows[0]
        money(originalLine.quantity, '4')
        money(originalLine.unit_cost, '12.5')
      })

      await t.test('return cannot exceed current on-hand inventory after sales', async () => {
        const supplier = await createSupplier('Stock guard supplier')
        const product = await createProduct('Stock guard product')
        const original = await purchase({
          supplierId: supplier.id, productId: product.id, quantity: '10', cost: '10', label: 'STOCK',
        })
        await sale({ productId: product.id, quantity: '8', label: 'STOCK-SALE' })
        await assertInventory(pool, storeId, product.id, '2', '20', '10')
        const rejected = await supplierReturn({
          purchaseId: original.id, purchaseItemId: original.items[0].id, quantity: '5',
        })
        assert.equal(rejected.response.status, 409)
        assert.equal(rejected.body.error.code, 'INSUFFICIENT_INVENTORY')
        await assertInventory(pool, storeId, product.id, '2', '20', '10')
        money(await supplierBalance(pool, supplier.id), '100')
        assert.equal((await pool.query(
          'SELECT COUNT(*)::INTEGER AS count FROM supplier_returns WHERE purchase_id = $1',
          [original.id],
        )).rows[0].count, 0)
      })

      await t.test('concurrent returns cannot exceed the original line quantity', async () => {
        const supplier = await createSupplier('Concurrent original supplier')
        const product = await createProduct('Concurrent original product')
        const original = await purchase({
          supplierId: supplier.id, productId: product.id, quantity: '10', cost: '10', label: 'CONCURRENT-ORIGINAL',
        })
        await purchase({
          supplierId: supplier.id, productId: product.id, quantity: '10', cost: '10', label: 'CONCURRENT-RESERVE',
        })
        const responses = await Promise.all([
          supplierReturn({ purchaseId: original.id, purchaseItemId: original.items[0].id, quantity: '6' }),
          supplierReturn({ purchaseId: original.id, purchaseItemId: original.items[0].id, quantity: '6' }),
        ])
        assert.deepEqual(responses.map(({ response }) => response.status).sort(), [201, 409])
        assert.equal(responses.find(({ response }) => response.status === 409).body.error.code, 'RETURN_QUANTITY_EXCEEDED')
        await assertInventory(pool, storeId, product.id, '14', '140', '10')
        money(await supplierBalance(pool, supplier.id), '140')
        const returned = await pool.query(
          'SELECT COALESCE(SUM(quantity), 0)::TEXT AS quantity FROM supplier_return_items WHERE purchase_item_id = $1',
          [original.items[0].id],
        )
        money(returned.rows[0].quantity, '6')
      })

      await t.test('concurrent returns cannot exceed current physical stock', async () => {
        const supplier = await createSupplier('Concurrent stock supplier')
        const product = await createProduct('Concurrent stock product')
        const original = await purchase({
          supplierId: supplier.id, productId: product.id, quantity: '10', cost: '10', label: 'CONCURRENT-STOCK',
        })
        await sale({ productId: product.id, quantity: '4', label: 'CONCURRENT-STOCK-SALE' })
        const responses = await Promise.all([
          supplierReturn({ purchaseId: original.id, purchaseItemId: original.items[0].id, quantity: '4' }),
          supplierReturn({ purchaseId: original.id, purchaseItemId: original.items[0].id, quantity: '4' }),
        ])
        assert.deepEqual(responses.map(({ response }) => response.status).sort(), [201, 409])
        assert.equal(responses.find(({ response }) => response.status === 409).body.error.code, 'INSUFFICIENT_INVENTORY')
        await assertInventory(pool, storeId, product.id, '2', '20', '10')
        money(await supplierBalance(pool, supplier.id), '60')
        const returned = await pool.query(
          'SELECT COALESCE(SUM(quantity), 0)::TEXT AS quantity FROM supplier_return_items WHERE purchase_item_id = $1',
          [original.items[0].id],
        )
        money(returned.rows[0].quantity, '4')
      })

      await t.test('late supplier-ledger failure rolls back inventory and supplier credit', async () => {
        const supplier = await createSupplier('Rollback supplier')
        const product = await createProduct('Rollback product')
        const original = await purchase({
          supplierId: supplier.id, productId: product.id, quantity: '5', cost: '10', label: 'ROLLBACK',
        })
        const safeId = `${Date.now()}${Math.random().toString(16).slice(2)}`
        const triggerName = `group7_supplier_return_fail_${safeId}`
        const functionName = `${triggerName}_fn`
        await pool.query(`
          CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.supplier_id = ${supplier.id}::BIGINT AND NEW.source_type = 'supplier_return' THEN
              RAISE EXCEPTION 'forced Group 7 supplier return rollback';
            END IF;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON supplier_ledger
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
        `)
        let failed
        try {
          failed = await supplierReturn({
            purchaseId: original.id, purchaseItemId: original.items[0].id, quantity: '2',
          })
        } finally {
          await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON supplier_ledger`)
          await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`)
        }
        assert.equal(failed.response.status, 500)
        await assertInventory(pool, storeId, product.id, '5', '50', '10')
        money(await supplierBalance(pool, supplier.id), '50')
        assert.equal((await pool.query(
          'SELECT COUNT(*)::INTEGER AS count FROM supplier_returns WHERE purchase_id = $1',
          [original.id],
        )).rows[0].count, 0)
        assert.equal((await pool.query(
          "SELECT COUNT(*)::INTEGER AS count FROM inventory_movements WHERE source_type = 'supplier_return' AND product_id = $1",
          [product.id],
        )).rows[0].count, 0)
      })
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await pool.end()
    }
  },
)

async function inventory(pool, storeId, productId) {
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
  return result.rows[0]
}

async function assertInventory(pool, storeId, productId, quantity, value, average) {
  const actual = await inventory(pool, storeId, productId)
  money(actual.quantity, quantity)
  money(actual.inventory_value, value)
  money(actual.weighted_average_cost, average)
}

async function supplierBalance(pool, supplierId) {
  const result = await pool.query(
    'SELECT balance_ils::TEXT AS balance FROM supplier_balances WHERE supplier_id = $1::BIGINT',
    [supplierId],
  )
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
