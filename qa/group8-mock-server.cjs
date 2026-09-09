const http = require('node:http')

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
    if (url.pathname === '/api/products' && request.method === 'GET') return send(response, 200, {
      products: [{
        id: '41', name: 'كابل كهرباء 3×2.5', sale_unit: 'متر',
        default_sale_price: '15', barcode: '7290000000418',
        inventories: [{ store_id: '1', quantity: '120' }, { store_id: '2', quantity: '45' }],
      }],
    })
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
    if (url.pathname === '/api/suppliers' && request.method === 'GET') return send(response, 200, { suppliers: [supplier] })
    if (url.pathname === `/api/suppliers/${supplier.id}` && request.method === 'GET') return send(response, 200, {
      supplier: {
        ...supplier,
        store_balances: stores.map((store, index) => ({ store_id: store.id, store_name: store.name, amount_ils: index ? '1100' : '2000' })),
        purchases: [{ id: '81', document_number: 'P-2081', business_date: '2026-09-09', status: 'posted', currency_code: 'ILS', total: '3000', store_name: 'كهرباء السلام' }],
        payments: [], checks: [], recent_movements: [{ id: '601', direction: 'debit', amount_ils: '3000', occurred_at: '2026-09-09T09:00:00.000Z', source_type: 'purchase', notes: null, store_name: 'كهرباء السلام' }],
        selected_store_id: url.searchParams.get('storeId'),
      },
    })
    if (url.pathname === `/api/suppliers/${supplier.id}/statement` && request.method === 'GET') return send(response, 200, {
      statement: { ...supplierStatement, from: url.searchParams.get('from') || supplierStatement.from, to: url.searchParams.get('to') || supplierStatement.to },
    })
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
        ? [{ product: 'كابل كهرباء', quantity: '10', unit_price: '15', line_total: '150' }]
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
