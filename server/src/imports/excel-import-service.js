import Decimal from 'decimal.js'
import { pool, query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { rankNameMatches, nameKey } from '../customers/name-matching.js'
import { insertCustomerLedgerMovement } from '../payments/payment-writer.js'
import { writeAuditEntry } from '../audit/write-audit-entry.js'
import { stageWorkbook } from './excel-workbook.js'
import { compareHistory, groupHistory, historyCounts } from './excel-version-diff.js'

const fail = (message, code = 'IMPORT_REVIEW_REQUIRED', status = 409) => { throw new AppError(message, status, code) }
const decimal = (value) => { try { return new Decimal(value) } catch { return null } }

export function reviewedGroups(data, review = {}) {
  const groups = new Map()
  for (const section of data.sections) {
    const key = review.sectionGroups?.[section.id] ?? section.groupKey
    const current = groups.get(key) ?? { key, name: section.proposedName, sections: [] }
    current.sections.push(section)
    groups.set(key, current)
  }
  return [...groups.values()].map((group) => {
    group.sections.sort((a, b) => a.sourceStart - b.sourceStart)
    group.finalBalance = group.sections.at(-1).recordedClosing
    group.decision = review.groups?.[group.key] ?? null
    group.sourceNames = [...new Set(group.sections.map((section) => section.originalName))]
    return group
  })
}

export function compareGroupVersion(data, group, lineage = { byCustomerId: new Map(), byGroupKey: new Map() }) {
  const prior = group.decision?.action === 'existing'
    ? lineage.byCustomerId.get(String(group.decision.customerId))
    : lineage.byGroupKey.get(group.key)
  const history = compareHistory(groupHistory(data, group), prior?.historyFingerprints ?? {})
  const final = decimal(group.finalBalance)
  const postedDelta = final && prior ? final.minus(prior.snapshotBalance).toFixed() : final?.toFixed() ?? null
  const difference = postedDelta === null || !prior ? null : new Decimal(postedDelta).minus(history.addedDelta)
  return { prior: prior ? { customerId: prior.customerId, batchId: prior.batchId, snapshotBalance: prior.snapshotBalance } : null,
    addedTransactions: history.added, removedCount: history.removedCount,
    addedDelta: history.addedDelta, postedDelta,
    reconciliationDifference: difference?.toFixed() ?? null, historyFingerprints: history.counts }
}

export function validateReview(data, review = {}, lineage = { byCustomerId: new Map(), byGroupKey: new Map() }) {
  const groups = reviewedGroups(data, review)
  const problems = []
  if (review.currencyConfirmed !== true) problems.push('Confirm that the workbook balances are ILS')
  const sectionToGroup = new Map(groups.flatMap((group) => group.sections.map((section) => [section.id, group])))
  const selected = new Set()
  const coveredPrior = new Set()
  for (const group of groups) {
    const decision = group.decision
    if (!decision || !['create', 'existing', 'exclude'].includes(decision.action)) {
      problems.push(`${group.name}: choose a customer match, new customer, or exclusion`)
      continue
    }
    if (decision.action === 'exclude') {
      if (!String(decision.reason ?? '').trim()) problems.push(`${group.name}: exclusion needs a reason`)
      const prior = lineage.byGroupKey.get(group.key)
      if (prior) coveredPrior.add(prior.customerId)
      continue
    }
    if (!decimal(group.finalBalance)) problems.push(`${group.name}: final balance is missing`)
    if (decision.action === 'create' && (!String(decision.name ?? '').trim() || String(decision.name).length > 150)) problems.push(`${group.name}: enter a valid customer name`)
    if (decision.action === 'existing' && !/^\d+$/.test(String(decision.customerId ?? ''))) problems.push(`${group.name}: choose an existing customer`)
    if (decision.action === 'existing' && selected.has(String(decision.customerId))) problems.push(`Existing customer ${decision.customerId} is selected more than once`)
    if (decision.action === 'existing') selected.add(String(decision.customerId))
    const version = compareGroupVersion(data, group, lineage)
    const proposedPrior = lineage.byGroupKey.get(group.key)
    if (decision.action === 'create' && proposedPrior) problems.push(`${group.name}: this account was imported previously; match customer ${proposedPrior.customerId}`)
    if (decision.action === 'existing' && proposedPrior && proposedPrior.customerId !== String(decision.customerId)) {
      problems.push(`${group.name}: this account belonged to customer ${proposedPrior.customerId} in the previous import`)
    }
    if (version.prior && decision.action === 'existing') {
      coveredPrior.add(version.prior.customerId)
      if (version.removedCount) problems.push(`${group.name}: ${version.removedCount} previously imported historical rows are missing or changed`)
      if (version.reconciliationDifference && new Decimal(version.reconciliationDifference).abs().greaterThan(1)) {
        problems.push(`${group.name}: new balance change ${version.postedDelta} does not reconcile to new rows ${version.addedDelta}`)
      } else if (version.reconciliationDifference && !new Decimal(version.reconciliationDifference).isZero()
        && !String(decision.roundingReason ?? '').trim()) {
        problems.push(`${group.name}: explain the rounding adjustment of ${version.reconciliationDifference}`)
      }
    }
    for (let index = 1; index < group.sections.length; index += 1) {
      const previous = decimal(group.sections[index - 1].recordedClosing)
      const opening = decimal(group.sections[index].openingBalance)
      if (!previous || !opening || previous.minus(opening).abs().greaterThan(1)) {
        const gap = data.issues.find((item) => item.code === 'CARRY_CHAIN_GAP' && item.sectionId === group.sections[index].id)
        if (!gap || review.issues?.[gap.id]?.status !== 'accepted') problems.push(`${group.name}: carried balance does not match between ${group.sections[index - 1].id} and ${group.sections[index].id}`)
      }
    }
  }
  for (const prior of lineage.byCustomerId.values()) {
    if (!coveredPrior.has(prior.customerId)) problems.push(`${prior.customerName}: previously imported customer is missing from the newer workbook or review`)
  }
  for (const issue of data.issues) {
    const group = sectionToGroup.get(issue.sectionId)
    if (group?.decision?.action === 'exclude') continue
    const resolution = review.issues?.[issue.id]
    if (resolution?.status !== 'accepted' || !String(resolution.note ?? '').trim()) {
      problems.push(`${issue.code} at ${issue.sourceSheet}:${issue.sourceRow} needs review`)
    }
  }
  return { groups, problems, excluded: groups.filter((group) => group.decision?.action === 'exclude') }
}

async function loadLineage(database, storeId, before = null) {
  const latest = await database.query(`SELECT id::TEXT AS id FROM excel_import_batches
    WHERE store_id = $1::BIGINT AND status = 'imported'
      AND ($2::TIMESTAMPTZ IS NULL OR (imported_at, id) < ($2::TIMESTAMPTZ, $3::BIGINT))
    ORDER BY imported_at DESC, id DESC LIMIT 1`, [storeId, before?.importedAt ?? null, before?.id ?? null])
  const result = await database.query(`SELECT DISTINCT ON (item.customer_id)
    item.customer_id::TEXT AS customer_id, customers.name AS customer_name,
    item.group_key, item.opening_balance_ils::TEXT AS snapshot_balance,
    item.history_fingerprints, batch.id::TEXT AS batch_id, batch.imported_at
    FROM excel_import_customers AS item
    INNER JOIN excel_import_batches AS batch ON batch.id = item.batch_id
    INNER JOIN customers ON customers.id = item.customer_id
    WHERE batch.store_id = $1::BIGINT AND batch.status = 'imported'
      AND ($2::TIMESTAMPTZ IS NULL OR (batch.imported_at, batch.id) < ($2::TIMESTAMPTZ, $3::BIGINT))
    ORDER BY item.customer_id, batch.imported_at DESC, batch.id DESC, item.id DESC`, [storeId, before?.importedAt ?? null, before?.id ?? null])
  const olderBatches = new Map()
  const byCustomerId = new Map(), byGroupKey = new Map()
  for (const row of result.rows) {
    let fingerprints = row.history_fingerprints
    if (!fingerprints) {
      if (!olderBatches.has(row.batch_id)) {
        const old = await database.query('SELECT staged_data, review FROM excel_import_batches WHERE id = $1::BIGINT', [row.batch_id])
        olderBatches.set(row.batch_id, old.rows[0])
      }
      const old = olderBatches.get(row.batch_id)
      const group = reviewedGroups(old.staged_data, old.review).find((item) => item.key === row.group_key)
      fingerprints = group ? historyCounts(groupHistory(old.staged_data, group)) : {}
    }
    const prior = { customerId: row.customer_id, customerName: row.customer_name,
      groupKey: row.group_key, snapshotBalance: row.snapshot_balance,
      historyFingerprints: fingerprints, batchId: row.batch_id, importedAt: row.imported_at }
    byCustomerId.set(row.customer_id, prior)
    const match = byGroupKey.get(row.group_key)
    if (!match || new Date(match.importedAt).getTime() < new Date(row.imported_at).getTime()
      || (new Date(match.importedAt).getTime() === new Date(row.imported_at).getTime()
        && BigInt(match.batchId) < BigInt(row.batch_id))) byGroupKey.set(row.group_key, prior)
  }
  return { latestBatchId: latest.rows[0]?.id ?? null, byCustomerId, byGroupKey }
}

export async function stageExcelImport({ buffer, sourceName, storeId, userId, databaseQuery = query }) {
  const data = stageWorkbook(buffer, sourceName)
  const parent = await databaseQuery("SELECT id::TEXT AS id FROM excel_import_batches WHERE store_id = $1::BIGINT AND status = 'imported' ORDER BY imported_at DESC, id DESC LIMIT 1", [storeId])
  const inserted = await databaseQuery(`INSERT INTO excel_import_batches
    (store_id, source_name, source_sha256, staged_data, created_by_user_id, parent_batch_id)
    VALUES ($1::BIGINT, $2, $3, $4::JSONB, $5::BIGINT, $6::BIGINT)
    ON CONFLICT (source_sha256) DO NOTHING RETURNING id::TEXT AS id`,
  [storeId, sourceName, data.sourceSha256, JSON.stringify(data), userId, parent.rows[0]?.id ?? null])
  if (inserted.rowCount) return { id: inserted.rows[0].id, repeated: false }
  const existing = await databaseQuery('SELECT id::TEXT AS id, store_id::TEXT AS store_id, status FROM excel_import_batches WHERE source_sha256 = $1', [data.sourceSha256])
  if (existing.rows[0].store_id !== String(storeId)) fail('This workbook was already staged under another store', 'IMPORT_STORE_CONFLICT')
  return { id: existing.rows[0].id, status: existing.rows[0].status, repeated: true }
}

export async function listExcelImports(storeId) {
  const result = await query(`SELECT id::TEXT AS id, source_name, source_sha256, status,
    created_at, imported_at, rolled_back_at,
    JSONB_ARRAY_LENGTH(staged_data->'sections') AS section_count,
    JSONB_ARRAY_LENGTH(staged_data->'transactions') AS transaction_count
    FROM excel_import_batches WHERE store_id = $1::BIGINT ORDER BY id DESC LIMIT 30`, [storeId])
  return result.rows
}

export async function getExcelImport(id, storeId) {
  const result = await query(`SELECT id::TEXT AS id, store_id::TEXT AS store_id, source_name,
    source_sha256, status, parent_batch_id::TEXT AS parent_batch_id,
    staged_data, review, created_at, imported_at, rolled_back_at
    FROM excel_import_batches WHERE id = $1::BIGINT AND store_id = $2::BIGINT`, [id, storeId])
  if (!result.rowCount) fail('Import batch not found', 'IMPORT_BATCH_NOT_FOUND', 404)
  const batch = result.rows[0]
  const lineage = await loadLineage({ query }, storeId,
    batch.status === 'staged' ? null : { importedAt: batch.imported_at, id })
  const postedRecords = await query(`SELECT item.id::TEXT AS id, item.group_key,
    item.customer_id::TEXT AS customer_id, customers.name AS customer_name,
    item.created_customer, item.opening_balance_ils::TEXT AS opening_balance_ils,
    item.posted_delta_ils::TEXT AS posted_delta_ils, item.new_history_count,
    item.ledger_id::TEXT AS ledger_id, item.reversal_ledger_id::TEXT AS reversal_ledger_id
    FROM excel_import_customers AS item INNER JOIN customers ON customers.id = item.customer_id
    WHERE item.batch_id = $1::BIGINT ORDER BY item.id`, [id])
  const existing = await query(`SELECT customers.id::TEXT AS id, customers.name,
    balances.balance_ils::TEXT AS balance_ils FROM customers
    INNER JOIN customer_balances AS balances ON balances.customer_id = customers.id
    WHERE customers.is_active = TRUE ORDER BY customers.name`, [])
  const groups = reviewedGroups(batch.staged_data, batch.review).map((group) => ({
    ...group, suggestions: rankNameMatches(existing.rows, group.name).slice(0, 5),
    version: (() => {
      const comparison = compareGroupVersion(batch.staged_data, group, lineage)
      return { ...comparison, addedTransactionIds: comparison.addedTransactions.map((row) => row.id),
        addedTransactions: undefined, historyFingerprints: undefined }
    })(),
  }))
  const validation = validateReview(batch.staged_data, batch.review, lineage)
  if (batch.status === 'staged' && batch.parent_batch_id !== lineage.latestBatchId) {
    validation.problems.unshift('A newer import was committed after this workbook was staged; rebase and review again')
  }
  return { ...batch, latestBatchId: lineage.latestBatchId,
    postedRecords: postedRecords.rows, groups, reviewProblems: validation.problems,
    excludedGroups: validation.excluded.map((group) => group.key), existingCustomers: existing.rows }
}

export async function saveExcelReview({ id, storeId, patch, userId }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query('SELECT staged_data, review, status, parent_batch_id::TEXT AS parent_batch_id FROM excel_import_batches WHERE id = $1::BIGINT AND store_id = $2::BIGINT FOR UPDATE', [id, storeId])
    if (!result.rowCount) fail('Import batch not found', 'IMPORT_BATCH_NOT_FOUND', 404)
    if (result.rows[0].status !== 'staged') fail('Only staged batches can be reviewed')
    const lineage = await loadLineage(client, storeId)
    if (patch.rebase === true) {
      await client.query('UPDATE excel_import_batches SET parent_batch_id = $2::BIGINT, review = $3::JSONB WHERE id = $1::BIGINT', [id, lineage.latestBatchId, '{}'])
      await writeAuditEntry(client, { storeId, userId, action: 'excel_import_rebase', entityType: 'excel_import_batch', entityId: id,
        newValues: { parentBatchId: lineage.latestBatchId } })
      await client.query('COMMIT')
      return { review: {}, validation: validateReview(result.rows[0].staged_data, {}, lineage) }
    }
    if (result.rows[0].parent_batch_id !== lineage.latestBatchId) fail('A newer import exists; rebase this staged workbook', 'STALE_IMPORT_BATCH')
    const data = result.rows[0].staged_data, current = result.rows[0].review
    const sectionIds = new Set(data.sections.map((section) => section.id))
    const issueIds = new Set(data.issues.map((issue) => issue.id))
    const review = { ...current, groups: { ...current.groups }, issues: { ...current.issues }, sectionGroups: { ...current.sectionGroups } }
    if (patch.sectionGroups) for (const [sectionId, groupKey] of Object.entries(patch.sectionGroups)) {
      if (!sectionIds.has(sectionId) || typeof groupKey !== 'string' || !/^[\w-]{1,80}$/.test(groupKey)) fail('Invalid section mapping', 'INVALID_IMPORT_REVIEW', 400)
      review.sectionGroups[sectionId] = groupKey
    }
    const keys = new Set(reviewedGroups(data, review).map((group) => group.key))
    if (patch.groups) for (const [key, decision] of Object.entries(patch.groups)) {
      if (!keys.has(key) || !['create', 'existing', 'exclude'].includes(decision?.action)) fail('Invalid customer decision', 'INVALID_IMPORT_REVIEW', 400)
      if (decision.roundingReason !== undefined && (typeof decision.roundingReason !== 'string' || decision.roundingReason.length > 2000)) {
        fail('Invalid rounding explanation', 'INVALID_IMPORT_REVIEW', 400)
      }
      review.groups[key] = decision
    }
    if (patch.issues) for (const [key, resolution] of Object.entries(patch.issues)) {
      if (!issueIds.has(key) || resolution?.status !== 'accepted' || !String(resolution?.note ?? '').trim()) fail('Issue review requires explicit acceptance and a note', 'INVALID_IMPORT_REVIEW', 400)
      review.issues[key] = { status: resolution.status, note: String(resolution.note).trim().slice(0, 2000) }
    }
    if (patch.currencyConfirmed !== undefined) review.currencyConfirmed = patch.currencyConfirmed === true
    await client.query('UPDATE excel_import_batches SET review = $2::JSONB WHERE id = $1::BIGINT', [id, JSON.stringify(review)])
    await writeAuditEntry(client, { storeId, userId, action: 'excel_import_review', entityType: 'excel_import_batch', entityId: id, newValues: { updatedGroups: Object.keys(patch.groups ?? {}), updatedIssues: Object.keys(patch.issues ?? {}), currencyConfirmed: review.currencyConfirmed } })
    await client.query('COMMIT')
    return { review, validation: validateReview(data, review, lineage) }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function commitExcelImport({ id, storeId, userId, databasePool = pool }) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [439127411])
    const result = await client.query('SELECT staged_data, review, status, parent_batch_id::TEXT AS parent_batch_id FROM excel_import_batches WHERE id = $1::BIGINT AND store_id = $2::BIGINT FOR UPDATE', [id, storeId])
    if (!result.rowCount) fail('Import batch not found', 'IMPORT_BATCH_NOT_FOUND', 404)
    if (result.rows[0].status === 'imported') { await client.query('COMMIT'); return { alreadyImported: true } }
    if (result.rows[0].status !== 'staged') fail('This batch cannot be imported')
    const lineage = await loadLineage(client, storeId)
    if (result.rows[0].parent_batch_id !== lineage.latestBatchId) fail('A newer import exists; rebase this staged workbook', 'STALE_IMPORT_BATCH')
    const { groups, problems } = validateReview(result.rows[0].staged_data, result.rows[0].review, lineage)
    if (problems.length) fail(`Review is incomplete: ${problems.slice(0, 3).join('; ')}`)
    const live = await client.query(`SELECT customers.id::TEXT AS id, customers.name,
      customers.is_active,
      EXISTS(SELECT 1 FROM customer_ledger WHERE customer_id = customers.id) AS has_activity
      FROM customers ORDER BY customers.id FOR UPDATE`)
    const byId = new Map(live.rows.map((customer) => [customer.id, customer]))
    const names = new Set(live.rows.filter((customer) => customer.is_active).map((customer) => nameKey(customer.name)))
    const posted = []
    for (const group of groups) {
      const decision = group.decision
      if (decision.action === 'exclude') continue
      let customerId, created = false
      const version = compareGroupVersion(result.rows[0].staged_data, group, lineage)
      if (decision.action === 'existing') {
        const customer = byId.get(String(decision.customerId))
        if (!customer?.is_active) fail(`Customer ${decision.customerId} is missing or inactive`, 'IMPORT_CUSTOMER_CONFLICT')
        const activity = await client.query(`SELECT ledger.source_type,
          ledger.store_id::TEXT AS store_id,
          linked.customer_id::TEXT AS linked_customer_id,
          batch.store_id::TEXT AS linked_store_id,
          batch.status AS linked_batch_status
          FROM customer_ledger AS ledger
          LEFT JOIN excel_import_customers AS linked ON linked.id = ledger.source_id
            AND ledger.source_type IN ('excel_import', 'excel_import_rollback')
          LEFT JOIN excel_import_batches AS batch ON batch.id = linked.batch_id
          WHERE ledger.customer_id = $1::BIGINT`, [customer.id])
        if (!version.prior && (customer.has_activity || activity.rowCount)) fail(`${customer.name} already has financial activity`, 'IMPORT_CUSTOMER_CONFLICT')
        if (version.prior && activity.rows.some((row) => !['excel_import', 'excel_import_rollback'].includes(row.source_type)
          || row.store_id !== String(storeId) || row.linked_store_id !== String(storeId)
          || row.linked_customer_id !== customer.id
          || !['imported', 'rolled_back'].includes(row.linked_batch_status))) {
          fail(`${customer.name} has activity outside the Excel import; reconcile it before importing a newer workbook`, 'IMPORT_CUSTOMER_CONFLICT')
        }
        if (version.prior) {
          const balance = await client.query('SELECT balance_ils::TEXT AS balance FROM customer_balances WHERE customer_id = $1::BIGINT', [customer.id])
          if (!new Decimal(balance.rows[0].balance).equals(version.prior.snapshotBalance)) {
            fail(`${customer.name} current balance differs from the previous workbook snapshot`, 'IMPORT_CUSTOMER_CONFLICT')
          }
        }
        customerId = customer.id
      } else {
        const name = String(decision.name).trim()
        if (names.has(nameKey(name))) fail(`${name} already exists; choose the existing customer`, 'IMPORT_CUSTOMER_CONFLICT')
        names.add(nameKey(name))
        const createdCustomer = await client.query('INSERT INTO customers (name, notes) VALUES ($1, $2) RETURNING id::TEXT AS id', [name, `Excel import batch ${id}`])
        customerId = createdCustomer.rows[0].id
        created = true
      }
      const balance = new Decimal(group.finalBalance)
      const item = await client.query(`INSERT INTO excel_import_customers
        (batch_id, group_key, customer_id, created_customer, opening_balance_ils,
         posted_delta_ils, history_fingerprints, new_history_count)
        VALUES ($1::BIGINT, $2, $3::BIGINT, $4, $5::NUMERIC, $6::NUMERIC,
          $7::JSONB, $8::INTEGER) RETURNING id::TEXT AS id`,
      [id, group.key, customerId, created, balance.toFixed(), version.postedDelta,
        JSON.stringify(version.historyFingerprints), version.addedTransactions.length])
      const itemId = item.rows[0].id
      const delta = new Decimal(version.postedDelta)
      const ledgerId = await insertCustomerLedgerMovement(client, { storeId, customerId,
        direction: delta.isNegative() ? 'credit' : 'debit', amountIls: delta.abs().toFixed(),
        sourceType: 'excel_import', sourceId: itemId,
        notes: `Excel batch ${id}; final balance ${balance.toFixed()}; latest Customers section ${group.sections.at(-1).id}; archived transactions do not post`, userId })
      if (ledgerId) await client.query('UPDATE excel_import_customers SET ledger_id = $2::BIGINT WHERE id = $1::BIGINT', [itemId, ledgerId])
      posted.push({ customerId, balance: balance.toFixed(), delta: delta.toFixed(), newHistory: version.addedTransactions.length, itemId })
    }
    await client.query("UPDATE excel_import_batches SET status = 'imported', imported_at = NOW() WHERE id = $1::BIGINT", [id])
    await writeAuditEntry(client, { storeId, userId, action: 'excel_import_commit', entityType: 'excel_import_batch', entityId: id,
      newValues: { posted, excluded: groups.filter((group) => group.decision.action === 'exclude').map((group) => ({ key: group.key, reason: group.decision.reason })) } })
    await client.query('COMMIT')
    return { imported: posted.length, excluded: groups.length - posted.length, posted }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function rollbackExcelImport({ id, storeId, userId }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [439127411])
    const batch = await client.query('SELECT status FROM excel_import_batches WHERE id = $1::BIGINT AND store_id = $2::BIGINT FOR UPDATE', [id, storeId])
    if (!batch.rowCount) fail('Import batch not found', 'IMPORT_BATCH_NOT_FOUND', 404)
    if (batch.rows[0].status === 'rolled_back') { await client.query('COMMIT'); return { alreadyRolledBack: true } }
    if (batch.rows[0].status !== 'imported') fail('Only imported batches can be rolled back')
    const latest = await client.query("SELECT id::TEXT AS id FROM excel_import_batches WHERE store_id = $1::BIGINT AND status = 'imported' ORDER BY imported_at DESC, id DESC LIMIT 1", [storeId])
    if (latest.rows[0]?.id !== String(id)) fail('Roll back newer imported workbook versions first', 'IMPORT_ROLLBACK_CONFLICT')
    const items = await client.query(`SELECT id::TEXT AS id, customer_id::TEXT AS customer_id,
      created_customer, opening_balance_ils::TEXT AS balance,
      posted_delta_ils::TEXT AS posted_delta, ledger_id::TEXT AS ledger_id
      FROM excel_import_customers WHERE batch_id = $1::BIGINT ORDER BY id FOR UPDATE`, [id])
    for (const item of items.rows) {
      await client.query('SELECT id FROM customers WHERE id = $1::BIGINT FOR UPDATE', [item.customer_id])
      const movements = await client.query(`SELECT ledger.id::TEXT AS id, ledger.source_type,
        linked.customer_id::TEXT AS linked_customer_id, batch.status AS linked_batch_status
        FROM customer_ledger AS ledger
        LEFT JOIN excel_import_customers AS linked ON linked.id = ledger.source_id
          AND ledger.source_type IN ('excel_import', 'excel_import_rollback')
        LEFT JOIN excel_import_batches AS batch ON batch.id = linked.batch_id
        WHERE ledger.customer_id = $1::BIGINT`, [item.customer_id])
      if (movements.rows.some((movement) => !['excel_import', 'excel_import_rollback'].includes(movement.source_type)
        || movement.linked_customer_id !== item.customer_id
        || !['imported', 'rolled_back'].includes(movement.linked_batch_status))) {
        fail(`Customer ${item.customer_id} has activity outside reviewed Excel imports`, 'IMPORT_ROLLBACK_CONFLICT')
      }
      const current = await client.query('SELECT balance_ils::TEXT AS balance FROM customer_balances WHERE customer_id = $1::BIGINT', [item.customer_id])
      if (!new Decimal(current.rows[0].balance).equals(item.balance)) fail(`Customer ${item.customer_id} balance changed; rollback is unsafe`, 'IMPORT_ROLLBACK_CONFLICT')
    }
    for (const item of items.rows) {
      const delta = new Decimal(item.posted_delta)
      const reversal = await insertCustomerLedgerMovement(client, { storeId, customerId: item.customer_id,
        direction: delta.isNegative() ? 'debit' : 'credit', amountIls: delta.abs().toFixed(),
        sourceType: 'excel_import_rollback', sourceId: item.id,
        notes: `Reversal of Excel batch ${id}; original ledger ${item.ledger_id ?? 'zero'}`, userId })
      if (reversal) await client.query('UPDATE excel_import_customers SET reversal_ledger_id = $2::BIGINT WHERE id = $1::BIGINT', [item.id, reversal])
      if (item.created_customer) await client.query('UPDATE customers SET is_active = FALSE WHERE id = $1::BIGINT', [item.customer_id])
    }
    await client.query("UPDATE excel_import_batches SET status = 'rolled_back', rolled_back_at = NOW() WHERE id = $1::BIGINT", [id])
    await writeAuditEntry(client, { storeId, userId, action: 'excel_import_rollback', entityType: 'excel_import_batch', entityId: id, newValues: { customers: items.rowCount } })
    await client.query('COMMIT')
    return { rolledBack: items.rowCount }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}
