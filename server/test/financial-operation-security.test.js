import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claimFinancialOperation,
  financialOperation,
  requireFinancialRequestId,
} from '../src/financial/financial-operation.js'

test('financial routes reject writes without a durable request id', () => {
  assert.throws(
    () => requireFinancialRequestId({ requestId: null }, {}, () => {}),
    (error) => error?.code === 'FINANCIAL_REQUEST_ID_REQUIRED' && error?.statusCode === 400,
  )
})

test('normalized financial payloads receive a SHA-256 operation fingerprint', () => {
  const operation = financialOperation(
    { requestId: 'fin-test-1' },
    'payment:customer',
    { storeId: '2', amount: '10.50' },
  )
  assert.equal(operation.requestId, 'fin-test-1')
  assert.equal(operation.scope, 'payment:customer')
  assert.match(operation.requestHash, /^[0-9a-f]{64}$/)
})

test('a concurrent or retried operation cannot create a second financial effect', async () => {
  const operation = {
    requestId: 'fin-test-2', scope: 'expense:create', requestHash: 'a'.repeat(64),
  }
  const sameRequestDatabase = {
    async query(sql) {
      if (sql.includes('INSERT INTO financial_operation_requests')) return { rowCount: 0, rows: [] }
      return { rowCount: 1, rows: [{ request_hash: operation.requestHash }] }
    },
  }
  await assert.rejects(
    claimFinancialOperation(sameRequestDatabase, { userId: '7', operation }),
    (error) => error?.code === 'DUPLICATE_FINANCIAL_OPERATION' && error?.statusCode === 409,
  )

  const changedRequestDatabase = {
    async query(sql) {
      if (sql.includes('INSERT INTO financial_operation_requests')) return { rowCount: 0, rows: [] }
      return { rowCount: 1, rows: [{ request_hash: 'b'.repeat(64) }] }
    },
  }
  await assert.rejects(
    claimFinancialOperation(changedRequestDatabase, { userId: '7', operation }),
    (error) => error?.code === 'FINANCIAL_REQUEST_ID_REUSED' && error?.statusCode === 409,
  )
})

test('the replay claim remains in the same transaction as every audited writer', async () => {
  const { readFile } = await import('node:fs/promises')
  const files = [
    'sales/create-sale.js', 'purchases/create-purchase.js',
    'customers/create-customer-payment.js', 'suppliers/create-supplier-payment.js',
    'maintenance/maintenance-service.js', 'expenses/create-expense.js',
    'returns/create-customer-return.js', 'returns/create-supplier-return.js',
    'checks/check-lifecycle.js', 'checks/transfer-check.js', 'checks/owner-check.js',
  ]
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')
    assert.match(source, /query\('BEGIN[^']*'\)[\s\S]*claimFinancialOperation/)
    assert.match(source, /claimFinancialOperation[\s\S]*query\('COMMIT'\)/)
  }
})

test('financial verification compares independent source documents to every ledger', async () => {
  const { financialVerificationChecks } = await import('../src/verification/financial-verification.js')
  for (const key of ['customers', 'suppliers', 'inventory', 'cash', 'bank']) {
    const sql = financialVerificationChecks.find((check) => check.key === key).sql
    assert.match(sql, /WITH expected AS/)
    assert.match(sql, /FULL JOIN/)
  }
})
