const http = require('node:http')
const Decimal = require('decimal.js').clone({ precision: 100 })

const port = Number(process.env.GROUP8_MOCK_PORT || 39001)
const clientOrigin = process.env.GROUP8_CLIENT_ORIGIN || 'http://localhost:39002'
const user = { id: '1', username: 'qa-admin', displayName: 'مدير الاختبار', role: 'admin' }
const stores = [
  { id: '1', code: 'SALAM', name: 'كهرباء السلام' },
  { id: '2', code: 'SHOWROOM', name: 'المعرض' },
]
const customer = {
  id: '11', name: 'أحمد الخطيب', phone: '0599000000', address: 'رام الله', notes: null,
  balance_ils: '2150',
}
const supplier = {
  id: '21', name: 'شركة النور', phone: '022900000', address: 'البيرة', notes: null,
  balance_ils: '3100',
}
let nextId = 100
const categories = [
  { id: '51', name: 'كوابل' },
  { id: '52', name: 'قواطع' },
]
let products = [{
  id: '41',
  name: 'كابل كهرباء 3×2.5',
  category_id: '51',
  category_name: 'كوابل',
  sale_unit: 'متر',
  current_purchase_price: '10',
  default_sale_price: '15',
  notes: null,
  barcode: '7290000000418',
  total_quantity: '165',
  inventories: [
    {
      store_id: '1',
      store_name: 'كهرباء السلام',
      quantity: '120',
      reorder_level: '20',
      low_stock: false,
      inventory_value: '1200',
      weighted_average_cost: '10',
    },
    {
      store_id: '2',
      store_name: 'المعرض',
      quantity: '45',
      reorder_level: '10',
      low_stock: false,
      inventory_value: '450',
      weighted_average_cost: '10',
    },
  ],
}]
const inventoryMovements = {
  41: [{
    id: '701',
    store_id: '1',
    store_name: 'كهرباء السلام',
    movement_type: 'opening',
    quantity_delta: '120',
    reason: 'رصيد افتتاحي',
    occurred_at: '2026-01-01T08:00:00.000Z',
  }],
}
let suppliers = [supplier]
let expenses = [{
  id: '71',
  category: 'كهرباء',
  amount: '180',
  date: '2026-09-09',
  payment_method: 'cash',
  notes: 'فاتورة كهرباء',
  store_name: 'كهرباء السلام',
}]
let purchases = [{
  id: '81',
  document_number: 'P-2081',
  business_date: '2026-09-09',
  status: 'posted',
  currency_code: 'ILS',
  total: '3000',
  store_name: 'كهرباء السلام',
}]
const projects = [
  { id: '31', customer_id: customer.id, name: 'عمارة النور', notes: null, created_at: '2026-01-02T08:00:00.000Z' },
]
const baseSettings = {
  sale_created: true,
  customer_payment: true,
  purchase_created: true,
  supplier_payment: true,
  check_due: true,
  check_bounced: true,
}
let pushSettings = { ...baseSettings }

const report = {
  filters: { from: '2026-09-01', to: '2026-09-09', store_id: null },
  summary: {
    sales: '15850', purchases: '7200', cost_of_goods: '9100', gross_profit: '6750',
    expenses: '1250', net_profit: '5500', sales_returns: '350', purchase_returns: '200',
    customer_debt: '7250', indebted_customers: '4', supplier_debt: '6100', owed_suppliers: '3',
    inventory_value: '48750', inventory_lines: '116', low_stock_count: '7',
    inflow_ils: '19600', outflow_ils: '11200', net_ils: '8400', check_count: '5',
    cash_movements: [
      { currency_code: 'ILS', inflow: '19600', outflow: '11200', net: '8400' },
      { currency_code: 'USD', inflow: '500', outflow: '120', net: '380' },
    ],
    checks: [
      { status: 'pending', count: '3', amount: '4750' },
      { status: 'cleared', count: '1', amount: '1000' },
      { status: 'bounced', count: '1', amount: '1500' },
    ],
  },
  store_comparison: [
    { store_id: '1', store_name: 'كهرباء السلام', sales: '10000', purchases: '4200', gross_profit: '4100', expenses: '750', net_profit: '3350' },
    { store_id: '2', store_name: 'المعرض', sales: '5850', purchases: '3000', gross_profit: '2650', expenses: '500', net_profit: '2150' },
  ],
}

