import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import test from 'node:test'
import Decimal from 'decimal.js'

const databaseUrl = process.env.GROUP8_INTEGRATION_DATABASE_URL
const tlsKeyPath = process.env.GROUP8_PUSH_TLS_KEY
const tlsCertificatePath = process.env.GROUP8_PUSH_TLS_CERT
const adminUsername = process.env.GROUP8_ADMIN_USERNAME ?? 'group8_admin'
const adminPassword = process.env.GROUP8_ADMIN_PASSWORD
const D = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP })

test(
  'Group 8 final approval reconciles real PostgreSQL reports, statements, and VAPID delivery',
  { skip: databaseUrl ? false : 'GROUP8_INTEGRATION_DATABASE_URL is not configured' },
  async (t) => {
    assert.ok(tlsKeyPath && tlsCertificatePath, 'Controlled HTTPS push endpoint certificate is required')
    assert.ok(adminPassword, 'GROUP8_ADMIN_PASSWORD is required')

    const webpush = (await import('web-push')).default
    const vapid = webpush.generateVAPIDKeys()
    process.env.DATABASE_URL = databaseUrl
    process.env.NODE_ENV = 'test'
    process.env.VAPID_PUBLIC_KEY = vapid.publicKey
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey
    process.env.VAPID_SUBJECT = 'mailto:group8-approval@example.test'
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    const [{ app }, { pool }, dueModule, reminderModule] = await Promise.all([
      import('../src/app.js'),
      import('../src/db/pool.js'),
      import('../src/notifications/check-due-scheduler.js'),
      import('../src/checks/check-reminders.js'),
    ])

    await assertDisposableDatabase(pool)
    await resetDisposableBusinessData(pool)

    let pushMode = 'success'
    const pushRequests = []
    const pushServer = createHttpsServer({
      key: await readFile(tlsKeyPath),
      cert: await readFile(tlsCertificatePath),
    }, async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      pushRequests.push({ body, headers: request.headers, method: request.method, url: request.url })
      if (pushMode === 'drop') {
        request.socket.destroy()
        return
      }
      response.writeHead(pushMode === 'gone' ? 410 : 201)
      response.end(pushMode === 'gone' ? 'expired' : '')
    })
    pushServer.listen(0, '127.0.0.1')
    await once(pushServer, 'listening')
    const pushAddress = pushServer.address()
    assert.ok(pushAddress && typeof pushAddress === 'object')
    const pushEndpoint = `https://127.0.0.1:${pushAddress.port}/push/group8`

    const apiServer = app.listen(0, '127.0.0.1')
    await once(apiServer, 'listening')
    const apiAddress = apiServer.address()
    assert.ok(apiAddress && typeof apiAddress === 'object')
    const baseUrl = `http://127.0.0.1:${apiAddress.port}/api`

    let token
    let stores
    let salam
    let showroom
    let product
    let customer
    let supplier
    let projectOne
    let projectTwo
    let saleOne
    let saleTwo
    let purchaseOne
    let purchaseTwo
    let transferredCheckId
    let pendingCheckId
    let clearedCheckId
    let ownerCheckId
    let customerPaymentOff
    let customerPaymentOn
    let supplierPaymentOff
    let supplierPaymentOn
    let settings = allNotificationSettings(true)
    const today = reminderModule.currentBusinessDate()
    const priorDate = shiftDate(today, -2)
    const openingDate = shiftDate(today, -1)
    const supplierOpeningDate = shiftDate(priorDate, -1)
    const monthStart = `${today.slice(0, 7)}-01`
    const weekStart = shiftDate(today, -new Date(`${today}T00:00:00Z`).getUTCDay())

    const api = (path, options = {}) => apiRequest(baseUrl, path, { token, ...options })

    async function updateSettings(category, enabled) {
      settings = { ...settings, [category]: enabled }
      const result = await api('/push/settings', { method: 'PUT', body: settings })
      assert.equal(result.response.status, 200, JSON.stringify(result.body))
      assert.deepEqual(result.body.settings, settings)
    }

    async function subscribe() {
      const ecdh = createECDH('prime256v1')
      ecdh.generateKeys()
      const result = await api('/push/subscriptions', {
        method: 'POST',
        body: {
          endpoint: pushEndpoint,
          expirationTime: null,
          keys: {
            p256dh: ecdh.getPublicKey().toString('base64url'),
            auth: randomBytes(16).toString('base64url'),
          },
        },
      })
      assert.equal(result.response.status, 201, JSON.stringify(result.body))
      return result.body.subscription.id
    }

    try {
      await t.test('persistent admin login and VAPID configuration expose only the public key', async () => {
        const login = await jsonRequest(`${baseUrl}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: adminUsername, password: adminPassword }),
        })
        assert.equal(login.response.status, 201, JSON.stringify(login.body))
        token = login.body.token

        const storesResponse = await api('/stores')
        assert.equal(storesResponse.response.status, 200)
        stores = storesResponse.body.stores
        salam = stores.find((store) => store.code === 'AL_SALAM_ELECTRIC')
        showroom = stores.find((store) => store.code === 'SHOWROOM')
        assert.ok(salam && showroom)

        const status = await api('/push/status')
        assert.equal(status.response.status, 200)
        assert.equal(status.body.configured, true)
        assert.equal(status.body.publicKey, vapid.publicKey)
        assert.equal('privateKey' in status.body, false)
        assert.equal(JSON.stringify(status.body).includes(vapid.privateKey), false)
        await api('/push/settings', { method: 'PUT', body: settings })
        await subscribe()

        const persisted = await pool.query(
          `SELECT users.role, users.is_active, subscriptions.endpoint
           FROM push_subscriptions AS subscriptions
           INNER JOIN users ON users.id = subscriptions.user_id`,
        )
        assert.deepEqual(persisted.rows, [{ role: 'admin', is_active: true, endpoint: pushEndpoint }])
      })

      await t.test('real APIs create the deterministic two-store accounting scenario', async () => {
        const category = await api('/categories', {
          method: 'POST', body: { name: 'تصنيف اعتماد المجموعة الثامنة' },
        })
        assert.equal(category.response.status, 201, JSON.stringify(category.body))
        const productResponse = await api('/products', {
          method: 'POST',
          body: {
            name: 'كابل اعتماد المجموعة الثامنة',
            categoryId: category.body.category.id,
            saleUnit: 'قطعة',
            currentPurchasePrice: '10',
            defaultSalePrice: '30',
            inventorySettings: [
              { storeId: salam.id, reorderLevel: '10', openingQuantity: '100' },
              { storeId: showroom.id, reorderLevel: '10', openingQuantity: '100' },
            ],
          },
        })
        assert.equal(productResponse.response.status, 201, JSON.stringify(productResponse.body))
        product = productResponse.body.product

        const customerResponse = await api('/customers', {
          storeId: salam.id, method: 'POST',
          body: { name: 'عميل اعتماد المجموعة الثامنة', phone: '0599008000', address: 'رام الله' },
        })
        const supplierResponse = await api('/suppliers', {
          storeId: salam.id, method: 'POST',
          body: { name: 'مورد اعتماد المجموعة الثامنة', phone: '022900800', address: 'البيرة' },
        })
        assert.equal(customerResponse.response.status, 201, JSON.stringify(customerResponse.body))
        assert.equal(supplierResponse.response.status, 201, JSON.stringify(supplierResponse.body))
        customer = customerResponse.body.customer
        supplier = supplierResponse.body.supplier

        const firstProject = await api(`/customers/${customer.id}/projects`, {
          storeId: salam.id, method: 'POST', body: { name: 'مشروع السلام' },
        })
        const secondProject = await api(`/customers/${customer.id}/projects`, {
          storeId: salam.id, method: 'POST', body: { name: 'مشروع المعرض' },
        })
        projectOne = firstProject.body.project
        projectTwo = secondProject.body.project

        const adminId = (await pool.query(
          'SELECT id::TEXT AS id FROM users WHERE username = $1', [adminUsername],
        )).rows[0].id
        await pool.query(
          `INSERT INTO customer_ledger (
             store_id, customer_id, direction, amount_ils, occurred_at,
             source_type, source_id, notes, created_by_user_id
           ) VALUES ($1, $2, 'debit', 1000, $3::TIMESTAMPTZ,
             'correction', 800001, 'رصيد افتتاحي معتمد', $4)`,
          [salam.id, customer.id, `${openingDate}T10:00:00+03:00`, adminId],
        )
        await pool.query(
          `INSERT INTO supplier_ledger (
             store_id, supplier_id, direction, amount_ils, occurred_at,
             source_type, source_id, notes, created_by_user_id
           ) VALUES ($1, $2, 'credit', 500, $3::TIMESTAMPTZ,
             'correction', 800002, 'رصيد افتتاحي معتمد', $4)`,
          [salam.id, supplier.id, `${supplierOpeningDate}T10:00:00+03:00`, adminId],
        )

        await updateSettings('sale_created', false)
        const requestsBeforeDisabledSale = pushRequests.length
        const firstSaleResponse = await api('/sales', {
          storeId: salam.id, method: 'POST',
          body: {
            invoiceNumber: 'G8-SALAM-001', businessDate: today,
            customerId: customer.id, customerProjectId: projectOne.id,
            invoiceDiscount: '0',
            items: [{ productId: product.id, quantity: '10', actualPrice: '30', discount: '0' }],
            payments: [
              { method: 'cash', currency: 'ILS', amount: '50' },
              { method: 'check', amount: '70', checkNumber: 'G8-TRANSFER-070', dueDate: today },
              { method: 'check', amount: '40', checkNumber: 'G8-PENDING-040', dueDate: today },
            ],
          },
        })
        assert.equal(firstSaleResponse.response.status, 201, JSON.stringify(firstSaleResponse.body))
        saleOne = firstSaleResponse.body.sale
        assert.equal(pushRequests.length, requestsBeforeDisabledSale)
        assert.equal(await eventCount(pool, 'sale_created', saleOne.id), 0)
        transferredCheckId = saleOne.payments.find((payment) => payment.check_number === 'G8-TRANSFER-070').id
        pendingCheckId = saleOne.payments.find((payment) => payment.check_number === 'G8-PENDING-040').id

        await updateSettings('sale_created', true)
        const secondSaleResponse = await api('/sales', {
          storeId: showroom.id, method: 'POST',
          body: {
            invoiceNumber: 'G8-SHOWROOM-001', businessDate: priorDate,
            customerId: customer.id, customerProjectId: projectTwo.id,
            invoiceDiscount: '0',
            items: [{ productId: product.id, quantity: '5', actualPrice: '40', discount: '0' }],
            payments: [
              { method: 'cash', currency: 'USD', amount: '5', exchangeRate: '4' },
              { method: 'check', amount: '30', checkNumber: 'G8-CLEARED-030', dueDate: today },
            ],
          },
        })
        assert.equal(secondSaleResponse.response.status, 201, JSON.stringify(secondSaleResponse.body))
        saleTwo = secondSaleResponse.body.sale
        clearedCheckId = saleTwo.payments.find((payment) => payment.check_number === 'G8-CLEARED-030').id
        money(saleOne.cost_total, '100')
        money(saleTwo.cost_total, '50')

        await updateSettings('purchase_created', false)
        const firstPurchaseResponse = await api('/purchases', {
          storeId: salam.id, method: 'POST',
          body: {
            supplierId: supplier.id, documentNumber: 'G8-P-SALAM-001', businessDate: today,
            items: [{ productId: product.id, quantity: '20', purchasePrice: '20' }],
            payments: [
              { method: 'cash', amount: '50' },
              { method: 'owner_check', amount: '50', checkNumber: 'G8-OWNER-050', dueDate: today },
              { method: 'transferred_customer_check', checkId: transferredCheckId },
            ],
          },
        })
        assert.equal(firstPurchaseResponse.response.status, 201, JSON.stringify(firstPurchaseResponse.body))
        purchaseOne = firstPurchaseResponse.body.purchase
        ownerCheckId = purchaseOne.payments.find((payment) => payment.method === 'owner_check').id
        assert.equal(await eventCount(pool, 'purchase_created', purchaseOne.id), 0)

        await updateSettings('purchase_created', true)
        const secondPurchaseResponse = await api('/purchases', {
          storeId: showroom.id, method: 'POST',
          body: {
            supplierId: supplier.id, documentNumber: 'G8-P-SHOWROOM-001', businessDate: priorDate,
            items: [{ productId: product.id, quantity: '10', purchasePrice: '30' }],
            payments: [{ method: 'cash', amount: '40' }],
          },
        })
        assert.equal(secondPurchaseResponse.response.status, 201, JSON.stringify(secondPurchaseResponse.body))
        purchaseTwo = secondPurchaseResponse.body.purchase

        const customerReturn = await api('/returns/customer', {
          storeId: salam.id, method: 'POST',
          body: { sourceDocumentId: saleOne.id, items: [{ sourceItemId: saleOne.items[0].id, quantity: '2' }] },
        })
        const supplierReturnOne = await api('/returns/supplier', {
          storeId: salam.id, method: 'POST',
          body: { sourceDocumentId: purchaseOne.id, items: [{ sourceItemId: purchaseOne.items[0].id, quantity: '5' }] },
        })
        const supplierReturnTwo = await api('/returns/supplier', {
          storeId: showroom.id, method: 'POST',
          body: { sourceDocumentId: purchaseTwo.id, items: [{ sourceItemId: purchaseTwo.items[0].id, quantity: '2' }] },
        })
        assert.equal(customerReturn.response.status, 201, JSON.stringify(customerReturn.body))
        assert.equal(supplierReturnOne.response.status, 201, JSON.stringify(supplierReturnOne.body))
        assert.equal(supplierReturnTwo.response.status, 201, JSON.stringify(supplierReturnTwo.body))
        money(customerReturn.body.return.total, '60')
        money(customerReturn.body.return.cost_total, '20')
        money(supplierReturnOne.body.return.total, '100')
        money(supplierReturnTwo.body.return.total, '60')

        const maintenance = await api('/maintenance', {
          storeId: showroom.id, method: 'POST',
          body: {
            customerId: customer.id, itemDescription: 'صيانة لوحة تحكم',
            maintenanceDetails: 'دخل صيانة مستقل عن البضاعة', amount: '80', businessDate: today,
            payments: [{ method: 'cash', currency: 'JOD', amount: '10', exchangeRate: '5' }],
          },
        })
        assert.equal(maintenance.response.status, 201, JSON.stringify(maintenance.body))
        money(maintenance.body.maintenance.remaining_due_ils, '30')

        await updateSettings('customer_payment', false)
        const customerOffRequestCount = pushRequests.length
        customerPaymentOff = (await api(`/customers/${customer.id}/payments`, {
          storeId: showroom.id, method: 'POST',
          body: { payments: [{ method: 'bank_card', amount: '10', reference: 'G8-CUSTOMER-OFF' }] },
        })).body.payment
        assert.equal(pushRequests.length, customerOffRequestCount)
        assert.equal(await eventCount(pool, 'customer_payment', customerPaymentOff.payments[0].id), 0)

        await updateSettings('customer_payment', true)
        const customerPaymentOnResponse = await api(`/customers/${customer.id}/payments`, {
          storeId: showroom.id, method: 'POST',
          body: { payments: [{ method: 'bank_card', amount: '10', reference: 'G8-CUSTOMER-ON' }] },
        })
        assert.equal(customerPaymentOnResponse.response.status, 201, JSON.stringify(customerPaymentOnResponse.body))
        customerPaymentOn = customerPaymentOnResponse.body.payment

        await updateSettings('check_bounced', false)
        const bounceOffRequests = pushRequests.length
        const bounced = await api(`/checks/${transferredCheckId}/bounce`, {
          storeId: salam.id, method: 'POST',
        })
        assert.equal(bounced.response.status, 200, JSON.stringify(bounced.body))
        assert.equal(pushRequests.length, bounceOffRequests)
        assert.equal(await eventCount(pool, 'check_bounced', transferredCheckId), 0)
        await updateSettings('check_bounced', true)

        const cleared = await api(`/checks/${clearedCheckId}/clear`, {
          storeId: showroom.id, method: 'POST',
        })
        assert.equal(cleared.response.status, 200, JSON.stringify(cleared.body))

        await updateSettings('supplier_payment', false)
        const supplierOffRequests = pushRequests.length
        const supplierPaymentOffResponse = await api(`/suppliers/${supplier.id}/payments`, {
          storeId: salam.id, method: 'POST',
          body: { payments: [{ method: 'bank', amount: '30', reference: 'G8-SUPPLIER-OFF' }] },
        })
        assert.equal(supplierPaymentOffResponse.response.status, 201, JSON.stringify(supplierPaymentOffResponse.body))
        supplierPaymentOff = supplierPaymentOffResponse.body.payment
        assert.equal(pushRequests.length, supplierOffRequests)
        assert.equal(await eventCount(pool, 'supplier_payment', supplierPaymentOff.payments[0].id), 0)

        await updateSettings('supplier_payment', true)
        const supplierPaymentOnResponse = await api(`/suppliers/${supplier.id}/payments`, {
          storeId: showroom.id, method: 'POST',
          body: { payments: [{ method: 'cash', amount: '25', reference: 'G8-SUPPLIER-ON' }] },
        })
        assert.equal(supplierPaymentOnResponse.response.status, 201, JSON.stringify(supplierPaymentOnResponse.body))
        supplierPaymentOn = supplierPaymentOnResponse.body.payment

        await api('/expenses', {
          storeId: salam.id, method: 'POST',
          body: { amount: '50', category: 'كهرباء', date: today, paymentMethod: 'cash' },
        })
        await api('/expenses', {
          storeId: showroom.id, method: 'POST',
          body: { amount: '25', category: 'أجار', date: priorDate, paymentMethod: 'bank' },
        })

        await pool.query(
          `INSERT INTO customer_ledger (
             store_id, customer_id, direction, amount_ils, occurred_at,
             source_type, source_id, notes, created_by_user_id
           ) VALUES ($1, $2, 'credit', 10, NOW(),
             'correction', 800003, 'تصحيح رصيد معتمد', $3)`,
          [salam.id, customer.id, adminId],
        )
      })

      await t.test('reports reconcile sales, purchase returns, snapshot COGS, expenses, and store comparison exactly', async () => {
        const all = (await api(`/reports?from=${monthStart}&to=${today}`)).body
        assertFinancial(all.summary, {
          sales: '440', purchases: '540', cost_of_goods: '130', gross_profit: '310',
          expenses: '75', net_profit: '235', sales_returns: '60', purchase_returns: '160',
        })
        money(all.summary.customer_debt, '1300')
        money(all.summary.supplier_debt, '845')
        money(all.summary.inventory_value, '2410')
        assert.equal(all.summary.inventory_lines, '2')
        assert.equal(all.summary.low_stock_count, '0')

        const todayReport = (await api(`/reports?from=${today}&to=${today}`)).body
        assertFinancial(todayReport.summary, {
          sales: '240', purchases: '240', cost_of_goods: '80', gross_profit: '160',
          expenses: '50', net_profit: '110', sales_returns: '60', purchase_returns: '160',
        })
        const week = (await api(`/reports?from=${weekStart}&to=${today}`)).body
        assertFinancial(week.summary, {
          sales: '440', purchases: '540', cost_of_goods: '130', gross_profit: '310',
          expenses: '75', net_profit: '235', sales_returns: '60', purchase_returns: '160',
        })

        const salamReport = (await api(`/reports?from=${monthStart}&to=${today}&storeId=${salam.id}`)).body
        assertFinancial(salamReport.summary, {
          sales: '240', purchases: '300', cost_of_goods: '80', gross_profit: '160',
          expenses: '50', net_profit: '110', sales_returns: '60', purchase_returns: '100',
        })
        const showroomReport = (await api(`/reports?from=${monthStart}&to=${today}&storeId=${showroom.id}`)).body
        assertFinancial(showroomReport.summary, {
          sales: '200', purchases: '240', cost_of_goods: '50', gross_profit: '150',
          expenses: '25', net_profit: '125', sales_returns: '0', purchase_returns: '60',
        })
        assert.deepEqual(all.store_comparison.map((row) => ({
          store: row.store_name,
          sales: normalized(row.sales), purchases: normalized(row.purchases),
          gross: normalized(row.gross_profit), expenses: normalized(row.expenses), net: normalized(row.net_profit),
        })), [
          { store: 'كهرباء السلام', sales: '240', purchases: '300', gross: '160', expenses: '50', net: '110' },
          { store: 'المعرض', sales: '200', purchases: '240', gross: '150', expenses: '25', net: '125' },
        ])

        const historical = await pool.query(
          `SELECT sales.cost_total::TEXT AS cost, sales.gross_profit::TEXT AS profit,
             sale_items.unit_cost_snapshot::TEXT AS unit_cost,
             products.current_purchase_price::TEXT AS current_purchase_price
           FROM sales
           INNER JOIN sale_items ON sale_items.sale_id = sales.id
           INNER JOIN products ON products.id = sale_items.product_id
           WHERE sales.id = $1`,
          [saleOne.id],
        )
        money(historical.rows[0].cost, '100')
        money(historical.rows[0].profit, '200')
        money(historical.rows[0].unit_cost, '10')
        money(historical.rows[0].current_purchase_price, '30')
        const maintenanceCostRows = await pool.query(
          `SELECT COUNT(*)::INTEGER AS count FROM inventory_cost_movements
           WHERE source_type LIKE 'maintenance%'`,
        )
        assert.equal(maintenanceCostRows.rows[0].count, 0)
      })

      await t.test('inventory, cash currencies, bank movements, and checks stay distinct and exact', async () => {
        const inventory = await pool.query(
          `SELECT stores.name, balances.quantity::TEXT AS quantity,
             costs.inventory_value::TEXT AS value, costs.weighted_average_cost::TEXT AS average
           FROM store_inventory_balances AS balances
           INNER JOIN store_inventory_cost_balances AS costs
             ON costs.store_id = balances.store_id AND costs.product_id = balances.product_id
           INNER JOIN stores ON stores.id = balances.store_id
           WHERE balances.product_id = $1 ORDER BY stores.id`,
          [product.id],
        )
        assert.equal(inventory.rowCount, 2)
        assert.deepEqual(inventory.rows.map((row) => ({
          store: row.name, quantity: normalized(row.quantity), value: normalized(row.value),
        })), [
          { store: 'كهرباء السلام', quantity: '107', value: '1220' },
          { store: 'المعرض', quantity: '103', value: '1190' },
        ])

        const report = (await api(`/reports?from=${monthStart}&to=${today}`)).body.summary
        money(report.inflow_ils, '70')
        money(report.outflow_ils, '220')
        money(report.net_ils, '-150')
        const cash = new Map(report.cash_movements.map((row) => [row.currency_code, row]))
        assertCash(cash.get('ILS'), '50', '165', '-115')
        assertCash(cash.get('USD'), '5', '0', '5')
        assertCash(cash.get('JOD'), '10', '0', '10')
        const bank = await pool.query(
          `SELECT balance_ils::TEXT AS balance FROM store_bank_balances
           WHERE store_id = ANY($1::BIGINT[]) ORDER BY store_id`,
          [[salam.id, showroom.id]],
        )
        assert.deepEqual(bank.rows.map((row) => normalized(row.balance)), ['-30', '-5'])

        const checks = new Map(report.checks.map((row) => [row.status, row]))
        assertCheck(checks.get('pending'), '2', '90')
        assertCheck(checks.get('cleared'), '1', '30')
        assertCheck(checks.get('bounced'), '1', '70')
        assert.equal(report.check_count, '4')
      })

      await t.test('customer statements reconcile exact opening, running, project, store, and all-store balances', async () => {
        const all = (await api(
          `/customers/${customer.id}/statement?from=${today}&to=${today}`,
          { storeId: salam.id },
        )).body.statement
        reconcileStatement(all, '1000', '1300')
        const sourceTypes = new Set(all.entries.map((entry) => entry.source_type))
        for (const type of ['sale', 'sale_payment', 'sale_check', 'check_bounce', 'customer_return', 'maintenance', 'maintenance_payment', 'payment', 'correction']) {
          assert.ok(sourceTypes.has(type), `Missing customer statement source ${type}`)
        }

        const salamOnly = (await api(
          `/customers/${customer.id}/statement?from=${today}&to=${today}&storeId=${salam.id}`,
          { storeId: salam.id },
        )).body.statement
        const showroomOnly = (await api(
          `/customers/${customer.id}/statement?from=${today}&to=${today}&storeId=${showroom.id}`,
          { storeId: salam.id },
        )).body.statement
        reconcileStatement(salamOnly, '1000', '1140')
        reconcileStatement(showroomOnly, '0', '160')

        const projectOneStatement = (await api(
          `/customers/${customer.id}/statement?from=${today}&to=${today}&projectId=${projectOne.id}`,
          { storeId: salam.id },
        )).body.statement
        const projectTwoStatement = (await api(
          `/customers/${customer.id}/statement?from=${today}&to=${today}&projectId=${projectTwo.id}`,
          { storeId: salam.id },
        )).body.statement
        reconcileStatement(projectOneStatement, '0', '150')
        reconcileStatement(projectTwoStatement, '0', '150')
        assert.equal(projectOneStatement.project.name, 'مشروع السلام')
        assert.equal(projectTwoStatement.project.name, 'مشروع المعرض')
      })

      await t.test('supplier statements reconcile purchases, item prices, checks, returns, and stores exactly', async () => {
        const all = (await api(
          `/suppliers/${supplier.id}/statement?from=${priorDate}&to=${today}`,
          { storeId: salam.id },
        )).body.statement
        reconcileSupplierStatement(all, '500', '845')
        const types = new Set(all.entries.map((entry) => entry.source_type))
        for (const type of ['purchase', 'purchase_payment', 'owner_check', 'check_transfer', 'check_transfer_bounce', 'supplier_payment', 'supplier_return']) {
          assert.ok(types.has(type), `Missing supplier statement source ${type}`)
        }
        const purchaseEntries = all.entries.filter((entry) => entry.source_type === 'purchase')
        assert.deepEqual(purchaseEntries.map((entry) => ({
          product: entry.purchase_items[0].product,
          quantity: normalized(entry.purchase_items[0].quantity),
          price: normalized(entry.purchase_items[0].unit_price),
        })), [
          { product: 'كابل اعتماد المجموعة الثامنة', quantity: '10', price: '30' },
          { product: 'كابل اعتماد المجموعة الثامنة', quantity: '20', price: '20' },
        ])

        const salamOnly = (await api(
          `/suppliers/${supplier.id}/statement?from=${today}&to=${today}&storeId=${salam.id}`,
          { storeId: salam.id },
        )).body.statement
        const showroomOnly = (await api(
          `/suppliers/${supplier.id}/statement?from=${priorDate}&to=${today}&storeId=${showroom.id}`,
          { storeId: salam.id },
        )).body.statement
        reconcileSupplierStatement(salamOnly, '500', '670')
        reconcileSupplierStatement(showroomOnly, '0', '175')
      })

      await t.test('due-check push uses the Group 6 reminder source and deduplicates delivery', async () => {
        const statusesBefore = await checkStatuses(pool, [pendingCheckId, clearedCheckId, transferredCheckId, ownerCheckId])
        assert.deepEqual(statusesBefore, {
          [pendingCheckId]: 'pending', [clearedCheckId]: 'cleared',
          [transferredCheckId]: 'bounced', [ownerCheckId]: 'pending',
        })
        const reminders = (await api('/checks/reminders', { storeId: salam.id })).body.reminders
        assert.deepEqual(reminders.due_today.map((check) => check.id).sort(), [ownerCheckId, pendingCheckId].sort())
        assert.equal(reminders.due_today.some((check) => check.id === clearedCheckId), false)
        assert.equal(reminders.due_today.some((check) => check.id === transferredCheckId), false)
        assert.equal(reminderModule.elapsedBusinessDays('2026-09-03', '2026-09-06'), 1)

        await updateSettings('check_due', false)
        const offRequestCount = pushRequests.length
        await dueModule.sendDueCheckNotifications({ today })
        assert.equal(pushRequests.length, offRequestCount)
        assert.equal((await pool.query("SELECT COUNT(*)::INTEGER AS count FROM push_notification_events WHERE category = 'check_due'")).rows[0].count, 0)
        assert.deepEqual(await checkStatuses(pool, [pendingCheckId, clearedCheckId, transferredCheckId, ownerCheckId]), statusesBefore)

        await updateSettings('check_due', true)
        const beforeFirst = pushRequests.length
        await dueModule.sendDueCheckNotifications({ today })
        assert.equal(pushRequests.length - beforeFirst, 2)
        const beforeDuplicate = pushRequests.length
        await dueModule.sendDueCheckNotifications({ today })
        assert.equal(pushRequests.length, beforeDuplicate)
        assert.equal((await pool.query("SELECT COUNT(*)::INTEGER AS count FROM push_notification_events WHERE category = 'check_due'")).rows[0].count, 2)
      })

      await t.test('actual web-push requests are VAPID-authenticated and payload-encrypted', async () => {
        assert.ok(pushRequests.length >= 6)
        for (const request of pushRequests) {
          assert.equal(request.method, 'POST')
          assert.equal(request.headers['content-encoding'], 'aes128gcm')
          assert.match(request.headers.authorization, /^vapid t=.+, k=.+$/)
          assert.ok(request.body.length > 80)
          assert.equal(request.body.includes(Buffer.from('بيع جديد', 'utf8')), false)
        }
        const successfulEvents = await pool.query(
          `SELECT COUNT(*)::INTEGER AS count FROM push_notification_events
           WHERE success_count = 1 AND failure_count = 0 AND completed_at IS NOT NULL`,
        )
        assert.ok(successfulEvents.rows[0].count >= 6)
        const subscription = await pool.query(
          'SELECT last_success_at IS NOT NULL AS successful FROM push_subscriptions',
        )
        assert.equal(subscription.rows[0].successful, true)
      })

      await t.test('a failed financial transaction emits no event or push request', async () => {
        const requestsBefore = pushRequests.length
        const eventsBefore = Number((await pool.query('SELECT COUNT(*) AS count FROM push_notification_events')).rows[0].count)
        const failed = await api('/sales', {
          storeId: salam.id, method: 'POST',
          body: {
            invoiceNumber: 'G8-FAIL-BEFORE-COMMIT', businessDate: today,
            customerId: customer.id, invoiceDiscount: '0',
            items: [{ productId: product.id, quantity: '999999', actualPrice: '30', discount: '0' }],
            payments: [],
          },
        })
        assert.equal(failed.response.status, 409, JSON.stringify(failed.body))
        assert.equal((await pool.query("SELECT COUNT(*)::INTEGER AS count FROM sales WHERE document_number = 'G8-FAIL-BEFORE-COMMIT'")).rows[0].count, 0)
        assert.equal(pushRequests.length, requestsBefore)
        assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM push_notification_events')).rows[0].count), eventsBefore)
      })

      await t.test('successful bounced-check notification follows commit while its disabled counterpart did not send', async () => {
        const dummyCustomer = (await api('/customers', {
          storeId: salam.id, method: 'POST', body: { name: 'عميل إشعار مرتجع معتمد' },
        })).body.customer
        await updateSettings('sale_created', false)
        await updateSettings('customer_payment', false)
        const dummySale = await api('/sales', {
          storeId: salam.id, method: 'POST',
          body: {
            invoiceNumber: 'G8-NOTIFY-BOUNCE-SEED', businessDate: '2099-01-01',
            customerId: dummyCustomer.id, invoiceDiscount: '0',
            items: [{ productId: product.id, quantity: '1', actualPrice: '20', discount: '0' }], payments: [],
          },
        })
        assert.equal(dummySale.response.status, 201)
        const checkPayment = await api(`/customers/${dummyCustomer.id}/payments`, {
          storeId: salam.id, method: 'POST',
          body: { payments: [{ method: 'check', amount: '10', checkNumber: 'G8-NOTIFY-BOUNCE', dueDate: today }] },
        })
        assert.equal(checkPayment.response.status, 201)
        await updateSettings('check_bounced', true)
        const checkId = checkPayment.body.payment.payments[0].id
        const requestsBefore = pushRequests.length
        const bounced = await api(`/checks/${checkId}/bounce`, { storeId: salam.id, method: 'POST' })
        assert.equal(bounced.response.status, 200)
        assert.equal(pushRequests.length - requestsBefore, 1)
        const event = await eventRow(pool, 'check_bounced', checkId)
        assert.deepEqual([event.success_count, event.failure_count], [1, 0])
        await updateSettings('sale_created', true)
        await updateSettings('customer_payment', true)
      })

      await t.test('controlled 410 removes the subscription after the sale remains committed', async () => {
        pushMode = 'gone'
        const sale = await api('/sales', {
          storeId: salam.id, method: 'POST',
          body: {
            invoiceNumber: 'G8-PUSH-410-COMMITTED', businessDate: '2099-01-02',
            customerId: customer.id, invoiceDiscount: '0',
            items: [{ productId: product.id, quantity: '1', actualPrice: '20', discount: '0' }], payments: [],
          },
        })
        assert.equal(sale.response.status, 201, JSON.stringify(sale.body))
        assert.equal((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM sales WHERE id = $1', [sale.body.sale.id])).rows[0].count, 1)
        const event = await eventRow(pool, 'sale_created', sale.body.sale.id)
        assert.deepEqual([event.success_count, event.failure_count], [0, 1])
        assert.equal((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM push_subscriptions')).rows[0].count, 0)
        pushMode = 'success'
        await subscribe()
      })

      await t.test('temporary push network failure is isolated after a committed purchase and retains the subscription', async () => {
        pushMode = 'drop'
        const purchase = await api('/purchases', {
          storeId: showroom.id, method: 'POST',
          body: {
            supplierId: supplier.id, documentNumber: 'G8-PUSH-NETWORK-COMMITTED', businessDate: '2099-01-02',
            items: [{ productId: product.id, quantity: '1', purchasePrice: '10' }], payments: [],
          },
        })
        assert.equal(purchase.response.status, 201, JSON.stringify(purchase.body))
        assert.equal((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM purchases WHERE id = $1', [purchase.body.purchase.id])).rows[0].count, 1)
        const event = await eventRow(pool, 'purchase_created', purchase.body.purchase.id)
        assert.deepEqual([event.success_count, event.failure_count], [0, 1])
        const subscription = await pool.query(
          'SELECT COUNT(*)::INTEGER AS count, BOOL_AND(last_failure_at IS NOT NULL) AS failed FROM push_subscriptions',
        )
        assert.equal(subscription.rows[0].count, 1)
        assert.equal(subscription.rows[0].failed, true)
        pushMode = 'success'
      })

      await t.test('all six persisted notification preferences were disabled without blocking their business operation', async () => {
        for (const category of Object.keys(settings)) {
          await updateSettings(category, false)
          const status = await api('/push/status')
          assert.equal(status.body.settings[category], false)
          await updateSettings(category, true)
        }
        assert.equal(await eventCount(pool, 'sale_created', saleOne.id), 0)
        assert.equal(await eventCount(pool, 'purchase_created', purchaseOne.id), 0)
        assert.equal(await eventCount(pool, 'customer_payment', customerPaymentOff.payments[0].id), 0)
        assert.equal(await eventCount(pool, 'supplier_payment', supplierPaymentOff.payments[0].id), 0)
        assert.equal(await eventCount(pool, 'check_bounced', transferredCheckId), 0)
        assert.equal(await eventCount(pool, 'customer_payment', customerPaymentOn.payments[0].id), 1)
        assert.equal(await eventCount(pool, 'supplier_payment', supplierPaymentOn.payments[0].id), 1)
      })

      await t.test('financial verification finds no drift in the complete approval scenario', async () => {
        const verification = await api('/verification/financial')
        assert.equal(verification.response.status, 200, JSON.stringify(verification.body))
        assert.equal(verification.body.status, 'ok')
        assert.deepEqual(
          verification.body.sections.map(({ key, status, issueCount }) => ({ key, status, issueCount })),
          ['sales', 'customers', 'suppliers', 'inventory', 'cash', 'bank', 'checks', 'reversals']
            .map((key) => ({ key, status: 'ok', issueCount: 0 })),
        )
      })

      console.log(`GROUP8_APPROVAL_CONTEXT ${JSON.stringify({
        customerId: customer.id, supplierId: supplier.id,
        invoiceNumber: saleOne.invoice_number, saleId: saleOne.id,
        salamStoreId: salam.id, showroomStoreId: showroom.id,
        today, projectOneId: projectOne.id, projectTwoId: projectTwo.id,
      })}`)
    } finally {
      await new Promise((resolve) => apiServer.close(resolve))
      await new Promise((resolve) => pushServer.close(resolve))
      await pool.end()
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    }
  },
)

async function assertDisposableDatabase(pool) {
  const result = await pool.query(
    'SELECT current_database() AS database, inet_server_port() AS port, version() AS version',
  )
  assert.equal(result.rows[0].database, 'group8_approval')
  assert.ok(Number(result.rows[0].port) >= 55000)
  assert.match(result.rows[0].version, /PostgreSQL 18\./)
}

async function resetDisposableBusinessData(pool) {
  await pool.query(`TRUNCATE TABLE
    auth_sessions, audit_log, bank_movements, financial_movements,
    push_notification_events, push_subscriptions, push_notification_preferences,
    customer_return_items, customer_returns, supplier_return_items, supplier_returns,
    inventory_cost_movements, inventory_movements, sale_items, sales,
    purchase_items, purchases, payments, checks, maintenance_reversals,
    maintenance_records, expenses, customer_ledger, supplier_ledger,
    customer_projects, customers, suppliers, store_inventory, barcodes, products, categories
    RESTART IDENTITY CASCADE`)
  await pool.query('DELETE FROM system_settings')
}

function allNotificationSettings(enabled) {
  return {
    sale_created: enabled,
    customer_payment: enabled,
    purchase_created: enabled,
    supplier_payment: enabled,
    check_due: enabled,
    check_bounced: enabled,
  }
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function normalized(value) {
  return new D(value).toFixed()
}

function money(actual, expected) {
  assert.equal(normalized(actual), normalized(expected))
}

function assertFinancial(actual, expected) {
  for (const [key, value] of Object.entries(expected)) money(actual[key], value)
}

function assertCash(actual, inflow, outflow, net) {
  assert.ok(actual)
  money(actual.inflow, inflow)
  money(actual.outflow, outflow)
  money(actual.net, net)
}

function assertCheck(actual, count, amount) {
  assert.ok(actual)
  assert.equal(actual.count, count)
  money(actual.amount, amount)
}

function reconcileStatement(statement, opening, closing) {
  money(statement.opening_balance, opening)
  let running = new D(opening)
  for (const entry of statement.entries) {
    running = running.plus(entry.debit).minus(entry.credit)
    money(entry.running_balance, running)
  }
  money(running, closing)
  money(statement.closing_balance, closing)
}

function reconcileSupplierStatement(statement, opening, closing) {
  money(statement.opening_balance, opening)
  let running = new D(opening)
  for (const entry of statement.entries) {
    running = running.plus(entry.credit).minus(entry.debit)
    money(entry.running_balance, running)
  }
  money(running, closing)
  money(statement.closing_balance, closing)
}

async function checkStatuses(pool, ids) {
  const result = await pool.query(
    'SELECT id::TEXT AS id, status FROM checks WHERE id = ANY($1::BIGINT[]) ORDER BY id',
    [ids],
  )
  return Object.fromEntries(result.rows.map((row) => [row.id, row.status]))
}

async function eventCount(pool, category, sourceId) {
  const result = await pool.query(
    `SELECT COUNT(*)::INTEGER AS count FROM push_notification_events
     WHERE category = $1 AND source_id = $2::BIGINT`,
    [category, sourceId],
  )
  return result.rows[0].count
}

async function eventRow(pool, category, sourceId) {
  const result = await pool.query(
    `SELECT success_count, failure_count, completed_at
     FROM push_notification_events WHERE category = $1 AND source_id = $2::BIGINT`,
    [category, sourceId],
  )
  assert.equal(result.rowCount, 1)
  assert.ok(result.rows[0].completed_at)
  return result.rows[0]
}

async function apiRequest(baseUrl, path, { token, storeId, method = 'GET', body } = {}) {
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (storeId) headers.set('X-Store-Id', storeId)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) headers.set('X-Request-Id', crypto.randomUUID())
  return jsonRequest(`${baseUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}
