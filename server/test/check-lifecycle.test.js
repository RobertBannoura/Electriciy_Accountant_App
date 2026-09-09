import assert from 'node:assert/strict'
import test from 'node:test'
import { bounceCheck, clearCheck } from '../src/checks/check-lifecycle.js'
import { elapsedBusinessDays, getCheckReminders } from '../src/checks/check-reminders.js'
import { parseOwnerCheckInput, parseReminderSettingsInput } from '../src/checks/check-input.js'
import { issueOwnerCheck } from '../src/checks/owner-check.js'

function lifecycleDatabase(overrides = {}) {
  const state = {
    check: {
      id: '41', customer_id: '9', supplier_id: null, check_number: 'C-41',
      amount: '2000', status: 'pending', transferred_at: null,
      is_owner_issued: false, ...overrides,
    },
    commands: [],
    ledgerKeys: new Set(),
    ledger: [],
    released: 0,
  }
  const client = {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, ' ').trim()
      state.commands.push(statement)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rows: [], rowCount: null }
      if (statement.includes('FROM checks') && statement.includes('FOR UPDATE')) {
        return { rows: [{ ...state.check }], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO customer_ledger')) {
        addLedger('customer:check_bounce', 'customer', params)
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO supplier_ledger')) {
        const sourceType = statement.includes("'owner_check_bounce'")
          ? 'owner_check_bounce'
          : 'check_transfer_bounce'
        addLedger(`supplier:${sourceType}`, sourceType, params)
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE checks')) {
        state.check.status = statement.includes("status = 'cleared'") ? 'cleared' : 'bounced'
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected query: ${statement}`)
    },
    release() { state.released += 1 },
  }
  function addLedger(key, type, params) {
    if (state.ledgerKeys.has(key)) return
    state.ledgerKeys.add(key)
    state.ledger.push({ type, params })
  }
  return { databasePool: { connect: async () => client }, state }
}

test('clearing is idempotent and never creates another customer payment or ledger entry', async () => {
  const { databasePool, state } = lifecycleDatabase()
  await clearCheck({ databasePool, checkId: '41', storeId: '2' })
  await clearCheck({ databasePool, checkId: '41', storeId: '2' })

  assert.equal(state.check.status, 'cleared')
  assert.equal(state.commands.filter((command) => command.startsWith('UPDATE checks')).length, 1)
  assert.equal(state.commands.some((command) => command.startsWith('INSERT INTO payments')), false)
  assert.equal(state.commands.some((command) => command.includes('_ledger')), false)
})

test('bouncing a customer check restores customer debt exactly once and keeps the original', async () => {
  const { databasePool, state } = lifecycleDatabase()
  await bounceCheck({ databasePool, checkId: '41', storeId: '2', userId: '5' })
  await bounceCheck({ databasePool, checkId: '41', storeId: '2', userId: '5' })

  assert.equal(state.check.status, 'bounced')
  assert.deepEqual(state.ledger.map((entry) => entry.type), ['customer'])
  assert.equal(state.ledger[0].params[2], '2000')
  assert.equal(state.commands.some((command) => command.includes("ON CONFLICT (source_id) WHERE source_type = 'check_bounce' DO NOTHING")), true)
  assert.equal(state.commands.some((command) => command.startsWith('DELETE')), false)
})

test('a transferred customer check bounce restores both customer and supplier debt once', async () => {
  const { databasePool, state } = lifecycleDatabase({ supplier_id: '7', transferred_at: '2026-09-01' })
  await bounceCheck({ databasePool, checkId: '41', storeId: '2', userId: null })
  await bounceCheck({ databasePool, checkId: '41', storeId: '2', userId: null })

  assert.deepEqual(state.ledger.map((entry) => entry.type).sort(), ['check_transfer_bounce', 'customer'])
  assert.equal(state.ledger.find((entry) => entry.type === 'check_transfer_bounce').params[1], '7')
})

test('an owner-issued check bounce restores supplier debt without a customer reversal', async () => {
  const { databasePool, state } = lifecycleDatabase({
    customer_id: null, supplier_id: '7', is_owner_issued: true,
  })
  await bounceCheck({ databasePool, checkId: '41', storeId: '2', userId: null })
  await bounceCheck({ databasePool, checkId: '41', storeId: '2', userId: null })

  assert.deepEqual(state.ledger.map((entry) => entry.type), ['owner_check_bounce'])
})

test('terminal check states cannot be changed into the other terminal state', async () => {
  const bounced = lifecycleDatabase({ status: 'bounced' })
  await assert.rejects(
    clearCheck({ databasePool: bounced.databasePool, checkId: '41', storeId: '2' }),
    (error) => error.code === 'BOUNCED_CHECK_CANNOT_CLEAR' && error.statusCode === 409,
  )
  assert.equal(bounced.state.commands.at(-1), 'ROLLBACK')
  assert.equal(bounced.state.commands.some((command) => command.includes('_ledger')), false)

  const cleared = lifecycleDatabase({ status: 'cleared' })
  await assert.rejects(
    bounceCheck({ databasePool: cleared.databasePool, checkId: '41', storeId: '2', userId: '5' }),
    (error) => error.code === 'CLEARED_CHECK_CANNOT_BOUNCE' && error.statusCode === 409,
  )
  assert.equal(cleared.state.commands.at(-1), 'ROLLBACK')
  assert.deepEqual(cleared.state.ledger, [])
})

test('owner check input stays compact and reminder configuration is bounded', () => {
  assert.deepEqual(parseOwnerCheckInput({
    checkNumber: 'O-9', amount: '250.50', dueDate: '2026-09-20', supplierId: '7', notes: '',
  }), {
    value: { checkNumber: 'O-9', amount: '250.50', dueDate: '2026-09-20', supplierId: '7', notes: null },
  })
  assert.match(parseOwnerCheckInput({ checkNumber: 'O-9', amount: '0', dueDate: '2026-09-20', supplierId: '7' }).error, /أكبر من صفر/)
  assert.deepEqual(parseReminderSettingsInput({ businessDays: 3 }), { value: { businessDays: 3 } })
  assert.ok(parseReminderSettingsInput({ businessDays: 0 }).error)
  assert.ok(parseReminderSettingsInput({ businessDays: true }).error)
  assert.ok(parseReminderSettingsInput({ businessDays: '3' }).error)
})

test('issuing an owner check reduces supplier debt in the same transaction', async () => {
  const state = { commands: [], ledgerParams: null, released: false }
  const client = {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, ' ').trim()
      state.commands.push(statement)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rows: [], rowCount: null }
      if (statement.includes('FROM suppliers')) return { rows: [{ id: '7', name: 'شركة النور' }], rowCount: 1 }
      if (statement.startsWith('INSERT INTO checks')) return { rows: [{ id: '91', supplier_id: '7', check_number: 'O-9', amount: '250', currency_code: 'ILS', due_date: '2026-09-20', status: 'pending', notes: null, is_owner_issued: true }], rowCount: 1 }
      if (statement.startsWith('INSERT INTO supplier_ledger')) { state.ledgerParams = params; return { rows: [], rowCount: 1 } }
      throw new Error(`Unexpected query: ${statement}`)
    },
    release() { state.released = true },
  }
  const check = await issueOwnerCheck({
    databasePool: { connect: async () => client },
    input: { checkNumber: 'O-9', amount: '250', dueDate: '2026-09-20', supplierId: '7', notes: null },
    storeId: '2', userId: null,
  })
  assert.equal(check.is_owner_issued, true)
  assert.deepEqual(state.ledgerParams.slice(0, 4), ['2', '7', '250', '91'])
  assert.equal(state.commands.find((command) => command.startsWith('INSERT INTO supplier_ledger')).includes("'debit'"), true)
  assert.equal(state.commands.at(-1), 'COMMIT')
})

test('owner check issuance rolls back the check when the supplier ledger write fails', async () => {
  const state = { commands: [], released: false }
  const client = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, ' ').trim()
      state.commands.push(statement)
      if (['BEGIN', 'ROLLBACK'].includes(statement)) return { rows: [], rowCount: null }
      if (statement.includes('FROM suppliers')) return { rows: [{ id: '7', name: 'Supplier' }], rowCount: 1 }
      if (statement.startsWith('INSERT INTO checks')) {
        return { rows: [{ id: '91', supplier_id: '7', check_number: 'O-9', amount: '250', is_owner_issued: true }], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO supplier_ledger')) throw new Error('ledger unavailable')
      throw new Error(`Unexpected query: ${statement}`)
    },
    release() { state.released = true },
  }

  await assert.rejects(
    issueOwnerCheck({
      databasePool: { connect: async () => client },
      input: { checkNumber: 'O-9', amount: '250', dueDate: '2026-09-20', supplierId: '7', notes: null },
      storeId: '2', userId: null,
    }),
    /ledger unavailable/,
  )
  assert.equal(state.commands.at(-1), 'ROLLBACK')
  assert.equal(state.released, true)
  assert.equal(state.commands.includes('COMMIT'), false)
})

test('reminders count Palestinian business days and respect snooze and bounced stop filters', async () => {
  assert.equal(elapsedBusinessDays('2026-09-03', '2026-09-08'), 3)
  const rows = [
    { id: '1', due_date: '2026-09-08', status: 'pending', reminder_snoozed_until: null },
    { id: '2', due_date: '2026-09-03', status: 'pending', reminder_snoozed_until: null },
    { id: '3', due_date: '2026-09-03', status: 'pending', reminder_snoozed_until: '2026-09-09' },
    { id: '4', due_date: '2026-09-01', status: 'bounced', reminder_snoozed_until: null },
  ]
  const dbQuery = async (sql) => sql.includes('FROM system_settings')
    ? { rows: [{ value: 3 }], rowCount: 1 }
    : { rows, rowCount: rows.length }
  const reminders = await getCheckReminders({ dbQuery, storeId: '2', today: '2026-09-08' })
  assert.deepEqual(reminders.due_today.map((check) => check.id), ['1'])
  assert.deepEqual(reminders.follow_up.map((check) => check.id), ['2'])
  assert.deepEqual(reminders.bounced.map((check) => check.id), ['4'])
})
