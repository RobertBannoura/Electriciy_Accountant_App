import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Decimal from 'decimal.js'
import test from 'node:test'
import { zipSync } from 'fflate'
import { stageWorkbook } from '../src/imports/excel-workbook.js'
import { commitExcelImport, compareGroupVersion, reviewedGroups, stageExcelImport, validateReview } from '../src/imports/excel-import-service.js'
import { groupHistory, historyCounts } from '../src/imports/excel-version-diff.js'
import { compareHistory } from '../src/imports/excel-version-diff.js'

const sample = fileURLToPath(new URL('../../6-2026.xlsm', import.meta.url))
const source = readFileSync(sample)
const staged = stageWorkbook(source, '6-2026.xlsm')

test('complete example workbook stages Customers and audits report references', () => {
  assert.deepEqual(staged.sheetsProcessed, ['Customers', 'تقرير مبيعات'])
  assert.equal(staged.sections.length, 386)
  assert.equal(staged.transactions.length, 6329)
  assert.equal(reviewedGroups(staged).length, 356)
  assert.equal(staged.issues.filter((item) => item.code === 'REPORT_WRONG_REFERENCE').length, 6)
  assert.equal(staged.issues.filter((item) => item.code === 'REPORT_MISSING_SECTIONS').length, 1)
  assert.equal(staged.sourceSha256, stageWorkbook(source, 'renamed.xlsm').sourceSha256)
})

test('carried opening balances are not transactions or duplicate debt', () => {
  const chain = reviewedGroups(staged).find((group) => group.sections.length > 1
    && group.sections[1].openingBalance === group.sections[0].recordedClosing)
  assert.ok(chain)
  const final = new Decimal(chain.finalBalance)
  const summed = chain.sections.reduce((sum, section) => sum.plus(section.recordedClosing ?? 0), new Decimal(0))
  assert.ok(!summed.equals(final), 'sum of section closings repeats debt')
  for (const section of chain.sections) {
    assert.ok(!staged.transactions.some((transaction) => transaction.sectionId === section.id && transaction.sourceRow === section.sourceStart + 1 && transaction.type === 'opening'))
  }
})

test('payments, returns, discounts, and uncertain credits remain distinct history', () => {
  const kinds = new Set(staged.transactions.map((transaction) => transaction.type))
  for (const kind of ['payment', 'cheque_payment', 'return_credit', 'discount', 'unclassified_credit']) assert.ok(kinds.has(kind), kind)
  assert.ok(staged.issues.some((item) => item.code === 'PAYMENT_TYPE_UNCLEAR'))
  const returnCredit = staged.transactions.find((item) => item.type === 'return_credit')
  assert.ok(new Decimal(returnCredit.balanceDelta).isNegative())
  assert.ok(reviewedGroups(staged).some((group) => group.finalBalance && new Decimal(group.finalBalance).isNegative()), 'customer credits remain signed final balances')
})

test('missing prices stay missing and require explicit review', () => {
  const incomplete = staged.transactions.find((item) => item.type === 'incomplete_item' && item.unitPrice === null)
  assert.ok(incomplete)
  assert.equal(incomplete.amount, null)
  assert.ok(staged.issues.some((item) => item.code === 'MISSING_PRICE_OR_QUANTITY' && item.sourceRow === incomplete.sourceRow))
})

test('undated rows retain preceding dates only as context', () => {
  const undated = staged.transactions.find((item) => item.dateInherited && item.contextDate)
  assert.ok(undated)
  assert.equal(undated.date, null)
  assert.match(undated.contextDate, /^\d{4}-\d{2}-\d{2}$/)
})

test('reconciliation allows one unit rounding but flags larger gaps', () => {
  const rounding = staged.issues.filter((item) => item.code === 'ROUNDING_DIFFERENCE')
  assert.ok(rounding.length > 0)
  assert.ok(rounding.every((item) => new Decimal(item.detail.replace('Difference ', '')).abs().lte(1)))
  assert.equal(staged.issues.filter((item) => item.code === 'SECTION_DOES_NOT_RECONCILE').length, 0)
  for (const section of staged.sections.filter((item) => item.recordedClosing !== null)) {
    const difference = new Decimal(section.recordedClosing).minus(section.calculatedClosing).abs()
    assert.ok(difference.lte(1) || staged.issues.some((item) => item.code === 'SECTION_DOES_NOT_RECONCILE' && item.sectionId === section.id))
  }
})

test('unreviewed customer matches and issues block posting; exclusion is explicit', () => {
  const data = { sections: staged.sections.slice(0, 1), issues: staged.issues.filter((item) => item.sectionId === staged.sections[0].id) }
  const groupKey = data.sections[0].groupKey
  assert.ok(validateReview(data, {}).problems.length > 0)
  const excluded = validateReview(data, { currencyConfirmed: true, groups: { [groupKey]: { action: 'exclude', reason: 'Needs external evidence' } } })
  assert.equal(excluded.problems.length, 0)
  assert.equal(excluded.excluded.length, 1)
})

