import assert from 'node:assert/strict'
import test from 'node:test'
import {
  financialVerificationChecks,
  verifyFinancialAccounts,
} from '../src/verification/financial-verification.js'

test('financial verification is a read-only, repeatable snapshot covering every requested area', async () => {
  assert.deepEqual(
    financialVerificationChecks.map((check) => check.key),
    ['sales', 'customers', 'suppliers', 'inventory', 'cash', 'bank', 'checks', 'reversals'],
  )
  for (const check of financialVerificationChecks) {
    assert.doesNotMatch(check.sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i)
  }

  const statements = []
  let verificationQuery = 0
  const client = {
    async query(sql) {
      statements.push(sql)
      if (!sql.includes('COUNT(*) OVER()')) return { rows: [], rowCount: 0 }
      verificationQuery += 1
      if (verificationQuery === 1) {
        return {
          rows: [{
            code: 'SALE_DEBT_TOTAL_MISMATCH',
            entity_id: '9',
            reference: 'INV-9',
            expected: '100',
            actual: '90',
            total_issues: 1,
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }

  const result = await verifyFinancialAccounts({
    connect: async () => client,
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  })

  assert.equal(statements[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(statements.at(-1), 'COMMIT')
  assert.equal(result.verifiedAt, '2026-09-09T12:00:00.000Z')
  assert.equal(result.status, 'warning')
  assert.equal(result.sections[0].issueCount, 1)
  assert.equal(result.sections[0].issues[0].description, 'المدفوع مع الدين لا يساوي إجمالي الفاتورة')
  assert.ok(result.sections.slice(1).every((section) => section.status === 'ok'))
})

test('financial verification rolls back its read transaction when a check fails', async () => {
  const statements = []
  const client = {
    async query(sql) {
      statements.push(sql)
      if (sql.includes('COUNT(*) OVER()')) throw new Error('verification query failed')
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }

  await assert.rejects(
    verifyFinancialAccounts({ connect: async () => client }),
    /verification query failed/,
  )
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.ok(!statements.includes('COMMIT'))
})

test('check verification covers bounce, transfer, clear, and owner-check effects', () => {
  const sql = financialVerificationChecks.find((check) => check.key === 'checks').sql
  for (const marker of [
    'check_bounce',
    'check_transfer_bounce',
    'owner_check_bounce',
    'CHECK_CLEARED_PAYMENT_DUPLICATE',
  ]) assert.match(sql, new RegExp(marker))
})
