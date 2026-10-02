import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'

const databaseUrl = process.env.CUSTOMER_LIMIT_INTEGRATION_DATABASE_URL

test('customer limits persist and reminders follow total outstanding debt', {
  skip: databaseUrl ? false : 'CUSTOMER_LIMIT_INTEGRATION_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = databaseUrl
  process.env.NODE_ENV = 'test'
  const [{ app }, { pool }, { provisionAdmin }] = await Promise.all([
    import('../src/app.js'), import('../src/db/pool.js'), import('../src/auth/provision-admin.js'),
  ])
  const username = `debt_test_${randomBytes(8).toString('hex')}`
  const password = randomBytes(32).toString('base64url')
  await provisionAdmin(pool, { username, password, displayName: 'Debt limit test' })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api`
  let token
  let storeId
  async function api(path, body, method = 'GET', authenticated = true) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}),
        ...(storeId ? { 'X-Store-Id': storeId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    const login = await api('/auth/login', { username, password }, 'POST')
    assert.equal(login.status, 201)
    token = login.body.token
    const stores = (await api('/stores')).body.stores
    storeId = stores[0].id
    assert.ok(stores[1])
    assert.equal((await api('/customers/debt-reminders', undefined, 'GET', false)).status, 401)

    const create = async (name, debtLimitIls) => {
      const result = await api('/customers', { name: `${name} ${username}`, phone: '0599000000', debtLimitIls }, 'POST')
      assert.equal(result.status, 201)
      return result.body.customer
    }
    const reached = await create('Debt test reached', '100.50')
    const below = await create('Debt test below', '101')
    const unlimited = await create('Debt test unlimited', null)
    const zero = await create('Debt test zero', '0')
    const inactive = await create('Debt test inactive', '10')
    assert.equal(reached.debt_limit_ils, '100.50')
    const movement = (id, amount, direction = 'debit', atStore = storeId) => pool.query(
      `INSERT INTO customer_ledger (store_id, customer_id, direction, amount_ils, source_type, occurred_at)
       VALUES ($1, $2, $3, $4::NUMERIC, 'opening', NOW())`, [atStore, id, direction, amount],
    )
    await movement(reached.id, '60')
    await movement(reached.id, '40.50', 'debit', stores[1].id)
    await movement(below.id, '100.50')
    await movement(unlimited.id, '9999')
    await movement(inactive.id, '100')
    await pool.query('UPDATE customers SET is_active = FALSE WHERE id = $1', [inactive.id])
    const ids = async () => {
      const result = await api('/customers/debt-reminders')
      assert.equal(result.status, 200)
      return result.body.customers.map((customer) => customer.id)
    }
    assert.ok((await ids()).includes(reached.id))
    for (const customer of [below, unlimited, zero, inactive]) assert.ok(!(await ids()).includes(customer.id))
    storeId = stores[1].id
    assert.ok((await ids()).includes(reached.id), 'Uses global debt from either store')
    assert.equal((await api(`/customers/${reached.id}`)).body.customer.debt_limit_ils, '100.50')
    const list = await api(`/customers?search=${encodeURIComponent(reached.name)}`)
    assert.equal(list.body.customers[0].debt_limit_ils, '100.50')

    const omitted = await api(`/customers/${reached.id}`, { name: reached.name }, 'PATCH')
    assert.equal(omitted.body.customer.debt_limit_ils, '100.50', 'Omitted field preserves limit')
    assert.equal((await api(`/customers/${reached.id}`, { name: reached.name, debtLimitIls: '-1' }, 'PATCH')).status, 400)
    await movement(reached.id, '0.50', 'credit')
    assert.ok(!(await ids()).includes(reached.id), 'Payment below limit removes reminder')
    await api(`/customers/${reached.id}`, { name: reached.name, debtLimitIls: '99' }, 'PATCH')
    assert.ok((await ids()).includes(reached.id), 'Lowered limit triggers reminder')
    await api(`/customers/${reached.id}`, { name: reached.name, debtLimitIls: '' }, 'PATCH')
    assert.ok(!(await ids()).includes(reached.id), 'Blank disables reminder')
    await movement(zero.id, '0.50')
    assert.ok((await ids()).includes(zero.id), 'Zero limit alerts on positive debt')
    await movement(zero.id, '1', 'credit')
    assert.ok(!(await ids()).includes(zero.id), 'Credit balance has no reminder')
    await assert.rejects(pool.query('UPDATE customers SET debt_limit_ils = -1 WHERE id = $1', [zero.id]), { code: '23514' })
    await assert.rejects(pool.query('UPDATE customers SET debt_limit_ils = 0.001 WHERE id = $1', [zero.id]), { code: '23514' })

    // Promises remain visible while future dates suppress notifications, even above the limit.
    const reminders = async () => (await api('/customers/reminders')).body.customers
    const reminderFor = async (id) => (await reminders()).find((row) => row.id === id)
    await api(`/customers/${below.id}`, { name: below.name, debtLimitIls: '50' }, 'PATCH')
    assert.equal((await reminderFor(below.id)).needs_notification, true)
    assert.equal((await api(`/customers/${below.id}/payment-promise`, { date: '2027-02-29' }, 'PUT')).status, 400)
    let promise = await api(`/customers/${below.id}/payment-promise`, { date: '2099-01-01', note: 'Next visit' }, 'PUT')
    assert.equal(promise.status, 200)
    const future = await reminderFor(below.id)
    assert.equal(future.limit_reached, true)
    assert.equal(future.promise_due, false)
    assert.equal(future.needs_notification, false)
    assert.equal((await api(`/customers/${below.id}`)).body.customer.payment_promise_date, '2099-01-01')
    const staleVersion = promise.body.promise.payment_promise_version
    const { getCustomerReminders } = await import('../src/customers/customer-reminders.js')
    const onDate = await getCustomerReminders({ dbQuery: pool.query.bind(pool), today: '2099-01-01' })
    assert.equal(onDate.customers.find((row) => row.id === below.id).needs_notification, true)
    const afterDate = await getCustomerReminders({ dbQuery: pool.query.bind(pool), today: '2099-01-02' })
    assert.equal(afterDate.customers.find((row) => row.id === below.id).needs_notification, true)

    promise = await api(`/customers/${below.id}/payment-promise`, { date: '2000-01-01' }, 'PUT')
    assert.equal((await reminderFor(below.id)).promise_due, true)
    assert.equal((await api(`/customers/${below.id}/payment-promise/complete`, { version: staleVersion }, 'POST')).status, 409)
    const beforeCompletion = (await reminderFor(below.id)).balance_ils
    assert.equal((await api(`/customers/${below.id}/payment-promise/complete`, { version: promise.body.promise.payment_promise_version }, 'POST')).status, 200)
    const completed = await reminderFor(below.id)
    assert.equal(completed.payment_promise_date, null)
    assert.equal(completed.balance_ils, beforeCompletion, 'Closing a promise does not fabricate a payment')
    assert.equal(completed.needs_notification, true, 'Outstanding debt still triggers the limit reminder')
    await movement(below.id, '100', 'credit')
    assert.equal(await reminderFor(below.id), undefined, 'Recorded payment below limit stops reminder')

    // A promise does not require a configured debt limit.
    promise = await api(`/customers/${unlimited.id}/payment-promise`, { date: '2000-01-01' }, 'PUT')
    assert.equal((await reminderFor(unlimited.id)).needs_notification, true)
    await api(`/customers/${unlimited.id}/payment-promise/complete`, { version: promise.body.promise.payment_promise_version }, 'POST')
    assert.equal(await reminderFor(unlimited.id), undefined)

    const preferences = await api('/push/status')
    assert.equal(preferences.body.settings.customer_reminder, true)
    const changed = await api('/push/settings', { ...preferences.body.settings, customer_reminder: false }, 'PUT')
    assert.equal(changed.status, 200)
    assert.equal(changed.body.settings.customer_reminder, false)

    // Use the real event table and a fake delivery provider: one event per customer per day.
    const { notifyAdminAfterCommit } = await import('../src/notifications/push-service.js')
    let sends = 0
    const deliveryOptions = {
      configured: true,
      dbQuery: (sql, params) => sql.includes('FROM push_subscriptions AS subscriptions')
        ? Promise.resolve({ rowCount: 1, rows: [{ id: '9999999', endpoint: 'https://push.example/test', p256dh_key: 'key', auth_key: 'key' }] })
        : pool.query(sql, params),
      pushClient: { sendNotification: async () => { sends += 1 } },
    }
    const event = {
      category: 'customer_reminder', sourceType: 'customer_reminder:2099-01-01', sourceId: below.id,
      businessDate: '2099-01-01', title: 'Reminder', body: 'Open app',
    }
    assert.equal((await notifyAdminAfterCommit(event, deliveryOptions)).successes, 1)
    assert.equal((await notifyAdminAfterCommit(event, deliveryOptions)).skipped, 'duplicate')
    assert.equal((await notifyAdminAfterCommit({ ...event, sourceType: 'customer_reminder:2099-01-02', businessDate: '2099-01-02' }, deliveryOptions)).successes, 1)
    assert.equal(sends, 2)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await pool.end()
  }
})
