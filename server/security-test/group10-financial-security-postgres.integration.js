import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Decimal from 'decimal.js'
import { once } from 'node:events'
import test from 'node:test'

const databaseUrl = process.env.GROUP10_FINANCIAL_DATABASE_URL
if (!databaseUrl) {
  throw new Error('GROUP10_FINANCIAL_DATABASE_URL is required; this security suite never skips')
}

process.env.DATABASE_URL = databaseUrl
process.env.NODE_ENV = 'test'
process.env.CLIENT_ORIGIN = 'http://localhost:5173'

const today = '2026-09-10'
let requestSequence = 0

test('Group 10 financial integrity survives adversarial PostgreSQL concurrency and corruption', async (t) => {
  const [{ app }, { pool }, { verifyFinancialAccounts }, { provisionAdmin }] = await Promise.all([
    import('../src/app.js'),
    import('../src/db/pool.js'),
    import('../src/verification/financial-verification.js'),
    import('../src/auth/provision-admin.js'),
  ])
  await assertDisposableDatabase(pool)
  const adminUsername = 'group10_financial_admin'
  const adminPassword = randomBytes(32).toString('base64url')
  await provisionAdmin(pool, {
    username: adminUsername,
    password: adminPassword,
    displayName: 'Integration Test Admin',
  })

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`
  const login = await jsonRequest(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  })
  assert.equal(login.response.status, 201)
  const token = login.body.token
  const api = (path, options = {}) => apiRequest(baseUrl, token, path, options)

  try {
    const stores = (await api('/stores')).body.stores
    const [storeOne, storeTwo] = stores
    assert.ok(storeOne && storeTwo)
    const category = await create(api, '/categories', { name: 'G10 financial QA' })
    const customer = await create(api, '/customers', { name: 'G10 customer' }, storeOne.id)
    const supplier = await create(api, '/suppliers', { name: 'G10 supplier' }, storeOne.id)
    const supplierWithoutDebt = await create(api, '/suppliers', { name: 'G10 supplier without debt' }, storeOne.id)
    const product = await createProduct(api, category.id, [
      { storeId: storeOne.id, openingQuantity: '100' },
      { storeId: storeTwo.id, openingQuantity: '10' },
    ], 'G10 precision product')

    await t.test('backend owns totals, exact money, FX snapshots, COGS, and historical values', async () => {
      const created = await api('/sales', {
        method: 'POST', storeId: storeOne.id,
        body: {
          invoiceNumber: 'G10-PRECISION', date: today, customerId: customer.id,
          invoiceDiscount: '0.50', subtotal: '999999', total: '0.50',
          amount_ils: '0.50', customerDebt: '-999999', grossProfit: '999999',
          items: [{
            productId: product.id, quantity: '1', actualPrice: '10.50', discount: '0',
            lineTotal: '0.50', unitCostSnapshot: '0', storeId: storeTwo.id,
          }],
          payments: [{ method: 'cash', currency: 'USD', amount: '3', exchangeRate: '3.333333333333' }],
        },
      })
      assert.equal(created.response.status, 201, JSON.stringify(created.body))
      assertMoney(created.body.sale.items_subtotal, '10.5')
      assertMoney(created.body.sale.total, '10')
      assertMoney(created.body.sale.paid_total, '9.999999999999')
      assertMoney(created.body.sale.remaining_due, '0.000000000001')
      assertMoney(created.body.sale.cost_total, '2.5')
      assertMoney(created.body.sale.gross_profit, '7.5')
      const payment = await pool.query(
        `SELECT original_amount::TEXT, exchange_rate::TEXT, converted_ils_amount::TEXT
         FROM payments WHERE sale_id = $1::BIGINT`,
        [created.body.sale.id],
      )
      assertMoney(payment.rows[0].original_amount, '3')
      assertMoney(payment.rows[0].exchange_rate, '3.333333333333')
      assertMoney(payment.rows[0].converted_ils_amount, '9.999999999999')
      await assert.rejects(
        pool.query('UPDATE payments SET exchange_rate = 1 WHERE id = $1::BIGINT', [created.body.sale.payments[0].id]),
        /append-only/i,
      )

      const invalidHalfShekel = await api('/sales', {
        method: 'POST', storeId: storeOne.id,
        body: saleBody('G10-BAD-HALF', customer.id, product.id, '1', '10.25'),
      })
      assert.equal(invalidHalfShekel.response.status, 400)
    })

    await t.test('two simultaneous sales cannot consume the same final stock', async () => {
      const finalProduct = await createProduct(api, category.id, [
        { storeId: storeOne.id, openingQuantity: '1' },
      ], 'G10 final-stock product')
      const results = await Promise.all([
        api('/sales', { method: 'POST', storeId: storeOne.id, body: saleBody('G10-LAST-A', customer.id, finalProduct.id) }),
        api('/sales', { method: 'POST', storeId: storeOne.id, body: saleBody('G10-LAST-B', customer.id, finalProduct.id) }),
      ])
      assert.deepEqual(results.map((result) => result.response.status).sort(), [201, 409])
      assert.ok(new Decimal(await inventoryQuantity(pool, storeOne.id, finalProduct.id)).isZero())
      assert.equal(await countWhere(pool, 'sales', 'document_number LIKE $1', ['G10-LAST-%']), 1)
    })

    await t.test('customer and supplier payment retries are credited exactly once', async () => {
      await api('/sales', {
        method: 'POST', storeId: storeOne.id,
        body: saleBody('G10-CUSTOMER-DEBT', customer.id, product.id, '1', '20'),
      })
      const customerBefore = await customerBalance(pool, customer.id)
      const customerRequestId = 'g10-customer-payment-replay'
      const customerResults = await Promise.all([
        api(`/customers/${customer.id}/payments`, {
          method: 'POST', storeId: storeOne.id, requestId: customerRequestId,
          body: { payments: [{ method: 'cash', currency: 'ILS', amount: '5' }] },
        }),
        api(`/customers/${customer.id}/payments`, {
          method: 'POST', storeId: storeOne.id, requestId: customerRequestId,
          body: { payments: [{ method: 'cash', currency: 'ILS', amount: '5' }] },
        }),
      ])
      assert.deepEqual(customerResults.map((result) => result.response.status).sort(), [201, 409])
      assert.equal(new Decimal(customerBefore).minus(await customerBalance(pool, customer.id)).toFixed(), '5')

      await createPurchase(api, storeOne.id, supplier.id, product.id, 'G10-SUPPLIER-DEBT', '5', '10')
      const supplierBefore = await supplierBalance(pool, supplier.id)
      const supplierRequestId = 'g10-supplier-payment-replay'
      const supplierResults = await Promise.all([
        api(`/suppliers/${supplier.id}/payments`, {
          method: 'POST', storeId: storeOne.id, requestId: supplierRequestId,
          body: { payments: [{ method: 'cash', amount: '5' }] },
        }),
        api(`/suppliers/${supplier.id}/payments`, {
          method: 'POST', storeId: storeOne.id, requestId: supplierRequestId,
          body: { payments: [{ method: 'cash', amount: '5' }] },
        }),
      ])
      assert.deepEqual(supplierResults.map((result) => result.response.status).sort(), [201, 409])
      assert.equal(new Decimal(supplierBefore).minus(await supplierBalance(pool, supplier.id)).toFixed(), '5')
    })

    await t.test('check transfer, owner issue, clear, and bounce preserve one-time invariants', async () => {
      const overpay = await api('/checks/owner-issued', {
        method: 'POST', storeId: storeOne.id,
        body: { supplierId: supplier.id, checkNumber: 'G10-OVERPAY', amount: '999999', dueDate: today },
      })
      assert.equal(overpay.response.status, 409)

      const malformedGiro = await api(`/customers/${customer.id}/payments`, {
        method: 'POST', storeId: storeOne.id,
        body: { payments: [{ method: 'check', currency: 'ILS', amount: '5', checkNumber: 'G10-GIRO-MISSING-OWNER', dueDate: today, isGiro: true }] },
      })
      assert.equal(malformedGiro.response.status, 400)
      assert.equal(await countWhere(pool, 'checks', 'check_number = $1', ['G10-GIRO-MISSING-OWNER']), 0)

      const received = await api(`/customers/${customer.id}/payments`, {
        method: 'POST', storeId: storeOne.id,
        body: { payments: [{ method: 'check', currency: 'ILS', amount: '5', checkNumber: 'G10-BOUNCE', dueDate: today }] },
      })
      assert.equal(received.response.status, 201)
      const bounceId = received.body.payment.payments[0].id
      const bounceResults = await Promise.all([
        api(`/checks/${bounceId}/bounce`, { method: 'POST', storeId: storeOne.id }),
        api(`/checks/${bounceId}/bounce`, { method: 'POST', storeId: storeOne.id }),
      ])
      assert.ok(bounceResults.every((result) => result.response.status === 200))
      assert.equal(await countWhere(pool, 'customer_ledger', "source_type = 'check_bounce' AND source_id = $1", [bounceId]), 1)
      const clearBounced = await api(`/checks/${bounceId}/clear`, { method: 'POST', storeId: storeOne.id })
      assert.equal(clearBounced.response.status, 409)

      const transferable = await api(`/customers/${customer.id}/payments`, {
        method: 'POST', storeId: storeOne.id,
        body: { payments: [{
          method: 'check', currency: 'ILS', amount: '5', checkNumber: 'G10-TRANSFER', dueDate: today,
          isGiro: true, originalOwnerName: 'G10 original owner', originalOwnerPhone: '0599000000',
          supplierId: supplierWithoutDebt.id,
        }] },
      })
      const transferId = transferable.body.payment.payments[0].id
      const redirectedTransfer = await api(`/checks/${transferId}/transfer`, {
        method: 'POST', storeId: storeOne.id,
        body: {
          supplierId: supplierWithoutDebt.id, transferDate: today,
          originalOwnerName: 'attacker replacement', originalOwnerPhone: '000',
        },
      })
      assert.equal(redirectedTransfer.response.status, 409)
      assert.equal((await checkSnapshot(pool, transferId)).supplier_id, null)
      const transferResults = await Promise.all([
        api(`/checks/${transferId}/transfer`, {
          method: 'POST', storeId: storeOne.id,
          body: { supplierId: supplier.id, transferDate: today },
        }),
        api(`/checks/${transferId}/transfer`, {
          method: 'POST', storeId: storeOne.id,
          body: { supplierId: supplier.id, transferDate: today },
        }),
      ])
      assert.deepEqual(transferResults.map((result) => result.response.status).sort(), [201, 409])
      assert.equal(await countWhere(pool, 'supplier_ledger', "source_type = 'check_transfer' AND source_id = $1", [transferId]), 1)
      const transferredSnapshot = await checkSnapshot(pool, transferId)
      assert.equal(transferredSnapshot.is_giro, true)
      assert.equal(transferredSnapshot.original_owner_name, 'G10 original owner')
      assert.equal(transferredSnapshot.original_owner_phone, '0599000000')

      const transferredBounces = await Promise.all([
        api(`/checks/${transferId}/bounce`, { method: 'POST', storeId: storeOne.id }),
        api(`/checks/${transferId}/bounce`, { method: 'POST', storeId: storeOne.id }),
      ])
      assert.ok(transferredBounces.every((result) => result.response.status === 200))
      assert.equal(await countWhere(pool, 'supplier_ledger', "source_type = 'check_transfer_bounce' AND source_id = $1", [transferId]), 1)
      assert.equal(await countWhere(pool, 'customer_ledger', "source_type = 'check_bounce' AND source_id = $1", [transferId]), 1)

      const clearable = await api(`/customers/${customer.id}/payments`, {
        method: 'POST', storeId: storeOne.id,
        body: { payments: [{ method: 'check', currency: 'ILS', amount: '5', checkNumber: 'G10-CLEAR', dueDate: today }] },
      })
      const clearId = clearable.body.payment.payments[0].id
      const clearResults = await Promise.all([
        api(`/checks/${clearId}/clear`, { method: 'POST', storeId: storeOne.id }),
        api(`/checks/${clearId}/clear`, { method: 'POST', storeId: storeOne.id }),
      ])
      assert.ok(clearResults.every((result) => result.response.status === 200))
      assert.equal((await checkState(pool, clearId)).status, 'cleared')
      assert.equal((await api(`/checks/${clearId}/bounce`, { method: 'POST', storeId: storeOne.id })).response.status, 409)

      const ownerRequestId = 'g10-owner-check-replay'
      const ownerBody = { supplierId: supplier.id, checkNumber: 'G10-OWNER', amount: '5', dueDate: today }
      const ownerResults = await Promise.all([
        api('/checks/owner-issued', { method: 'POST', storeId: storeOne.id, requestId: ownerRequestId, body: ownerBody }),
        api('/checks/owner-issued', { method: 'POST', storeId: storeOne.id, requestId: ownerRequestId, body: ownerBody }),
      ])
      assert.deepEqual(ownerResults.map((result) => result.response.status).sort(), [201, 409])
      const ownerId = ownerResults.find((result) => result.response.status === 201).body.check.id
      const ownerBounces = await Promise.all([
        api(`/checks/${ownerId}/bounce`, { method: 'POST', storeId: storeOne.id }),
        api(`/checks/${ownerId}/bounce`, { method: 'POST', storeId: storeOne.id }),
      ])
      assert.ok(ownerBounces.every((result) => result.response.status === 200))
      assert.equal(await countWhere(pool, 'supplier_ledger', "source_type = 'owner_check_bounce' AND source_id = $1", [ownerId]), 1)
    })

    await t.test('concurrent customer and supplier returns cannot exceed their sources or stock', async () => {
      const sale = await createSale(api, storeOne.id, saleBody('G10-RETURN-SALE', customer.id, product.id, '2', '10'))
      const customerReturnBody = {
        sourceDocumentId: sale.id,
        items: [{ sourceItemId: sale.items[0].id, quantity: '2' }],
      }
      const customerResults = await Promise.all([
        api('/returns/customer', { method: 'POST', storeId: storeOne.id, body: customerReturnBody }),
        api('/returns/customer', { method: 'POST', storeId: storeOne.id, body: customerReturnBody }),
      ])
      assert.deepEqual(customerResults.map((result) => result.response.status).sort(), [201, 409])

      const purchase = await createPurchase(api, storeOne.id, supplier.id, product.id, 'G10-RETURN-PURCHASE', '2', '10')
      const supplierReturnBody = {
        sourceDocumentId: purchase.id,
        items: [{ sourceItemId: purchase.items[0].id, quantity: '2' }],
      }
      const supplierResults = await Promise.all([
        api('/returns/supplier', { method: 'POST', storeId: storeOne.id, body: supplierReturnBody }),
        api('/returns/supplier', { method: 'POST', storeId: storeOne.id, body: supplierReturnBody }),
      ])
      assert.deepEqual(supplierResults.map((result) => result.response.status).sort(), [201, 409])
    })

    await t.test('concurrent inventory adjustments keep quantity and cost ledgers synchronized', async () => {
      const before = await inventoryQuantity(pool, storeOne.id, product.id)
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => api(
        `/products/${product.id}/inventory-movements`,
        {
          method: 'POST', storeId: storeOne.id,
          body: { storeId: storeOne.id, movementType: 'correction', quantityDelta: '1', reason: `G10 concurrent ${index}` },
        },
      )))
      assert.ok(results.every((result) => result.response.status === 201))
      const after = await inventoryQuantity(pool, storeOne.id, product.id)
      assert.equal(new Decimal(after).minus(before).toFixed(), '8')
      const cost = await pool.query(
        `SELECT quantity::TEXT FROM store_inventory_cost_balances
         WHERE store_id = $1::BIGINT AND product_id = $2::BIGINT`,
        [storeOne.id, product.id],
      )
      assert.ok(new Decimal(cost.rows[0].quantity).equals(after))
    })

    await t.test('forged, stale, and cross-store transaction context is rejected', async () => {
      const storeOneOnly = await createProduct(api, category.id, [
        { storeId: storeOne.id, openingQuantity: '2' },
      ], 'G10 one-store product')
      const forged = await api('/sales', {
        method: 'POST', storeId: storeTwo.id,
        body: { ...saleBody('G10-FORGED-STORE', customer.id, storeOneOnly.id), storeId: storeOne.id },
      })
      assert.equal(forged.response.status, 404)
      assert.ok(new Decimal(await inventoryQuantity(pool, storeOne.id, storeOneOnly.id)).equals(2))

      const source = await createSale(api, storeOne.id, saleBody('G10-CROSS-RETURN', customer.id, storeOneOnly.id))
      const crossReturn = await api('/returns/customer', {
        method: 'POST', storeId: storeTwo.id,
        body: { sourceDocumentId: source.id, items: [{ sourceItemId: source.items[0].id, quantity: '1' }] },
      })
      assert.equal(crossReturn.response.status, 404)
    })

    await t.test('failures after intermediate writes roll back every financial workflow', async () => {
      await installFailureInjector(pool)
      const atomicProduct = await createProduct(api, category.id, [
        { storeId: storeOne.id, openingQuantity: '20' },
      ], 'G10 rollback product')
      const returnSale = await createSale(api, storeOne.id, saleBody('G10-RB-RETURN-SOURCE', customer.id, atomicProduct.id))
      const returnPurchase = await createPurchase(api, storeOne.id, supplier.id, atomicProduct.id, 'G10-RB-PURCHASE-SOURCE', '1', '10')
      const bouncePayment = await api(`/customers/${customer.id}/payments`, {
        method: 'POST', storeId: storeOne.id,
        body: { payments: [{ method: 'check', currency: 'ILS', amount: '5', checkNumber: 'G10-RB-BOUNCE', dueDate: today }] },
      })
      const transferPayment = await api(`/customers/${customer.id}/payments`, {
        method: 'POST', storeId: storeOne.id,
        body: { payments: [{ method: 'check', currency: 'ILS', amount: '5', checkNumber: 'G10-RB-TRANSFER', dueDate: today }] },
      })

      const rollbackSaleRequestId = 'g10-rollback-sale-retry'
      await assertAtomicFailure(pool, 'sale',
        () => api('/sales', { method: 'POST', storeId: storeOne.id, requestId: rollbackSaleRequestId, body: saleBody('G10-RB-SALE', customer.id, atomicProduct.id) }),
        () => countWhere(pool, 'sales', 'document_number = $1', ['G10-RB-SALE']))
      const safeRetry = await api('/sales', {
        method: 'POST', storeId: storeOne.id, requestId: rollbackSaleRequestId,
        body: saleBody('G10-RB-SALE', customer.id, atomicProduct.id),
      })
      assert.equal(safeRetry.response.status, 201)
      await assertAtomicFailure(pool, 'purchase',
        () => api('/purchases', { method: 'POST', storeId: storeOne.id, body: purchaseBody(supplier.id, atomicProduct.id, 'G10-RB-PURCHASE') }),
        () => countWhere(pool, 'purchases', 'document_number = $1', ['G10-RB-PURCHASE']))
      await assertAtomicFailure(pool, 'payment',
        () => api(`/customers/${customer.id}/payments`, { method: 'POST', storeId: storeOne.id, body: { payments: [{ method: 'cash', currency: 'ILS', amount: '5' }] } }),
        () => countWhere(pool, 'payments', "customer_id = $1 AND sale_id IS NULL AND maintenance_id IS NULL", [customer.id]))
      await assertAtomicFailure(pool, 'payment',
        () => api(`/suppliers/${supplier.id}/payments`, { method: 'POST', storeId: storeOne.id, body: { payments: [{ method: 'cash', amount: '5' }] } }),
        () => countWhere(pool, 'payments', "supplier_id = $1 AND purchase_id IS NULL", [supplier.id]))
      await assertAtomicFailure(pool, 'maintenance',
        () => api('/maintenance', { method: 'POST', storeId: storeOne.id, body: { customerId: customer.id, itemDescription: 'G10 rollback maintenance', amount: '10', date: today, payments: [] } }),
        () => countWhere(pool, 'maintenance_records', 'item_description = $1', ['G10 rollback maintenance']))
      await assertAtomicFailure(pool, 'expense',
        () => api('/expenses', { method: 'POST', storeId: storeOne.id, body: { category: 'أخرى', amount: '10', date: today, paymentMethod: 'cash' } }),
        () => countWhere(pool, 'expenses', "notes IS NULL AND amount = 10 AND expense_date = $1::DATE", [today]))
      await assertAtomicFailure(pool, 'return',
        () => api('/returns/customer', { method: 'POST', storeId: storeOne.id, body: { sourceDocumentId: returnSale.id, items: [{ sourceItemId: returnSale.items[0].id, quantity: '1' }] } }),
        () => countWhere(pool, 'customer_returns', 'sale_id = $1', [returnSale.id]))
      await assertAtomicFailure(pool, 'return',
        () => api('/returns/supplier', { method: 'POST', storeId: storeOne.id, body: { sourceDocumentId: returnPurchase.id, items: [{ sourceItemId: returnPurchase.items[0].id, quantity: '1' }] } }),
        () => countWhere(pool, 'supplier_returns', 'purchase_id = $1', [returnPurchase.id]))
      await assertAtomicFailure(pool, 'check_status_change',
        () => api(`/checks/${bouncePayment.body.payment.payments[0].id}/bounce`, { method: 'POST', storeId: storeOne.id }),
        () => checkState(pool, bouncePayment.body.payment.payments[0].id))
      await assertAtomicFailure(pool, 'check_transfer',
        () => api(`/checks/${transferPayment.body.payment.payments[0].id}/transfer`, { method: 'POST', storeId: storeOne.id, body: { supplierId: supplier.id, transferDate: today } }),
        () => checkState(pool, transferPayment.body.payment.payments[0].id))
      await assertAtomicFailure(pool, 'inventory_adjustment',
        () => api(`/products/${atomicProduct.id}/inventory-movements`, { method: 'POST', storeId: storeOne.id, body: { storeId: storeOne.id, movementType: 'correction', quantityDelta: '1', reason: 'G10 rollback' } }),
        () => inventoryQuantity(pool, storeOne.id, atomicProduct.id))

      const maintenance = await create(api, '/maintenance', {
        customerId: customer.id, itemDescription: 'G10 reversal rollback', amount: '10', date: today, payments: [],
      }, storeOne.id)
      await assertAtomicFailure(pool, 'maintenance_reversal',
        () => api(`/maintenance/${maintenance.id}/reversal`, { method: 'POST', storeId: storeOne.id, body: { reason: 'G10 forced rollback' } }),
        () => countWhere(pool, 'maintenance_reversals', 'maintenance_id = $1', [maintenance.id]))

      const backup = await api('/backups/export')
      const beforeRestore = await databaseFacts(pool)
      await setFailureAction(pool, 'restore')
      const restore = await api('/backups/restore', {
        method: 'POST', requestId: 'g10-restore-rollback',
        headers: { 'X-Confirm-Restore': 'restore-both-stores' }, body: backup.body,
      })
      await clearFailureAction(pool)
      assert.equal(restore.response.status, 500)
      assert.deepEqual(await databaseFacts(pool), beforeRestore)
      await removeFailureInjector(pool)
    })

    await t.test('maintenance check reversal cannot leave a spendable or double-reversed check', async () => {
      const pending = await create(api, '/maintenance', {
        customerId: customer.id, itemDescription: 'G10 pending check reversal', amount: '10', date: today,
        payments: [{ method: 'check', currency: 'ILS', amount: '10', checkNumber: 'G10-M-REVERSE', dueDate: today }],
      }, storeOne.id)
      const pendingCheckId = pending.payments[0].id
      const reversed = await api(`/maintenance/${pending.id}/reversal`, {
        method: 'POST', storeId: storeOne.id, body: { reason: 'G10 reversal security' },
      })
      assert.equal(reversed.response.status, 201)
      assert.equal((await checkState(pool, pendingCheckId)).status, 'reversed')
      const transfer = await api(`/checks/${pendingCheckId}/transfer`, {
        method: 'POST', storeId: storeOne.id, body: { supplierId: supplier.id, transferDate: today },
      })
      assert.equal(transfer.response.status, 409)

      const bouncedMaintenance = await create(api, '/maintenance', {
        customerId: customer.id, itemDescription: 'G10 bounced check reversal', amount: '10', date: today,
        payments: [{ method: 'check', currency: 'ILS', amount: '10', checkNumber: 'G10-M-BOUNCE', dueDate: today }],
      }, storeOne.id)
      const bouncedCheckId = bouncedMaintenance.payments[0].id
      await api(`/checks/${bouncedCheckId}/bounce`, { method: 'POST', storeId: storeOne.id })
      const balanceBefore = await customerBalance(pool, customer.id)
      const bounceReversal = await api(`/maintenance/${bouncedMaintenance.id}/reversal`, {
        method: 'POST', storeId: storeOne.id, body: { reason: 'G10 bounced reversal' },
      })
      assert.equal(bounceReversal.response.status, 201)
      assert.equal(new Decimal(balanceBefore).minus(await customerBalance(pool, customer.id)).toFixed(), '10')
      assert.equal(await countWhere(pool, 'checks', 'maintenance_reversal_id = $1', [bounceReversal.body.reversal.id]), 0)
    })

    await t.test('financial verification is clean, then detects each controlled corruption without repair', async () => {
      const clean = await verifyFinancialAccounts()
      assert.equal(clean.status, 'ok', JSON.stringify(clean.sections))

      const corruptionSale = (await pool.query("SELECT id, store_id, customer_id FROM sales WHERE customer_id IS NOT NULL LIMIT 1")).rows[0]
      await pool.query(
        `INSERT INTO customer_ledger (store_id, customer_id, direction, amount_ils, occurred_at, source_type, source_id)
         VALUES ($1, $2, 'debit', 0.5, NOW(), 'sale', $3)`,
        [corruptionSale.store_id, corruptionSale.customer_id, corruptionSale.id],
      )
      const corruptionPurchase = (await pool.query('SELECT id, store_id, supplier_id FROM purchases LIMIT 1')).rows[0]
      await pool.query(
        `INSERT INTO supplier_ledger (store_id, supplier_id, direction, amount_ils, occurred_at, source_type, source_id)
         VALUES ($1, $2, 'credit', 0.5, NOW(), 'purchase', $3)`,
        [corruptionPurchase.store_id, corruptionPurchase.supplier_id, corruptionPurchase.id],
      )
      await pool.query(
        `INSERT INTO inventory_cost_movements (
           store_id, product_id, inventory_movement_id, quantity_delta,
           unit_cost_snapshot, inventory_value_delta, occurred_at, source_type
         ) VALUES ($1, $2, NULL, 1, 0, 0, NOW(), 'legacy_cost_seed')`,
        [storeOne.id, product.id],
      )
      const expense = await create(api, '/expenses', {
        category: 'أخرى', amount: '10', date: today, paymentMethod: 'cash', notes: 'G10 corruption cash',
      }, storeOne.id)
      await pool.query(
        `INSERT INTO financial_movements (store_id, direction, amount, currency_code, occurred_at, source_type, source_id)
         VALUES ($1, 'outflow', 1, 'ILS', NOW(), 'expense', $2)`,
        [storeOne.id, expense.id],
      )
      const bankExpense = await create(api, '/expenses', {
        category: 'أخرى', amount: '10', date: today, paymentMethod: 'bank', notes: 'G10 corruption bank',
      }, storeOne.id)
      await pool.query(
        `INSERT INTO bank_movements (store_id, direction, amount_ils, occurred_at, source_type, source_id)
         VALUES ($1, 'outflow', 1, NOW(), 'expense', $2)`,
        [storeOne.id, bankExpense.id],
      )
      const pendingCheck = (await pool.query("SELECT id, store_id, customer_id, amount FROM checks WHERE status = 'pending' AND customer_id IS NOT NULL LIMIT 1")).rows[0]
      await pool.query(
        `INSERT INTO customer_ledger (store_id, customer_id, direction, amount_ils, occurred_at, source_type, source_id)
         VALUES ($1, $2, 'debit', $3, NOW(), 'check_bounce', $4)`,
        [pendingCheck.store_id, pendingCheck.customer_id, pendingCheck.amount, pendingCheck.id],
      )

      const reversalSource = await create(api, '/maintenance', {
        customerId: customer.id, itemDescription: 'G10 malformed reversal source', amount: '10', date: today, payments: [],
      }, storeOne.id)
      await pool.query('ALTER TABLE maintenance_reversals DROP CONSTRAINT maintenance_reversals_maintenance_id_key')
      await pool.query('ALTER TABLE maintenance_reversals DROP CONSTRAINT maintenance_reversal_source_store_fk')
      await pool.query(
        `INSERT INTO maintenance_reversals (maintenance_id, store_id, reason)
         VALUES ($1, $2, 'controlled duplicate'), ($3, $2, 'controlled missing original')`,
        [reversalSource.id, storeOne.id, '999999999999'],
      )
      await pool.query(
        `INSERT INTO maintenance_reversals (maintenance_id, store_id, reason)
         VALUES ($1, $2, 'controlled duplicate two')`,
        [reversalSource.id, storeOne.id],
      )

      const corrupted = await verifyFinancialAccounts()
      assert.equal(corrupted.status, 'warning')
      const codes = new Set(corrupted.sections.flatMap((section) => section.issues.map((issue) => issue.code)))
      for (const code of [
        'CUSTOMER_BALANCE_MISMATCH', 'SUPPLIER_BALANCE_MISMATCH',
        'INVENTORY_COST_QUANTITY_MISMATCH', 'CASH_BALANCE_MISMATCH',
        'BANK_BALANCE_MISMATCH', 'CHECK_UNEXPECTED_BOUNCE_REVERSAL',
        'REVERSAL_ORIGINAL_MISSING', 'REVERSAL_DUPLICATED',
      ]) assert.ok(codes.has(code), `missing detector result ${code}`)
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await pool.end()
  }
})

function saleBody(invoiceNumber, customerId, productId, quantity = '1', price = '10') {
  return {
    invoiceNumber, date: today, customerId, invoiceDiscount: '0',
    items: [{ productId, quantity, actualPrice: price, discount: '0' }], payments: [],
  }
}

function purchaseBody(supplierId, productId, documentNumber, quantity = '1', price = '10') {
  return {
    supplierId, documentNumber, businessDate: today,
    items: [{ productId, quantity, purchasePrice: price }], payments: [],
  }
}

async function createProduct(api, categoryId, inventorySettings, name) {
  return create(api, '/products', {
    name, categoryId, saleUnit: 'قطعة', currentPurchasePrice: '2.50', defaultSalePrice: '10',
    inventorySettings: inventorySettings.map((item) => ({ ...item, reorderLevel: '1' })),
  })
}

async function createPurchase(api, storeId, supplierId, productId, documentNumber, quantity = '1', price = '10') {
  const result = await api('/purchases', {
    method: 'POST', storeId, body: purchaseBody(supplierId, productId, documentNumber, quantity, price),
  })
  assert.equal(result.response.status, 201, JSON.stringify(result.body))
  return result.body.purchase
}

async function createSale(api, storeId, body) {
  const result = await api('/sales', { method: 'POST', storeId, body })
  assert.equal(result.response.status, 201, JSON.stringify(result.body))
  return result.body.sale
}

async function create(api, path, body, storeId) {
  const result = await api(path, { method: 'POST', body, storeId })
  assert.equal(result.response.status, 201, `${path}: ${JSON.stringify(result.body)}`)
  return result.body.category ?? result.body.product ?? result.body.customer
    ?? result.body.supplier ?? result.body.maintenance ?? result.body.expense
}

async function apiRequest(baseUrl, token, path, options) {
  const headers = new Headers(options.headers)
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (options.storeId !== undefined) headers.set('X-Store-Id', options.storeId)
  if (!['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase())) {
    requestSequence += 1
    headers.set('X-Request-Id', options.requestId ?? `g10-fin-${requestSequence}`)
  }
  return jsonRequest(`${baseUrl}${path}`, {
    method: options.method, headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

async function assertDisposableDatabase(pool) {
  const result = await pool.query('SELECT current_database() AS database, inet_server_port() AS port')
  assert.match(result.rows[0].database, /^group10_financial_[a-z0-9_]+$/)
  assert.ok(Number(result.rows[0].port) >= 55000)
}

function assertMoney(actual, expected) {
  assert.ok(new Decimal(actual).equals(expected), `${actual} != ${expected}`)
}

async function inventoryQuantity(pool, storeId, productId) {
  const result = await pool.query(
    'SELECT quantity::TEXT FROM store_inventory_balances WHERE store_id = $1::BIGINT AND product_id = $2::BIGINT',
    [storeId, productId],
  )
  return result.rows[0].quantity
}

async function customerBalance(pool, customerId) {
  return (await pool.query('SELECT balance_ils::TEXT FROM customer_balances WHERE customer_id = $1', [customerId])).rows[0].balance_ils
}

async function supplierBalance(pool, supplierId) {
  return (await pool.query('SELECT balance_ils::TEXT FROM supplier_balances WHERE supplier_id = $1', [supplierId])).rows[0].balance_ils
}

const allowedCountTables = new Set([
  'sales', 'purchases', 'payments', 'maintenance_records', 'maintenance_reversals',
  'expenses', 'customer_returns', 'supplier_returns', 'customer_ledger',
  'supplier_ledger', 'checks',
])

async function countWhere(pool, table, predicate, params) {
  assert.ok(allowedCountTables.has(table))
  const result = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${table} WHERE ${predicate}`, params)
  return result.rows[0].count
}

