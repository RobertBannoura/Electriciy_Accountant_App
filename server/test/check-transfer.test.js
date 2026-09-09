import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCheckTransferInput } from '../src/checks/check-transfer-input.js'
import { transferCheckToSupplier } from '../src/checks/transfer-check.js'

test('check transfer input requires one supplier and a real transfer date', () => {
  assert.deepEqual(parseCheckTransferInput({
    supplierId: '7', transferDate: '2026-09-09',
  }), {
    value: { supplierId: '7', transferDate: '2026-09-09' },
  })
  assert.match(parseCheckTransferInput({ transferDate: '2026-09-09' }).error, /اختيار مورد/)
  assert.match(parseCheckTransferInput({ supplierId: '7', transferDate: '2026-02-30' }).error, /تاريخ التحويل/)
})

function fakeDatabase({ status = 'pending', supplierId = null, failLedger = false } = {}) {
  const state = { commands: [], updateParams: null, ledgerParams: null, released: false }
  const client = {
    async query(sql, params = []) {
      const statement = sql.replace(/\s+/g, ' ').trim()
      state.commands.push(statement)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) {
        return { rowCount: null, rows: [] }
      }
      if (statement.includes('FROM checks') && statement.includes('FOR UPDATE')) {
        return {
          rowCount: 1,
          rows: [{
            id: '31', customer_id: '9', check_number: 'C-31', amount: '400',
            status, supplier_id: supplierId, transferred_at: supplierId ? '2026-09-01' : null,
          }],
        }
      }
      if (statement.includes('FROM suppliers') && statement.includes('FOR SHARE')) {
        return { rowCount: 1, rows: [{ id: '7', name: 'شركة النور' }] }
      }
      if (statement.startsWith('UPDATE checks')) {
        state.updateParams = params
        return {
          rowCount: 1,
          rows: [{
            id: '31', customer_id: '9', supplier_id: '7', check_number: 'C-31',
            amount: '400', due_date: '2026-10-01', status: 'pending',
            transferred_at: '2026-09-09', is_giro: true,
            original_owner_name: 'يوسف', original_owner_phone: '0599000000',
          }],
        }
      }
      if (statement.startsWith('INSERT INTO supplier_ledger')) {
        state.ledgerParams = params
        if (failLedger) throw new Error('ledger failed')
        return { rowCount: 1, rows: [] }
      }
      throw new Error(`Unexpected query: ${statement}`)
    },
    release() { state.released = true },
  }
  return { databasePool: { connect: async () => client }, state }
}

test('transfer updates the same check and debits the supplier ledger atomically', async () => {
  const { databasePool, state } = fakeDatabase()
  const transferred = await transferCheckToSupplier({
    databasePool,
    checkId: '31',
    supplierId: '7',
    transferDate: '2026-09-09',
    storeId: '2',
    userId: '5',
  })

  assert.equal(transferred.id, '31')
  assert.equal(transferred.customer_id, '9')
  assert.equal(transferred.supplier_id, '7')
  assert.equal(transferred.original_owner_name, 'يوسف')
  assert.deepEqual(state.updateParams, ['7', '2026-09-09', '31'])
  assert.deepEqual(state.ledgerParams.slice(0, 5), ['2', '7', '400', '2026-09-09', '31'])
  assert.equal(state.commands.filter((command) => command.startsWith('UPDATE checks')).length, 1)
  assert.equal(state.commands.some((command) => command.startsWith('INSERT INTO checks')), false)
  assert.equal(state.commands.at(-1), 'COMMIT')
  assert.equal(state.released, true)
})

test('an already transferred or non-pending check cannot be transferred again', async () => {
  for (const setup of [{ supplierId: '8' }, { status: 'cleared' }]) {
    const { databasePool, state } = fakeDatabase(setup)
    await assert.rejects(
      transferCheckToSupplier({
        databasePool, checkId: '31', supplierId: '7',
        transferDate: '2026-09-09', storeId: '2', userId: null,
      }),
      (error) => ['CHECK_ALREADY_TRANSFERRED', 'CHECK_NOT_ON_HAND'].includes(error?.code),
    )
    assert.equal(state.updateParams, null)
    assert.equal(state.ledgerParams, null)
    assert.equal(state.commands.at(-1), 'ROLLBACK')
  }
})

test('a supplier-ledger failure rolls the check transfer back', async () => {
  const { databasePool, state } = fakeDatabase({ failLedger: true })
  await assert.rejects(
    transferCheckToSupplier({
      databasePool, checkId: '31', supplierId: '7',
      transferDate: '2026-09-09', storeId: '2', userId: null,
    }),
    /ledger failed/,
  )
  assert.ok(state.updateParams)
  assert.equal(state.commands.at(-1), 'ROLLBACK')
  assert.ok(!state.commands.includes('COMMIT'))
})
