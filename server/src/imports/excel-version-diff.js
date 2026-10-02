import { createHash } from 'node:crypto'
import Decimal from 'decimal.js'

// Row numbers and section numbers move when a workbook is edited. Match a
// multiset of business values instead, so two identical purchases count twice.
export function historyKey(row) {
  const values = [row.type, row.dateInherited ? null : row.date ?? null,
    row.description?.normalize('NFC').trim() ?? '',
    row.unitPrice ?? null, row.quantity ?? null, row.amount ?? null,
    row.balanceDelta ?? null,
    row.contextDate ?? (row.dateInherited ? row.date : null),
    row.dateInherited || !row.date ? String(row.rawDateOrNote ?? '').normalize('NFC').trim() : null]
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

export function historyCounts(rows) {
  const counts = {}
  for (const row of rows) {
    const key = historyKey(row)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export function groupHistory(data, group) {
  const ids = new Set(group.sections.map((section) => section.id))
  return data.transactions.filter((row) => ids.has(row.sectionId))
}

export function compareHistory(currentRows, previousCounts = {}) {
  const remaining = { ...previousCounts }
  const added = []
  for (const row of currentRows) {
    const key = historyKey(row)
    if ((remaining[key] ?? 0) > 0) remaining[key] -= 1
    else added.push(row)
  }
  const removedCount = Object.values(remaining).reduce((sum, value) => sum + value, 0)
  const addedDelta = added.reduce((sum, row) => row.balanceDelta === null
    ? sum : sum.plus(row.balanceDelta), new Decimal(0))
  return { added, removedCount, addedDelta: addedDelta.toFixed(), counts: historyCounts(currentRows) }
}