const supplierPurchaseItems = [
  { product: 'سلك نحاس 1.5 ملم', quantity: '100', unit_price: '2.5', line_total: '250' },
  { product: 'سلك نحاس 2.5 ملم', quantity: '80', unit_price: '4', line_total: '320' },
  { product: 'كابل كهرباء 3×2.5', quantity: '60', unit_price: '8', line_total: '480' },
  { product: 'لمبة LED قوة 12 واط', quantity: '60', unit_price: '8', line_total: '480' },
  { product: 'كشاف LED خارجي 50 واط', quantity: '15', unit_price: '45', line_total: '675' },
  { product: 'قاطع كهربائي 16 أمبير', quantity: '40', unit_price: '18', line_total: '720' },
  { product: 'قاطع تفاضلي 40 أمبير', quantity: '10', unit_price: '85', line_total: '850' },
  { product: 'لوحة توزيع 12 خط', quantity: '15', unit_price: '55', line_total: '825' },
  { product: 'مفتاح إنارة مفرد', quantity: '50', unit_price: '7', line_total: '350' },
  { product: 'مأخذ كهرباء مزدوج', quantity: '40', unit_price: '10', line_total: '400' },
  { product: 'علبة فحص كهربائي', quantity: '30', unit_price: '5', line_total: '150' },
  { product: 'شريط عازل كهربائي', quantity: '100', unit_price: '3', line_total: '300' },
]

