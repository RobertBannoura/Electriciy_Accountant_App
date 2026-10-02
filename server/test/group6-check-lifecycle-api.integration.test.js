import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'

const databaseUrl = process.env.GROUP6_INTEGRATION_DATABASE_URL

test(
  'Group 6 lifecycle combinations work end-to-end against PostgreSQL',
  { skip: databaseUrl ? false : 'GROUP6_INTEGRATION_DATABASE_URL is not configured' },
  async (t) => {
    process.env.DATABASE_URL = databaseUrl
    process.env.NODE_ENV = 'test'

    const [{ app }, { pool }, reminderModule, { provisionAdmin }] = await Promise.all([
      import('../src/app.js'),
      import('../src/db/pool.js'),
      import('../src/checks/check-reminders.js'),
      import('../src/auth/provision-admin.js'),
    ])
    const adminUsername = 'group6_integration_admin'
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
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const trackedCustomerIds = new Set()
    const trackedSupplierIds = new Set()
    const trackedCheckIds = new Set()

    try {
      const login = await jsonRequest(`${baseUrl}/auth/login`, {
        method: 'POST',
        body: { username: adminUsername, password: adminPassword },
      })
      assert.equal(login.response.status, 201)
      const token = login.body.token
      const stores = await api('/stores', { token })
      assert.equal(stores.response.status, 200)
      const storeId = stores.body.stores[0].id
      const otherStoreId = stores.body.stores[1]?.id
      assert.ok(otherStoreId, 'Check filtering requires two stores')

      await t.test('checks can be listed across stores or filtered to either store', async () => {
        const first = await createContext({ customerDebt: '50' })
        const second = await createContext({ customerDebt: '50', debtStoreId: otherStoreId })
        const search = `scope-${runId}`
        const firstCheckId = await receiveCheck(first.customerId, { amount: '10', label: `${search}-first` })
        const secondCheckId = await receiveCheck(second.customerId, {
          amount: '10', label: `${search}-second`, checkStoreId: otherStoreId,
        })
        const path = `/checks?search=${encodeURIComponent(search)}`

        const local = await api(path, { token, storeId })
        assert.equal(local.response.status, 200)
        assert.deepEqual(local.body.checks.map((check) => check.id), [firstCheckId])

        const combined = await api(`${path}&storeId=all`, { token, storeId })
        assert.equal(combined.response.status, 200)
        assert.deepEqual(new Set(combined.body.checks.map((check) => check.id)), new Set([firstCheckId, secondCheckId]))
        assert.ok(combined.body.checks.every((check) => check.store_id && check.store_name))

        const other = await api(`${path}&storeId=${otherStoreId}`, { token, storeId })
        assert.equal(other.response.status, 200)
        assert.deepEqual(other.body.checks.map((check) => check.id), [secondCheckId])

        const invalid = await api(`${path}&storeId=invalid`, { token, storeId })
        assert.equal(invalid.response.status, 400)
        assert.equal(invalid.body.error.code, 'INVALID_CHECK_STORE_FILTER')

        const cleared = await api(`/checks/${secondCheckId}/clear`, {
          token, storeId: otherStoreId, method: 'POST',
        })
        assert.equal(cleared.response.status, 200)
        assert.equal(await checkStatus(secondCheckId), 'cleared')
      })

      await t.test('customer receipt 5000 -> 3000 and clear has no second financial effect', async () => {
        const context = await createContext({ customerDebt: '5000' })
        const checkId = await receiveCheck(context.customerId, { amount: '2000', label: 'received-clear' })
        assert.equal(await customerBalance(context.customerId), '3000')
        const before = await lifecycleFacts(checkId)
        assert.deepEqual(before, { checks: 1, customerReceipts: 1, customerReversals: 0, supplierTransfers: 0, supplierReversals: 0 })

        const cleared = await api(`/checks/${checkId}/clear`, { token, storeId, method: 'POST' })
        assert.equal(cleared.response.status, 200)
        assert.equal(await checkStatus(checkId), 'cleared')
        assert.equal(await customerBalance(context.customerId), '3000')
        assert.deepEqual(await lifecycleFacts(checkId), before)
      })

      await t.test('customer bounce restores 3000 -> 5000 exactly once across a retry', async () => {
        const context = await createContext({ customerDebt: '5000' })
        const checkId = await receiveCheck(context.customerId, { amount: '2000', label: 'bounce-retry' })
        assert.equal(await customerBalance(context.customerId), '3000')
        const first = await api(`/checks/${checkId}/bounce`, { token, storeId, method: 'POST' })
        const second = await api(`/checks/${checkId}/bounce`, { token, storeId, method: 'POST' })
        assert.deepEqual([first.response.status, second.response.status], [200, 200])
        assert.equal(await customerBalance(context.customerId), '5000')
        const facts = await lifecycleFacts(checkId)
        assert.equal(facts.customerReversals, 1)
        assert.equal(facts.customerReceipts, 1)
        assert.equal(facts.checks, 1)
      })

      await t.test('two concurrent customer bounces lock one check and never double debt', async () => {
        const context = await createContext({ customerDebt: '5000' })
        const checkId = await receiveCheck(context.customerId, { amount: '2000', label: 'bounce-concurrent' })
        const responses = await Promise.all([
          api(`/checks/${checkId}/bounce`, { token, storeId, method: 'POST' }),
          api(`/checks/${checkId}/bounce`, { token, storeId, method: 'POST' }),
        ])
        assert.deepEqual(responses.map(({ response }) => response.status), [200, 200])
        assert.equal(await checkStatus(checkId), 'bounced')
        assert.equal(await customerBalance(context.customerId), '5000')
        assert.equal((await lifecycleFacts(checkId)).customerReversals, 1)
      })

      await t.test('transferred customer check bounce restores both debts and preserves every link once', async () => {
        const context = await createContext({ customerDebt: '5000', supplierDebt: '5000' })
        const checkId = await receiveCheck(context.customerId, { amount: '2000', label: 'transfer-bounce' })
        assert.equal(await customerBalance(context.customerId), '3000')
        assert.equal(await supplierBalance(context.supplierId), '5000')
        const transferred = await transferCheck(checkId, context.supplierId)
        assert.equal(transferred.response.status, 201)
        assert.equal(await supplierBalance(context.supplierId), '3000')

        const responses = await Promise.all([
          api(`/checks/${checkId}/bounce`, { token, storeId, method: 'POST' }),
          api(`/checks/${checkId}/bounce`, { token, storeId, method: 'POST' }),
        ])
        assert.deepEqual(responses.map(({ response }) => response.status), [200, 200])
        assert.equal(await customerBalance(context.customerId), '5000')
        assert.equal(await supplierBalance(context.supplierId), '5000')
        assert.deepEqual(await lifecycleFacts(checkId), {
          checks: 1, customerReceipts: 1, customerReversals: 1,
          supplierTransfers: 1, supplierReversals: 1,
        })
        const row = (await pool.query(
          'SELECT customer_id::TEXT, supplier_id::TEXT, transferred_at::TEXT, status FROM checks WHERE id = $1',
          [checkId],
        )).rows[0]
        assert.equal(row.customer_id, context.customerId)
        assert.equal(row.supplier_id, context.supplierId)
        assert.equal(row.transferred_at, currentDate())
        assert.equal(row.status, 'bounced')
      })

      await t.test('clearing a transferred check changes neither party balance nor ledgers', async () => {
        const context = await createContext({ customerDebt: '5000', supplierDebt: '5000' })
        const checkId = await receiveCheck(context.customerId, { amount: '2000', label: 'transfer-clear' })
        await transferCheck(checkId, context.supplierId)
        const before = await lifecycleFacts(checkId)
        assert.equal(await customerBalance(context.customerId), '3000')
        assert.equal(await supplierBalance(context.supplierId), '3000')
        const first = await api(`/checks/${checkId}/clear`, { token, storeId, method: 'POST' })
        const second = await api(`/checks/${checkId}/clear`, { token, storeId, method: 'POST' })
        assert.deepEqual([first.response.status, second.response.status], [200, 200])
        assert.equal(await customerBalance(context.customerId), '3000')
        assert.equal(await supplierBalance(context.supplierId), '3000')
        assert.deepEqual(await lifecycleFacts(checkId), before)
      })

      await t.test('giro owner details survive both cleared and bounced lifecycle paths', async () => {
        for (const terminalState of ['cleared', 'bounced']) {
          const context = await createContext({ customerDebt: '5000' })
          const checkId = await receiveCheck(context.customerId, {
            amount: '2000', label: `giro-${terminalState}`, giro: true,
          })
          const action = terminalState === 'cleared' ? 'clear' : 'bounce'
          const result = await api(`/checks/${checkId}/${action}`, { token, storeId, method: 'POST' })
          assert.equal(result.response.status, 200)
          const row = (await pool.query(
            'SELECT status, is_giro, original_owner_name, original_owner_phone FROM checks WHERE id = $1',
            [checkId],
          )).rows[0]
          assert.deepEqual(row, {
            status: terminalState, is_giro: true,
            original_owner_name: 'يوسف الأصلي', original_owner_phone: '0599000000',
          })
          assert.equal(await customerBalance(context.customerId), terminalState === 'cleared' ? '3000' : '5000')
        }
      })

      await t.test('owner check 5000 -> 3000 stays 3000 when cleared', async () => {
        const context = await createContext({ supplierDebt: '5000' })
        const checkId = await issueOwnerCheck(context.supplierId, 'owner-clear')
        assert.equal(await supplierBalance(context.supplierId), '3000')
        const before = await lifecycleFacts(checkId)
        const result = await api(`/checks/${checkId}/clear`, { token, storeId, method: 'POST' })
        assert.equal(result.response.status, 200)
        assert.equal(await supplierBalance(context.supplierId), '3000')
        assert.deepEqual(await lifecycleFacts(checkId), before)
      })

      await t.test('owner check concurrent bounce restores 3000 -> 5000 exactly once', async () => {
        const context = await createContext({ supplierDebt: '5000' })
        const checkId = await issueOwnerCheck(context.supplierId, 'owner-bounce')
        const responses = await Promise.all([
          api(`/checks/${checkId}/bounce`, { token, storeId, method: 'POST' }),
          api(`/checks/${checkId}/bounce`, { token, storeId, method: 'POST' }),
        ])
        assert.deepEqual(responses.map(({ response }) => response.status), [200, 200])
        assert.equal(await supplierBalance(context.supplierId), '5000')
        const facts = await lifecycleFacts(checkId)
        assert.equal(facts.supplierTransfers, 1)
        assert.equal(facts.supplierReversals, 1)
      })

      await t.test('cleared -> bounced and bounced -> cleared are rejected without ledger changes', async () => {
        const clearedContext = await createContext({ customerDebt: '5000' })
        const clearedId = await receiveCheck(clearedContext.customerId, { amount: '2000', label: 'invalid-cleared' })
        await api(`/checks/${clearedId}/clear`, { token, storeId, method: 'POST' })
        const clearedBefore = await lifecycleFacts(clearedId)
        const cannotBounce = await api(`/checks/${clearedId}/bounce`, { token, storeId, method: 'POST' })
        assert.equal(cannotBounce.response.status, 409)
        assert.equal(await checkStatus(clearedId), 'cleared')
        assert.deepEqual(await lifecycleFacts(clearedId), clearedBefore)

        const bouncedContext = await createContext({ customerDebt: '5000' })
        const bouncedId = await receiveCheck(bouncedContext.customerId, { amount: '2000', label: 'invalid-bounced' })
        await api(`/checks/${bouncedId}/bounce`, { token, storeId, method: 'POST' })
        const bouncedBefore = await lifecycleFacts(bouncedId)
        const cannotClear = await api(`/checks/${bouncedId}/clear`, { token, storeId, method: 'POST' })
        assert.equal(cannotClear.response.status, 409)
        assert.equal(await checkStatus(bouncedId), 'bounced')
        assert.deepEqual(await lifecycleFacts(bouncedId), bouncedBefore)
      })

      await t.test('forced supplier reversal failure rolls the entire transferred bounce back', async () => {
        const context = await createContext({ customerDebt: '5000', supplierDebt: '5000' })
        const checkId = await receiveCheck(context.customerId, { amount: '2000', label: 'forced-rollback' })
        await transferCheck(checkId, context.supplierId)
        const triggerName = `group6_fail_transfer_bounce_${runId.replace(/\W/g, '')}`
        const functionName = `${triggerName}_fn`
        await pool.query(`
          CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.source_type = 'check_transfer_bounce' AND NEW.source_id = ${checkId} THEN
              RAISE EXCEPTION 'forced Group 6 rollback test';
            END IF;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER ${triggerName} BEFORE INSERT ON supplier_ledger
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
        `)
        try {
          const result = await api(`/checks/${checkId}/bounce`, { token, storeId, method: 'POST' })
          assert.equal(result.response.status, 500)
          assert.equal(await checkStatus(checkId), 'pending')
          assert.equal(await customerBalance(context.customerId), '3000')
          assert.equal(await supplierBalance(context.supplierId), '3000')
          assert.deepEqual(await lifecycleFacts(checkId), {
            checks: 1, customerReceipts: 1, customerReversals: 0,
            supplierTransfers: 1, supplierReversals: 0,
          })
        } finally {
          await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON supplier_ledger`)
          await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`)
        }
      })

      await t.test('all Group 6 accounting records retain their correct store contexts', async () => {
        const customerIds = [...trackedCustomerIds]
        const supplierIds = [...trackedSupplierIds]
        const checkIds = [...trackedCheckIds]
        const [checks, customerLedger, supplierLedger, paymentRows, cashRows, partyColumns] = await Promise.all([
          pool.query('SELECT DISTINCT store_id::TEXT AS store_id FROM checks WHERE id = ANY($1::BIGINT[])', [checkIds]),
          pool.query('SELECT DISTINCT store_id::TEXT AS store_id FROM customer_ledger WHERE customer_id = ANY($1::BIGINT[])', [customerIds]),
          pool.query('SELECT DISTINCT store_id::TEXT AS store_id FROM supplier_ledger WHERE supplier_id = ANY($1::BIGINT[])', [supplierIds]),
          pool.query('SELECT COUNT(*)::INTEGER AS count FROM payments WHERE customer_id = ANY($1::BIGINT[])', [customerIds]),
          pool.query("SELECT COUNT(*)::INTEGER AS count FROM financial_movements WHERE source_type LIKE 'check%' AND source_id = ANY($1::BIGINT[])", [checkIds]),
          pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('customers', 'suppliers') AND column_name = 'store_id'"),
        ])
        for (const result of [checks, customerLedger]) {
          assert.deepEqual(new Set(result.rows.map((row) => row.store_id)), new Set([storeId, otherStoreId]))
        }
        assert.deepEqual(supplierLedger.rows, [{ store_id: storeId }])
        assert.equal(paymentRows.rows[0].count, 0, 'physical checks must remain in checks, not duplicate payments')
        assert.equal(cashRows.rows[0].count, 0, 'check lifecycle must not create cash movements')
        assert.deepEqual(partyColumns.rows, [], 'customers and suppliers remain business-wide')
      })

      await t.test('business-day boundaries, snooze, resolve, and bounced-stop are date-safe and non-financial', async () => {
        assert.equal(reminderModule.elapsedBusinessDays('2026-09-03', '2026-09-03'), 0)
        assert.equal(reminderModule.elapsedBusinessDays('2026-09-03', '2026-09-06'), 1)
        assert.equal(reminderModule.elapsedBusinessDays('2026-09-03', '2026-09-07'), 2)
        assert.equal(reminderModule.elapsedBusinessDays('2026-09-03', '2026-09-08'), 3)
        assert.equal(reminderModule.currentBusinessDate(), currentDate())

        const context = await createContext({ customerDebt: '10000' })
        const dueId = await receiveCheck(context.customerId, { amount: '500', label: 'reminder-due', dueDate: currentDate() })
        const day1Id = await receiveCheck(context.customerId, { amount: '500', label: 'reminder-day1', dueDate: priorBusinessDate(1) })
        const day2Id = await receiveCheck(context.customerId, { amount: '500', label: 'reminder-day2', dueDate: priorBusinessDate(2) })
        const day3Id = await receiveCheck(context.customerId, { amount: '500', label: 'reminder-day3', dueDate: priorBusinessDate(3) })
        const resolvedId = await receiveCheck(context.customerId, { amount: '500', label: 'reminder-resolved', dueDate: priorBusinessDate(4) })
        await api('/checks/reminder-settings', { token, storeId, method: 'PUT', body: { businessDays: 3 } })

        let reminders = await api('/checks/reminders', { token, storeId })
        assert.ok(reminders.body.reminders.due_today.some(({ id }) => id === dueId))
        assert.equal(reminders.body.reminders.follow_up.some(({ id }) => id === day1Id), false)
        assert.equal(reminders.body.reminders.follow_up.some(({ id }) => id === day2Id), false)
        assert.ok(reminders.body.reminders.follow_up.some(({ id }) => id === day3Id))

        const snoozeFacts = await lifecycleFacts(day3Id)
        const later = await api(`/checks/${day3Id}/later`, { token, storeId, method: 'POST' })
        assert.equal(later.response.status, 200)
        assert.equal(await checkStatus(day3Id), 'pending')
        assert.deepEqual(await lifecycleFacts(day3Id), snoozeFacts)
        reminders = await api('/checks/reminders', { token, storeId })
        assert.equal(reminders.body.reminders.follow_up.some(({ id }) => id === day3Id), false)

        await api(`/checks/${resolvedId}/clear`, { token, storeId, method: 'POST' })
        reminders = await api('/checks/reminders', { token, storeId })
        assert.equal(reminders.body.reminders.follow_up.some(({ id }) => id === resolvedId), false)

        await api(`/checks/${day2Id}/bounce`, { token, storeId, method: 'POST' })
        const stoppedFacts = await lifecycleFacts(day2Id)
        assert.ok((await api('/checks/reminders', { token, storeId })).body.reminders.bounced.some(({ id }) => id === day2Id))
        const stopped = await api(`/checks/${day2Id}/stop-bounced-reminder`, { token, storeId, method: 'POST' })
        assert.equal(stopped.response.status, 200)
        assert.equal(await checkStatus(day2Id), 'bounced')
        assert.deepEqual(await lifecycleFacts(day2Id), stoppedFacts)
        assert.equal((await api('/checks/reminders', { token, storeId })).body.reminders.bounced.some(({ id }) => id === day2Id), false)
      })

      async function createContext({ customerDebt = '0', supplierDebt = '0', debtStoreId = storeId } = {}) {
        const suffix = `${runId}-${trackedCustomerIds.size + 1}`
        const customerId = (await pool.query('INSERT INTO customers (name) VALUES ($1) RETURNING id::TEXT AS id', [`Group 6 QA customer ${suffix}`])).rows[0].id
        const supplierId = (await pool.query('INSERT INTO suppliers (name) VALUES ($1) RETURNING id::TEXT AS id', [`Group 6 QA supplier ${suffix}`])).rows[0].id
        trackedCustomerIds.add(customerId)
        trackedSupplierIds.add(supplierId)
        if (customerDebt !== '0') await pool.query("INSERT INTO customer_ledger (store_id, customer_id, direction, amount_ils, occurred_at, source_type) VALUES ($1, $2, 'debit', $3, NOW(), 'group6_test_debt')", [debtStoreId, customerId, customerDebt])
        if (supplierDebt !== '0') await pool.query("INSERT INTO supplier_ledger (store_id, supplier_id, direction, amount_ils, occurred_at, source_type) VALUES ($1, $2, 'credit', $3, NOW(), 'group6_test_debt')", [debtStoreId, supplierId, supplierDebt])
        return { customerId, supplierId }
      }

      async function receiveCheck(customerId, { amount, label, dueDate = '2026-12-31', giro = false, checkStoreId = storeId }) {
        const result = await api(`/customers/${customerId}/payments`, {
          token, storeId: checkStoreId, method: 'POST',
          body: { payments: [{
            method: 'check', currency: 'ILS', amount, checkNumber: `${label}-${runId}`,
            dueDate, notes: 'Group 6 PostgreSQL approval QA', isGiro: giro,
            ...(giro ? { originalOwnerName: 'يوسف الأصلي', originalOwnerPhone: '0599000000' } : {}),
          }] },
        })
        assert.equal(result.response.status, 201, JSON.stringify(result.body))
        const checkId = result.body.payment.payments[0].id
        trackedCheckIds.add(checkId)
        return checkId
      }

      async function issueOwnerCheck(supplierId, label) {
        const result = await api('/checks/owner-issued', {
          token, storeId, method: 'POST',
          body: { checkNumber: `${label}-${runId}`, amount: '2000', dueDate: currentDate(), supplierId, notes: 'Group 6 PostgreSQL approval QA' },
        })
        assert.equal(result.response.status, 201, JSON.stringify(result.body))
        const checkId = result.body.check.id
        trackedCheckIds.add(checkId)
        return checkId
      }

      async function transferCheck(checkId, supplierId) {
        return api(`/checks/${checkId}/transfer`, { token, storeId, method: 'POST', body: { supplierId, transferDate: currentDate() } })
      }

      async function lifecycleFacts(checkId) {
        const result = await pool.query(
          `SELECT
             (SELECT COUNT(*)::INTEGER FROM checks WHERE id = $1) AS checks,
             (SELECT COUNT(*)::INTEGER FROM customer_ledger WHERE source_id = $1 AND source_type = 'check') AS "customerReceipts",
             (SELECT COUNT(*)::INTEGER FROM customer_ledger WHERE source_id = $1 AND source_type = 'check_bounce') AS "customerReversals",
             (SELECT COUNT(*)::INTEGER FROM supplier_ledger WHERE source_id = $1 AND source_type IN ('check_transfer', 'owner_check')) AS "supplierTransfers",
             (SELECT COUNT(*)::INTEGER FROM supplier_ledger WHERE source_id = $1 AND source_type IN ('check_transfer_bounce', 'owner_check_bounce')) AS "supplierReversals"`,
          [checkId],
        )
        return result.rows[0]
      }

      async function checkStatus(checkId) {
        return (await pool.query('SELECT status FROM checks WHERE id = $1', [checkId])).rows[0].status
      }

      async function customerBalance(customerId) {
        return (await pool.query("SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount_ils ELSE -amount_ils END), 0)::TEXT AS balance FROM customer_ledger WHERE customer_id = $1", [customerId])).rows[0].balance
      }

      async function supplierBalance(supplierId) {
        return (await pool.query("SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_ils ELSE -amount_ils END), 0)::TEXT AS balance FROM supplier_ledger WHERE supplier_id = $1", [supplierId])).rows[0].balance
      }

      async function api(path, options) {
        return jsonRequest(`${baseUrl}${path}`, options)
      }
    } finally {
      server.close()
      await once(server, 'close')
      await pool.end()
    }
  },
)

function currentDate() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const part = (type) => parts.find((item) => item.type === type).value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function priorBusinessDate(count) {
  const date = new Date(`${currentDate()}T00:00:00Z`)
  let remaining = count
  while (remaining > 0) {
    if (![5, 6].includes(date.getUTCDay())) remaining -= 1
    date.setUTCDate(date.getUTCDate() - 1)
  }
  return date.toISOString().slice(0, 10)
}

async function jsonRequest(url, { token, storeId, method = 'GET', body } = {}) {
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (storeId) headers.set('X-Store-Id', storeId)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) headers.set('X-Request-Id', crypto.randomUUID())
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const payload = await response.json()
  return { response, body: payload }
}