test('section discovery follows shifted rows and changing section counts', () => {
  const header = '<?xml version="1.0" encoding="UTF-8"?>'
  const cell = (ref, value, formula = null) => `<c r="${ref}"${typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value) ? ' t="inlineStr"' : ''}>${formula ? `<f>${formula}</f>` : ''}${typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value) ? `<is><t>${value}</t></is>` : `<v>${value}</v>`}</c>`
  const row = (number, ...cells) => `<row r="${number}">${cells.join('')}</row>`
  const customers = `${header}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[
    row(10, cell('A10', 'arecivebal'), cell('G10', 'Sample 1')),
    row(11, cell('A11', 5)),
    row(12, cell('C12', 10), cell('D12', 10), cell('E12', 1), cell('F12', 'lamp')),
    row(13, cell('A13', 15, 'SUM(A11:A12)'), cell('C13', 10, 'SUM(C11:C12)')),
    row(30, cell('A30', 'arecivebal'), cell('G30', 'Sample 2')),
    row(31, cell('A31', 15)),
    row(32, cell('B32', 2), cell('F32', 'دفع')),
    row(33, cell('A33', 13, 'SUM(A31:A32)'), cell('C33', 0, 'SUM(C31:C32)')),
  ].join('')}</sheetData></worksheet>`
  const workbook = `${header}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Customers" sheetId="1" r:id="rId1"/><sheet name="تقرير مبيعات" sheetId="2" r:id="rId2"/></sheets></workbook>`
  const rels = `${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`
  const report = `${header}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`
  const bytes = Buffer.from(zipSync({
    'xl/workbook.xml': Buffer.from(workbook),
    'xl/_rels/workbook.xml.rels': Buffer.from(rels),
    'xl/worksheets/sheet1.xml': Buffer.from(customers),
    'xl/worksheets/sheet2.xml': Buffer.from(report),
  }))
  const result = stageWorkbook(bytes)
  assert.deepEqual(result.sections.map((section) => section.sourceStart), [10, 30])
  assert.equal(result.transactions.length, 2)
  assert.equal(reviewedGroups(result).length, 1)
  assert.equal(reviewedGroups(result)[0].finalBalance, '13.00')
})

test('byte-identical upload reuses the batch and rejects a different store', async () => {
  let record = null
  const databaseQuery = async (sql, params) => {
    if (sql.includes('SELECT id::TEXT AS id FROM excel_import_batches') && sql.includes("status = 'imported'")) return { rowCount: 0, rows: [] }
    if (sql.includes('INSERT INTO excel_import_batches')) {
      if (record) return { rowCount: 0, rows: [] }
      record = { id: '42', store_id: String(params[0]), status: 'staged', hash: params[2] }
      return { rowCount: 1, rows: [{ id: record.id }] }
    }
    assert.equal(params[0], record.hash)
    return { rowCount: 1, rows: [record] }
  }
  const first = await stageExcelImport({ buffer: source, sourceName: 'example.xlsm', storeId: '1', userId: '1', databaseQuery })
  const second = await stageExcelImport({ buffer: source, sourceName: 'example.xlsm', storeId: '1', userId: '1', databaseQuery })
  assert.equal(first.id, second.id)
  assert.equal(second.repeated, true)
  await assert.rejects(stageExcelImport({ buffer: source, sourceName: 'example.xlsm', storeId: '2', userId: '1', databaseQuery }), { code: 'IMPORT_STORE_CONFLICT' })
})

test('commit retry stops at the imported batch without another ledger write', async () => {
  const statements = []
  const client = { query: async (sql) => {
    statements.push(sql)
    if (sql.includes('SELECT staged_data, review, status')) return { rowCount: 1, rows: [{ status: 'imported' }] }
    return { rowCount: 0, rows: [] }
  }, release() {} }
  const result = await commitExcelImport({ id: '42', storeId: '1', userId: '1', databasePool: { connect: async () => client } })
  assert.equal(result.alreadyImported, true)
  assert.ok(!statements.some((sql) => sql.includes('INSERT INTO')))
})