const customerStatement = {
  kind: 'customer', party: customer, project: projects[0], from: '2026-01-01', to: '2026-09-09',
  opening_balance: '1250', closing_balance: '2150',
  entries: statementEntries('customer'),
}
const supplierStatement = {
  kind: 'supplier', party: supplier, project: null, from: '2026-01-01', to: '2026-09-09',
  opening_balance: '900', closing_balance: '3100',
  entries: statementEntries('supplier'),
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, null)
  const url = new URL(request.url, `http://127.0.0.1:${port}`)
  try {
    if (url.pathname === '/api/auth/login' && request.method === 'POST') return send(response, 201, { token: 'group8-qa-token', user })
    if (url.pathname === '/api/auth/me') return send(response, 200, { user })
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') return send(response, 204, null)
    if (url.pathname === '/api/stores') return send(response, 200, { stores })
    if (url.pathname === '/api/reports/home') return send(response, 200, {
      summary: {
        date: '2026-09-09', today_sales: '1250', customer_debt: '7250', supplier_debt: '6100',
        cash_balances: [{ currency_code: 'ILS', balance: '8450' }, { currency_code: 'USD', balance: '380' }],
        bank_balance_ils: '4200', cash_and_bank_ils: '12650', checks_needing_follow_up: '3',
        low_stock_count: '7', recent_activity: [
          { kind: 'sale', id: '91', document_number: 'S-1091', amount: '1250', business_date: '2026-09-09' },
          { kind: 'purchase', id: '81', document_number: 'P-2081', amount: '3000', business_date: '2026-09-09' },
          { kind: 'expense', id: '71', document_number: 'E-71', amount: '180', business_date: '2026-09-09' },
        ],
      },
    })
    if (url.pathname === '/api/reports') return send(response, 200, {
      ...report,
      filters: {
        from: url.searchParams.get('from') || report.filters.from,
        to: url.searchParams.get('to') || report.filters.to,
        store_id: url.searchParams.get('storeId'),
      },
    })
    if (url.pathname === '/api/categories' && request.method === 'GET') return send(response, 200, { categories })
    if (url.pathname === '/api/categories' && request.method === 'POST') {
      const body = await readBody(request)
      const category = { id: String(nextId++), name: String(body.name || '').trim() || 'تصنيف QA' }
      categories.push(category)
      return send(response, 201, { category })
    }
    const categoryMatch = /^\/api\/categories\/(\d+)$/.exec(url.pathname)
    if (categoryMatch && request.method === 'PATCH') {
      const body = await readBody(request)
      const category = categories.find((item) => item.id === categoryMatch[1])
      if (!category) return send(response, 404, { error: { message: 'التصنيف غير موجود' } })
      category.name = String(body.name || category.name).trim()
      for (const product of products) {
        if (product.category_id === category.id) product.category_name = category.name
      }
      return send(response, 200, { category })
    }
    if (url.pathname === '/api/products' && request.method === 'GET') return send(response, 200, {
      products: products.filter((product) => {
        const name = url.searchParams.get('name')?.trim()
        const barcode = url.searchParams.get('barcode')?.trim()
        const categoryId = url.searchParams.get('categoryId')
        const storeId = url.searchParams.get('storeId')
        const lowStock = url.searchParams.get('lowStock') === 'true'
        return (!name || product.name.includes(name))
          && (!barcode || product.barcode === barcode)
          && (!categoryId || product.category_id === categoryId)
          && (!storeId || product.inventories.some((item) => item.store_id === storeId))
          && (!lowStock || product.inventories.some((item) => item.low_stock))
      }),
    })
    if (url.pathname === '/api/products' && request.method === 'POST') {
      const body = await readBody(request)
      const category = categories.find((item) => item.id === body.categoryId) || categories[0]
      const product = {
        id: String(nextId++),
        name: String(body.name || 'صنف QA').trim(),
        category_id: category.id,
        category_name: category.name,
        sale_unit: body.saleUnit === 'قطعة' ? 'قطعة' : 'متر',
        current_purchase_price: body.currentPurchasePrice || null,
        default_sale_price: body.defaultSalePrice || null,
        notes: body.notes || null,
        barcode: body.barcode || null,
        total_quantity: '0',
        inventories: (body.inventorySettings || []).map((setting) => {
          const store = stores.find((item) => item.id === setting.storeId) || stores[0]
          return {
            store_id: store.id,
            store_name: store.name,
            quantity: setting.openingQuantity || '0',
            reorder_level: setting.reorderLevel || '0',
            low_stock: new Decimal(setting.openingQuantity || '0').lte(setting.reorderLevel || '0'),
            inventory_value: '0',
            weighted_average_cost: body.currentPurchasePrice || '0',
          }
        }),
      }
      product.total_quantity = product.inventories.reduce((sum, item) => sum.plus(item.quantity), new Decimal(0)).toFixed()
      products.push(product)
      inventoryMovements[product.id] = []
      return send(response, 201, { product })
    }
    const productMatch = /^\/api\/products\/(\d+)$/.exec(url.pathname)
    if (productMatch && request.method === 'PATCH') {
      const body = await readBody(request)
      const product = products.find((item) => item.id === productMatch[1])
      if (!product) return send(response, 404, { error: { message: 'الصنف غير موجود' } })
      const category = categories.find((item) => item.id === body.categoryId) || categories.find((item) => item.id === product.category_id)
      Object.assign(product, {
        name: String(body.name || product.name).trim(),
        category_id: category.id,
        category_name: category.name,
        sale_unit: body.saleUnit === 'قطعة' ? 'قطعة' : 'متر',
        current_purchase_price: body.currentPurchasePrice || null,
        default_sale_price: body.defaultSalePrice || null,
        notes: body.notes || null,
        barcode: body.barcode || null,
      })
      return send(response, 200, { product })
    }
    if (productMatch && request.method === 'DELETE') {
      products = products.filter((item) => item.id !== productMatch[1])
      return send(response, 204, null)
    }
    const barcodeMatch = /^\/api\/products\/(\d+)\/barcode\/generate$/.exec(url.pathname)
    if (barcodeMatch && request.method === 'POST') {
      const product = products.find((item) => item.id === barcodeMatch[1])
      if (!product) return send(response, 404, { error: { message: 'الصنف غير موجود' } })
      product.barcode = `7290000${product.id.padStart(5, '0')}`
      return send(response, 200, { barcode: product.barcode })
    }
    const movementsMatch = /^\/api\/products\/(\d+)\/inventory-movements$/.exec(url.pathname)
    if (movementsMatch && request.method === 'GET') {
      return send(response, 200, { movements: inventoryMovements[movementsMatch[1]] || [], pagination: { hasMore: false } })
    }
    if (movementsMatch && request.method === 'POST') {
      const body = await readBody(request)
      const product = products.find((item) => item.id === movementsMatch[1])
      if (!product) return send(response, 404, { error: { message: 'الصنف غير موجود' } })
      const store = stores.find((item) => item.id === body.storeId) || stores[0]
      const movement = {
        id: String(nextId++),
        store_id: store.id,
        store_name: store.name,
        movement_type: body.movementType || 'correction',
        quantity_delta: body.quantityDelta || '0',
        reason: body.reason || null,
        occurred_at: new Date().toISOString(),
      }
      inventoryMovements[product.id] = [movement, ...(inventoryMovements[product.id] || [])]
      const inventory = product.inventories.find((item) => item.store_id === store.id)
      if (inventory) {
        inventory.quantity = new Decimal(inventory.quantity).plus(movement.quantity_delta).toFixed()
        product.total_quantity = product.inventories.reduce((sum, item) => sum.plus(item.quantity), new Decimal(0)).toFixed()
      }
      return send(response, 201, { movement })
    }
    if (url.pathname === '/api/sales' && request.method === 'POST') {
      const body = await readBody(request)
      const items = (body.items || []).map((item, index) => ({
        id: String(900 + index), description: 'كابل كهرباء 3×2.5',
        quantity: String(item.quantity), actual_price: String(item.actualPrice),
        discount: String(item.discount || '0'),
        total: String(Number(item.quantity) * Number(item.actualPrice) - Number(item.discount || 0)),
      }))
      const itemsSubtotal = items.reduce((sum, item) => sum + Number(item.total), 0)
      const total = itemsSubtotal - Number(body.invoiceDiscount || 0)
      const paid = (body.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
      return send(response, 201, { sale: {
        id: '91', invoice_number: body.invoiceNumber, business_date: body.businessDate,
        items_subtotal: String(itemsSubtotal), invoice_discount: String(body.invoiceDiscount || 0),
        total: String(total), paid_total: String(paid), remaining_due: String(total - paid), items,
      } })
    }
    if (url.pathname === '/api/checks' && request.method === 'GET') return send(response, 200, {
      checks: [{ id: '61', check_number: 'CHK-61', amount: '2000', due_date: '2026-09-09', status: 'pending', customer_name: 'أحمد الخطيب', supplier_id: null }],
      pagination: { hasMore: false },
    })
    if (url.pathname === '/api/checks/reminders') return send(response, 200, {
      reminders: {
        business_days: 3,
        due_today: [{ id: '61', check_number: 'CHK-61', amount: '2000', due_date: '2026-09-09', status: 'pending', customer_name: 'أحمد الخطيب', supplier_name: null, is_owner_issued: false }],
        follow_up: [],
        bounced: [{ id: '62', check_number: 'CHK-62', amount: '1500', due_date: '2026-09-07', status: 'bounced', customer_name: 'أحمد الخطيب', supplier_name: null, is_owner_issued: false }],
      },
    })
    if (url.pathname === '/api/checks/reminder-settings' && request.method === 'GET') {
      return send(response, 200, { businessDays: 3 })
    }
    if (url.pathname === '/api/checks/reminder-settings' && request.method === 'PUT') {
      const body = await readBody(request)
      return send(response, 200, { businessDays: Number(body.businessDays || 3) })
    }
    if (url.pathname === '/api/customers' && request.method === 'GET') return send(response, 200, { customers: [customer] })
    if (url.pathname === `/api/customers/${customer.id}` && request.method === 'GET') return send(response, 200, {
      customer: {
        ...customer,
        store_balances: stores.map((store, index) => ({ store_id: store.id, store_name: store.name, amount_ils: index ? '650' : '1500' })),
        recent_sales: [{ id: '91', document_number: 'S-1091', business_date: '2026-09-09', status: 'posted', currency_code: 'ILS', project_id: '31', project_name: 'عمارة النور', total: '1250', store_name: 'كهرباء السلام' }],
        recent_maintenance: [], payments: [], checks: [], projects,
        recent_movements: [{ id: '501', direction: 'debit', amount_ils: '1250', occurred_at: '2026-09-09T08:30:00.000Z', source_type: 'sale', source_id: '91', notes: null, project_id: '31', project_name: 'عمارة النور', store_name: 'كهرباء السلام' }],
        selected_project_id: url.searchParams.get('projectId'), selected_store_id: url.searchParams.get('storeId'),
      },
    })
    if (url.pathname === `/api/customers/${customer.id}/statement` && request.method === 'GET') return send(response, 200, {
      statement: { ...customerStatement, from: url.searchParams.get('from') || customerStatement.from, to: url.searchParams.get('to') || customerStatement.to },
    })
    if (url.pathname === '/api/suppliers' && request.method === 'GET') return send(response, 200, {
      suppliers: suppliers.filter((item) => {
        const search = url.searchParams.get('search')?.trim()
        return !search || item.name.includes(search) || item.phone?.includes(search)
      }),
    })
    if (url.pathname === '/api/suppliers' && request.method === 'POST') {
      const body = await readBody(request)
      const created = { id: String(nextId++), name: String(body.name || 'مورد QA').trim(), phone: body.phone || null, address: body.address || null, notes: body.notes || null, balance_ils: '0' }
      suppliers.push(created)
      return send(response, 201, { supplier: created })
    }
    const supplierEditMatch = /^\/api\/suppliers\/(\d+)$/.exec(url.pathname)
    if (supplierEditMatch && request.method === 'PATCH') {
      const body = await readBody(request)
      const existing = suppliers.find((item) => item.id === supplierEditMatch[1])
      if (!existing) return send(response, 404, { error: { message: 'المورد غير موجود' } })
      Object.assign(existing, { name: String(body.name || existing.name).trim(), phone: body.phone || null, address: body.address || null, notes: body.notes || null })
      return send(response, 200, { supplier: existing })
    }
    if (url.pathname === `/api/suppliers/${supplier.id}` && request.method === 'GET') return send(response, 200, {
      supplier: {
        ...supplier,
        store_balances: stores.map((store, index) => ({ store_id: store.id, store_name: store.name, amount_ils: index ? '1100' : '2000' })),
        purchases,
        payments: [], checks: [], recent_movements: [{ id: '601', direction: 'debit', amount_ils: '3000', occurred_at: '2026-09-09T09:00:00.000Z', source_type: 'purchase', notes: null, store_name: 'كهرباء السلام' }],
        selected_store_id: url.searchParams.get('storeId'),
      },
    })
    if (url.pathname === `/api/suppliers/${supplier.id}/statement` && request.method === 'GET') return send(response, 200, {
      statement: { ...supplierStatement, from: url.searchParams.get('from') || supplierStatement.from, to: url.searchParams.get('to') || supplierStatement.to },
    })
    if (url.pathname === '/api/purchases' && request.method === 'POST') {
      const body = await readBody(request)
      const total = (body.items || []).reduce((sum, item) => sum.plus(new Decimal(item.quantity || '0').mul(item.purchasePrice || '0')), new Decimal(0))
      const paid = (body.payments || []).reduce((sum, payment) => sum.plus(payment.method === 'transferred_customer_check' ? '2000' : payment.amount || '0'), new Decimal(0))
      const purchaseId = String(nextId++)
      const purchase = {
        id: purchaseId,
        document_number: body.documentNumber || `P-${purchaseId.padStart(8, '0')}`,
        business_date: body.businessDate,
        status: 'recorded',
        currency_code: 'ILS',
        total: total.toFixed(),
        paid_total: paid.toFixed(),
        remaining_due: total.minus(paid).toFixed(),
        store_name: 'كهرباء السلام',
      }
      purchases = [purchase, ...purchases]
      supplier.balance_ils = new Decimal(supplier.balance_ils).plus(purchase.remaining_due).toFixed()
      return send(response, 201, { purchase })
    }
    if (url.pathname === '/api/expenses' && request.method === 'GET') return send(response, 200, {
      expenses,
      pagination: { hasMore: false },
    })
    if (url.pathname === '/api/expenses' && request.method === 'POST') {
      const body = await readBody(request)
      const expense = {
        id: String(nextId++),
        category: body.category,
        amount: body.amount,
        date: body.date,
        payment_method: body.paymentMethod === 'bank' ? 'bank_card' : 'cash',
        notes: body.notes || null,
        store_name: 'كهرباء السلام',
      }
      expenses = [expense, ...expenses]
      return send(response, 201, { expense })
    }
    if (url.pathname === '/api/push/status') return send(response, 200, { configured: false, publicKey: null, subscriptionCount: 0, settings: pushSettings })
    if (url.pathname === '/api/push/settings' && request.method === 'PUT') {
      pushSettings = { ...await readBody(request) }
      return send(response, 200, { settings: pushSettings })
    }
    return send(response, 404, { error: { code: 'QA_NOT_FOUND', message: 'مسار QA غير موجود' } })
  } catch (error) {
    return send(response, 500, { error: { code: 'QA_ERROR', message: error instanceof Error ? error.message : 'خطأ QA' } })
  }
})