async function checkState(pool, checkId) {
  return (await pool.query(
    'SELECT status, supplier_id::TEXT AS supplier_id, transferred_at::TEXT AS transferred_at FROM checks WHERE id = $1',
    [checkId],
  )).rows[0]
}

async function checkSnapshot(pool, checkId) {
  return (await pool.query(
    `SELECT supplier_id::TEXT AS supplier_id, is_giro, original_owner_name, original_owner_phone
     FROM checks WHERE id = $1::BIGINT`,
    [checkId],
  )).rows[0]
}

async function installFailureInjector(pool) {
  await pool.query('CREATE TABLE group10_failure_injection (action TEXT PRIMARY KEY)')
  await pool.query(`
    CREATE FUNCTION group10_reject_selected_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM group10_failure_injection WHERE action = NEW.action) THEN
        RAISE EXCEPTION 'Group 10 forced intermediate failure';
      END IF;
      RETURN NEW;
    END $$
  `)
  await pool.query(`
    CREATE TRIGGER group10_reject_selected_audit
    BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION group10_reject_selected_audit()
  `)
}

async function setFailureAction(pool, action) {
  await pool.query('TRUNCATE group10_failure_injection')
  await pool.query('INSERT INTO group10_failure_injection (action) VALUES ($1)', [action])
}

async function clearFailureAction(pool) {
  await pool.query('TRUNCATE group10_failure_injection')
}

async function assertAtomicFailure(pool, action, operation, facts) {
  const before = await facts()
  await setFailureAction(pool, action)
  const result = await operation()
  await clearFailureAction(pool)
  assert.equal(result.response.status, 500, JSON.stringify(result.body))
  assert.deepEqual(await facts(), before)
}

async function removeFailureInjector(pool) {
  await pool.query('DROP TRIGGER group10_reject_selected_audit ON audit_log')
  await pool.query('DROP FUNCTION group10_reject_selected_audit()')
  await pool.query('DROP TABLE group10_failure_injection')
}

async function databaseFacts(pool) {
  return (await pool.query(`
    SELECT
      (SELECT COUNT(*)::INTEGER FROM customers) AS customers,
      (SELECT COUNT(*)::INTEGER FROM sales) AS sales,
      (SELECT COUNT(*)::INTEGER FROM payments) AS payments,
      (SELECT COUNT(*)::INTEGER FROM inventory_movements) AS inventory,
      (SELECT COUNT(*)::INTEGER FROM audit_log) AS audit
  `)).rows[0]
}
