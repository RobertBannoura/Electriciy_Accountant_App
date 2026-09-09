const http = require('node:http')
const port = Number(process.env.GROUP6_MOCK_PORT || 3001)
const clientOrigin = process.env.GROUP6_CLIENT_ORIGIN || 'http://localhost:5186'

const user = { id: '1', username: 'qa', displayName: 'مدير الاختبار', role: 'admin' }
const stores = [{ id: '1', code: 'QA', name: 'متجر QA' }]
const suppliers = [
  { id: '7', name: 'شركة النور', phone: null, address: null, notes: null, balance_ils: '1500' },
  { id: '8', name: 'مؤسسة الأمان', phone: null, address: null, notes: null, balance_ils: '900' },
]
const today = businessDate()
const oldDate = offsetBusinessDays(today, -4)
let reminderDays = 3
let nextId = 10
const checks = [
  check({ id: '1', check_number: '12345', amount: '2000', due_date: today, customer_id: '11', customer_name: 'أحمد' }),
  check({ id: '2', check_number: 'G-200', amount: '750', due_date: oldDate, customer_id: '12', customer_name: 'سامي', is_giro: true, original_owner_name: 'يوسف', original_owner_phone: '0599000000', supplier_id: '7', supplier_name: 'شركة النور', transferred_at: today }),
  check({ id: '3', check_number: 'O-300', amount: '500', due_date: oldDate, status: 'bounced', customer_id: null, customer_name: null, supplier_id: '8', supplier_name: 'مؤسسة الأمان', is_owner_issued: true }),
  check({ id: '4', check_number: 'C-400', amount: '300', due_date: oldDate, status: 'cleared', customer_id: '13', customer_name: 'ليلى' }),
]

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, null)
  const url = new URL(request.url, 'http://localhost:3000')
  try {
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      return send(response, 201, { token: 'qa-token', user })
    }
    if (url.pathname === '/api/auth/me') return send(response, 200, { user })
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') return send(response, 204, null)
    if (url.pathname === '/api/stores') return send(response, 200, { stores })
    if (url.pathname === '/api/suppliers') return send(response, 200, { suppliers })

    if (url.pathname === '/api/checks/reminders') {
      return send(response, 200, {
        reminders: {
          business_days: reminderDays,
          due_today: checks.filter((item) => item.status === 'pending' && item.due_date === today && !item.reminder_snoozed_until),
          follow_up: checks.filter((item) => item.status === 'pending' && item.due_date <= oldDate && !item.reminder_snoozed_until),
          bounced: checks.filter((item) => item.status === 'bounced' && !item.bounced_reminder_stopped_at),
        },
      })
    }
    if (url.pathname === '/api/checks/reminder-settings') {
      if (request.method === 'GET') return send(response, 200, { businessDays: reminderDays })
      const body = await readBody(request)
      reminderDays = body.businessDays
      return send(response, 200, { businessDays: reminderDays })
    }
    if (url.pathname === '/api/checks' && request.method === 'GET') {
      const status = url.searchParams.get('status')
      const search = (url.searchParams.get('search') || '').toLocaleLowerCase('ar')
      const visible = checks.filter((item) => (!status || item.status === status)
        && (!search || [item.check_number, item.customer_name, item.supplier_name, item.original_owner_name, item.original_owner_phone]
          .some((value) => value?.toLocaleLowerCase('ar').includes(search))))
      return send(response, 200, { checks: visible })
    }
    if (url.pathname === '/api/checks/owner-issued' && request.method === 'POST') {
      const body = await readBody(request)
      const supplier = suppliers.find((item) => item.id === body.supplierId)
      const item = check({ id: String(nextId++), check_number: body.checkNumber, amount: body.amount, due_date: body.dueDate, notes: body.notes || null, customer_id: null, customer_name: null, supplier_id: supplier.id, supplier_name: supplier.name, is_owner_issued: true })
      checks.unshift(item)
      supplier.balance_ils = String(Number(supplier.balance_ils) - Number(body.amount))
      return send(response, 201, { check: item })
    }

    const action = /^\/api\/checks\/(\d+)\/(clear|bounce|later|stop-bounced-reminder|transfer)$/.exec(url.pathname)
    if (action && request.method === 'POST') {
      const item = checks.find((candidate) => candidate.id === action[1])
      if (!item) return error(response, 404, 'الشيك غير موجود')
      if (action[2] === 'clear') item.status = 'cleared'
      if (action[2] === 'bounce') item.status = 'bounced'
      if (action[2] === 'later') item.reminder_snoozed_until = offsetBusinessDays(today, 1)
      if (action[2] === 'stop-bounced-reminder') item.bounced_reminder_stopped_at = new Date().toISOString()
      if (action[2] === 'transfer') {
        const body = await readBody(request)
        const supplier = suppliers.find((candidate) => candidate.id === body.supplierId)
        item.supplier_id = supplier.id
        item.supplier_name = supplier.name
        item.transferred_at = body.transferDate
        supplier.balance_ils = String(Number(supplier.balance_ils) - Number(item.amount))
      }
      return send(response, action[2] === 'transfer' ? 201 : 200, { check: item })
    }

    return error(response, 404, 'مسار QA غير موجود')
  } catch (caught) {
    return error(response, 500, caught instanceof Error ? caught.message : 'خطأ QA')
  }
})

server.listen(port, '127.0.0.1', () => console.log(`Group 6 mock API listening on http://127.0.0.1:${port}`))

function check(overrides) {
  return {
    id: '', check_number: '', amount: '0', currency_code: 'ILS', due_date: today,
    status: 'pending', notes: null, sale_id: null, maintenance_id: null,
    customer_id: null, customer_name: null, is_giro: false,
    original_owner_name: null, original_owner_phone: null,
    supplier_id: null, supplier_name: null, transferred_at: null,
    is_owner_issued: false, bounced_reminder_stopped_at: null,
    reminder_snoozed_until: null, ...overrides,
  }
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

function error(response, status, message) {
  return send(response, status, { error: { code: 'QA_ERROR', message } })
}

async function readBody(request) {
  let value = ''
  for await (const chunk of request) value += chunk
  return value ? JSON.parse(value) : {}
}

function businessDate() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const value = (type) => parts.find((part) => part.type === type).value
  return `${value('year')}-${value('month')}-${value('day')}`
}

function offsetBusinessDays(value, offset) {
  const date = new Date(`${value}T00:00:00Z`)
  let remaining = Math.abs(offset)
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + Math.sign(offset))
    if (![5, 6].includes(date.getUTCDay())) remaining -= 1
  }
  return date.toISOString().slice(0, 10)
}