server.listen(port, '127.0.0.1', () => console.log(`Group 8 mock API listening on http://127.0.0.1:${port}`))

function statementEntries(kind) {
  const labels = kind === 'customer'
    ? ['sale', 'payment', 'check', 'customer_return', 'correction']
    : ['purchase', 'supplier_payment', 'owner_check', 'supplier_return', 'correction']
  return Array.from({ length: 28 }, (_, index) => {
    const saleLike = index % 5 === 0
    const amount = saleLike ? '150' : '50'
    return {
      id: `${kind}-${index + 1}`, date: `2026-08-${String(index + 1).padStart(2, '0')}`,
      store_name: index % 2 ? 'المعرض' : 'كهرباء السلام', source_type: labels[index % labels.length],
      source_id: String(1001 + index), description: 'بيان عربي قابل للبحث والتحديد',
      document_number: `${kind === 'customer' ? 'S' : 'P'}-${1001 + index}`,
      project_name: kind === 'customer' ? 'عمارة النور' : null,
      check_number: labels[index % labels.length].includes('check') ? `C-${index + 1}` : null,
      check_status: null, payment_method: null,
      debit: saleLike ? amount : '0', credit: saleLike ? '0' : amount,
      running_balance: String((kind === 'customer' ? 1250 : 900) + (index + 1) * 25),
      purchase_items: kind === 'supplier' && saleLike
        ? supplierPurchaseItems
        : undefined,
    }
  })
}

function send(response, status, body) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': clientOrigin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Store-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    ...(body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
  })
  response.end(body === null ? undefined : JSON.stringify(body))
}

async function readBody(request) {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return raw ? JSON.parse(raw) : {}
}