test('new workbook adds only new rows and posts only the balance difference', () => {
  const original = reviewedGroups(staged).find((group) => group.sections.length === 1 && group.finalBalance && Number(group.finalBalance) > 10)
  assert.ok(original)
  const base = { sections: original.sections, transactions: groupHistory(staged, original), issues: [] }
  const prior = { customerId: '77', customerName: original.name, groupKey: original.key,
    snapshotBalance: original.finalBalance, batchId: '1',
    historyFingerprints: historyCounts(base.transactions) }
  const lineage = { byCustomerId: new Map([['77', prior]]), byGroupKey: new Map([[original.key, prior]]) }
  const newer = structuredClone(base)
  newer.sections[0].recordedClosing = new Decimal(original.finalBalance).minus(5).toFixed(2)
  newer.transactions = newer.transactions.map((row) => ({ ...row, sourceRow: row.sourceRow + 100 }))
  newer.transactions.push({ ...newer.transactions[0], id: 'Customers:999:credit', sourceRow: 999,
    type: 'payment', description: 'دفع', unitPrice: null, quantity: null,
    amount: '5.00', balanceDelta: '-5.00' })
  const review = { currencyConfirmed: true, groups: { [original.key]: { action: 'existing', customerId: '77' } } }
  const version = compareGroupVersion(newer, reviewedGroups(newer, review)[0], lineage)
  assert.equal(version.addedTransactions.length, 1)
  assert.equal(version.removedCount, 0)
  assert.equal(version.postedDelta, '-5')
  assert.equal(version.reconciliationDifference, '0')
  assert.deepEqual(validateReview(newer, review, lineage).problems, [])
  const unchanged = structuredClone(newer)
  unchanged.transactions = unchanged.transactions.map((row) => ({ ...row, sourceRow: row.sourceRow + 300 }))
  const newest = compareGroupVersion(unchanged, reviewedGroups(unchanged, review)[0], {
    byCustomerId: new Map([['77', { ...prior, snapshotBalance: newer.sections[0].recordedClosing,
      historyFingerprints: version.historyFingerprints }]]), byGroupKey: new Map(),
  })
  assert.equal(newest.addedTransactions.length, 0)
  assert.equal(newest.postedDelta, '0')
})

test('changed or missing old rows block a newer workbook', () => {
  const original = reviewedGroups(staged).find((group) => group.sections.length === 1 && groupHistory(staged, group).length > 0)
  const base = { sections: original.sections, transactions: groupHistory(staged, original), issues: [] }
  const prior = { customerId: '77', customerName: original.name, groupKey: original.key,
    snapshotBalance: original.finalBalance, batchId: '1', historyFingerprints: historyCounts(base.transactions) }
  const lineage = { byCustomerId: new Map([['77', prior]]), byGroupKey: new Map([[original.key, prior]]) }
  const changed = structuredClone(base)
  changed.transactions[0].amount = '999.00'
  const review = { currencyConfirmed: true, groups: { [original.key]: { action: 'existing', customerId: '77' } } }
  assert.ok(validateReview(changed, review, lineage).problems.some((problem) => problem.includes('historical rows are missing or changed')))
  assert.ok(validateReview({ sections: [], transactions: [], issues: [] }, { currencyConfirmed: true }, lineage)
    .problems.some((problem) => problem.includes('previously imported customer is missing')))
})

test('review refuses to attach an old account section to a different imported customer', () => {
  const original = reviewedGroups(staged).find((group) => group.sections.length === 1 && group.finalBalance)
  const data = { sections: original.sections, transactions: groupHistory(staged, original), issues: [] }
  const prior = { customerId: '77', customerName: original.name, groupKey: original.key,
    snapshotBalance: original.finalBalance, batchId: '1', historyFingerprints: historyCounts(data.transactions) }
  const another = { ...prior, customerId: '88', groupKey: 'other-account' }
  const lineage = { byCustomerId: new Map([['77', prior], ['88', another]]),
    byGroupKey: new Map([[original.key, prior], ['other-account', another]]) }
  const review = { currencyConfirmed: true,
    groups: { [original.key]: { action: 'existing', customerId: '88' } } }
  assert.ok(validateReview(data, review, lineage).problems.some((problem) => problem.includes('belonged to customer 77')))
})

test('newer balance rounding within one unit needs a recorded explanation', () => {
  const original = reviewedGroups(staged).find((group) => group.sections.length === 1 && group.finalBalance)
  const data = { sections: structuredClone(original.sections), transactions: groupHistory(staged, original), issues: [] }
  const prior = { customerId: '77', customerName: original.name, groupKey: original.key,
    snapshotBalance: original.finalBalance, batchId: '1', historyFingerprints: historyCounts(data.transactions) }
  const lineage = { byCustomerId: new Map([['77', prior]]), byGroupKey: new Map([[original.key, prior]]) }
  data.sections[0].recordedClosing = new Decimal(original.finalBalance).plus('0.5').toFixed(2)
  const review = { currencyConfirmed: true, groups: { [original.key]: { action: 'existing', customerId: '77' } } }
  assert.ok(validateReview(data, review, lineage).problems.some((problem) => problem.includes('rounding adjustment')))
  review.groups[original.key].roundingReason = 'Reviewed cached rounding in latest workbook'
  assert.deepEqual(validateReview(data, review, lineage).problems, [])
  data.sections[0].recordedClosing = new Decimal(original.finalBalance).plus('1.01').toFixed(2)
  assert.ok(validateReview(data, review, lineage).problems.some((problem) => problem.includes('does not reconcile')))
})

test('identical repeated purchases are counted rather than collapsed', () => {
  const row = { type: 'sale', date: '2025-01-01', description: 'lamp', unitPrice: '10', quantity: '1', amount: '10.00', balanceDelta: '10.00' }
  const previous = historyCounts([row])
  const compared = compareHistory([row, { ...row, sourceRow: 200 }], previous)
  assert.equal(compared.added.length, 1)
  assert.equal(compared.removedCount, 0)
  assert.equal(compared.addedDelta, '10')
})
