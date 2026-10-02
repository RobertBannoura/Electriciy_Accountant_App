import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { unzipSync, zipSync } from 'fflate'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

const databaseUrl = process.env.EXCEL_IMPORT_INTEGRATION_DATABASE_URL

test('staging, repeated upload, one balance posting, retry, and safe reversal', {
  skip: databaseUrl ? false : 'EXCEL_IMPORT_INTEGRATION_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = databaseUrl
  process.env.NODE_ENV = 'test'
  const [{ pool }, service] = await Promise.all([
    import('../src/db/pool.js'), import('../src/imports/excel-import-service.js'),
  ])
  const source = readFileSync(fileURLToPath(new URL('../../6-2026.xlsm', import.meta.url)))
  const files = unzipSync(source)
  files['codex-import-test.txt'] = Buffer.from(randomBytes(16).toString('hex'))
  const workbook = Buffer.from(zipSync(files))
  const store = (await pool.query('SELECT id::TEXT AS id FROM stores WHERE is_active = TRUE ORDER BY id LIMIT 1')).rows[0]
  assert.ok(store, 'test database needs an active store')
  const storeId = store.id
  let id, newerId
  try {
    const first = await service.stageExcelImport({ buffer: workbook, sourceName: 'test.xlsm', storeId, userId: null })
    id = first.id
    assert.equal(first.repeated, false)
    const retry = await service.stageExcelImport({ buffer: workbook, sourceName: 'test.xlsm', storeId, userId: null })
    assert.equal(retry.id, id)
    assert.equal(retry.repeated, true)
    const anotherStore = (await pool.query('SELECT id::TEXT AS id FROM stores WHERE is_active = TRUE AND id <> $1::BIGINT LIMIT 1', [storeId])).rows[0]
    if (anotherStore) await assert.rejects(service.stageExcelImport({ buffer: workbook, sourceName: 'test.xlsm', storeId: anotherStore.id, userId: null }), { code: 'IMPORT_STORE_CONFLICT' })
    const detail = await service.getExcelImport(id, storeId)
    const chosen = detail.groups.find((group) => group.sections.length === 1 && group.finalBalance && Number(group.finalBalance) > 2
      && detail.staged_data.transactions.some((row) => row.sectionId === group.sections[0].id && row.type === 'sale'
        && !detail.staged_data.transactions.some((other) => other.sectionId === row.sectionId && other.sourceRow === row.sourceRow && other.id.endsWith(':credit'))))
    assert.ok(chosen)
    const customerName = `Excel test ${randomBytes(8).toString('hex')}`
    const decisions = Object.fromEntries(detail.groups.map((group) => [group.key,
      group.key === chosen.key ? { action: 'create', name: customerName } : { action: 'exclude', reason: 'Integration test scope' }]))
    const issues = Object.fromEntries(detail.staged_data.issues.map((item) => [item.id,
      { status: 'accepted', note: 'Verified against example workbook for integration test' }]))
    const saved = await service.saveExcelReview({ id, storeId, userId: null,
      patch: { currencyConfirmed: true, groups: decisions, issues } })
    assert.deepEqual(saved.validation.problems, [])
    const imported = await service.commitExcelImport({ id, storeId, userId: null })
    assert.equal(imported.imported, 1)
    assert.equal((await service.commitExcelImport({ id, storeId, userId: null })).alreadyImported, true)
    const balance = await pool.query('SELECT balance_ils::TEXT AS balance FROM customer_balances WHERE customer_id = $1::BIGINT', [imported.posted[0].customerId])
    assert.equal(Number(balance.rows[0].balance), Number(chosen.finalBalance))
    const saleRow = detail.staged_data.transactions.find((row) => row.sectionId === chosen.sections[0].id && row.type === 'sale'
      && !detail.staged_data.transactions.some((other) => other.sectionId === row.sectionId && other.sourceRow === row.sourceRow && other.id.endsWith(':credit')))
    const newerFiles = { ...files, 'codex-import-test.txt': Buffer.from(randomBytes(16).toString('hex')) }
    const document = new DOMParser().parseFromString(Buffer.from(newerFiles['xl/worksheets/sheet7.xml']).toString(), 'text/xml')
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    const row = Array.from(document.getElementsByTagNameNS(ns, 'row')).find((node) => node.getAttribute('r') === String(saleRow.sourceRow))
    const credit = document.createElementNS(ns, 'c')
    credit.setAttribute('r', `B${saleRow.sourceRow}`)
    const creditValue = document.createElementNS(ns, 'v')
    creditValue.textContent = '2'
    credit.appendChild(creditValue)
    row.appendChild(credit)
    const totalCell = Array.from(document.getElementsByTagNameNS(ns, 'c')).find((node) => node.getAttribute('r') === `A${chosen.sections[0].sourceTotalRow}`)
    totalCell.getElementsByTagNameNS(ns, 'v')[0].textContent = String(Number(chosen.finalBalance) - 2)
    newerFiles['xl/worksheets/sheet7.xml'] = Buffer.from(new XMLSerializer().serializeToString(document))
    const newerBatch = await service.stageExcelImport({ buffer: Buffer.from(zipSync(newerFiles)), sourceName: 'newer.xlsm', storeId, userId: null })
    newerId = newerBatch.id
    const newerDetail = await service.getExcelImport(newerBatch.id, storeId)
    assert.equal(newerDetail.parent_batch_id, id)
    const newerGroup = newerDetail.groups.find((group) => group.key === chosen.key)
    assert.equal(newerGroup.version.addedTransactionIds.length, 1)
    assert.equal(newerGroup.version.postedDelta, '-2')
    await service.saveExcelReview({ id: newerBatch.id, storeId, userId: null, patch: {
      currencyConfirmed: true,
      groups: Object.fromEntries(newerDetail.groups.map((group) => [group.key, group.key === chosen.key
        ? { action: 'existing', customerId: imported.posted[0].customerId }
        : { action: 'exclude', reason: 'Integration test scope' }])),
      issues: Object.fromEntries(newerDetail.staged_data.issues.map((item) => [item.id,
        { status: 'accepted', note: 'Verified against example workbook for integration test' }])),
    } })
    const newerImport = await service.commitExcelImport({ id: newerBatch.id, storeId, userId: null })
    assert.equal(newerImport.posted[0].delta, '-2')
    assert.equal(newerImport.posted[0].newHistory, 1)
    assert.equal((await service.commitExcelImport({ id: newerBatch.id, storeId, userId: null })).alreadyImported, true)
    const newerBalance = await pool.query('SELECT balance_ils::TEXT AS balance FROM customer_balances WHERE customer_id = $1::BIGINT', [imported.posted[0].customerId])
    assert.equal(Number(newerBalance.rows[0].balance), Number(chosen.finalBalance) - 2)
    await assert.rejects(service.rollbackExcelImport({ id, storeId, userId: null }), { code: 'IMPORT_ROLLBACK_CONFLICT' })
    const newerReversed = await service.rollbackExcelImport({ id: newerBatch.id, storeId, userId: null })
    assert.equal(newerReversed.rolledBack, 1)
    const restored = await pool.query('SELECT balance_ils::TEXT AS balance FROM customer_balances WHERE customer_id = $1::BIGINT', [imported.posted[0].customerId])
    assert.equal(Number(restored.rows[0].balance), Number(chosen.finalBalance))
    const reversed = await service.rollbackExcelImport({ id, storeId, userId: null })
    assert.equal(reversed.rolledBack, 1)
    assert.equal((await service.rollbackExcelImport({ id, storeId, userId: null })).alreadyRolledBack, true)
    const after = await pool.query('SELECT balance_ils::TEXT AS balance FROM customer_balances WHERE customer_id = $1::BIGINT', [imported.posted[0].customerId])
    assert.equal(Number(after.rows[0].balance), 0)
  } finally {
    if (newerId) {
      const batch = await pool.query('SELECT status FROM excel_import_batches WHERE id = $1::BIGINT', [newerId])
      if (batch.rows[0]?.status === 'imported') await service.rollbackExcelImport({ id: newerId, storeId, userId: null })
    }
    if (id) {
      const batch = await pool.query('SELECT status FROM excel_import_batches WHERE id = $1::BIGINT', [id])
      if (batch.rows[0]?.status === 'imported') await service.rollbackExcelImport({ id, storeId, userId: null })
    }
    await pool.end()
  }
})
