import { createHash } from 'node:crypto'
import path from 'node:path'
import Decimal from 'decimal.js'
import { unzipSync } from 'fflate'
import { DOMParser } from '@xmldom/xmldom'

const mainNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const decoder = new TextDecoder('utf-8', { fatal: true })
const zero = new Decimal(0)
const n = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') return null
  try { return new Decimal(String(value)) } catch { return null }
}
const money = (value) => value === null ? null : value.toDecimalPlaces(2).toFixed(2)
const norm = (value) => String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ')
const children = (node, tag) => Array.from(node?.childNodes ?? []).filter((child) => child.nodeType === 1 && child.localName === tag)
const first = (node, tag) => children(node, tag)[0]
const content = (node) => node?.textContent ?? null
const issue = (code, sectionId, row, detail, blocking = true) => ({
  id: `${code}:${sectionId || 'workbook'}:${row}`,
  code, sectionId, sourceSheet: sectionId ? 'Customers' : 'تقرير مبيعات',
  sourceRow: row, detail, blocking,
})

function date(value) {
  const serial = n(value)
  if (serial && serial.greaterThan(35000) && serial.lessThan(65000)) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial.toNumber()) * 86400000).toISOString().slice(0, 10)
  }
  const text = norm(value)
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text)
  if (match) {
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])
    const iso = `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`
    const parsed = new Date(`${iso}T00:00:00Z`)
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso) return iso
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text))) return text
  return null
}

function xml(files, name) {
  const bytes = files[name]
  if (!bytes) throw new Error(`Missing workbook part: ${name}`)
  const document = new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(message) } })
    .parseFromString(decoder.decode(bytes), 'text/xml')
  if (!document.documentElement) throw new Error(`Invalid XML: ${name}`)
  return document
}

export function readWorkbook(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 40 * 1024 * 1024) throw new Error('Workbook exceeds 40 MB')
  let extractedSize = 0
  const files = unzipSync(new Uint8Array(buffer), { filter: (entry) => {
    if (!/^(xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/worksheets\/[^/]+\.xml)$/.test(entry.name)) return false
    extractedSize += entry.originalSize
    if (entry.originalSize > 50 * 1024 * 1024 || extractedSize > 120 * 1024 * 1024) throw new Error('Workbook XML is too large')
    return true
  } })
  const workbook = xml(files, 'xl/workbook.xml')
  const relationships = xml(files, 'xl/_rels/workbook.xml.rels')
  const rels = new Map(Array.from(relationships.getElementsByTagName('Relationship')).map((item) => [item.getAttribute('Id'), item.getAttribute('Target')]))
  const shared = files['xl/sharedStrings.xml']
    ? Array.from(xml(files, 'xl/sharedStrings.xml').getElementsByTagNameNS(mainNs, 'si')).map(content)
    : []
  const sheets = {}
  for (const sheet of workbook.getElementsByTagNameNS(mainNs, 'sheet')) {
    const name = sheet.getAttribute('name')
    const target = rels.get(sheet.getAttributeNS(relNs, 'id'))
    if (!target) throw new Error(`Missing sheet relationship: ${name}`)
    if (name.toLowerCase() !== 'customers' && name !== 'تقرير مبيعات') continue
    const part = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`)
    const document = xml(files, part)
    const rows = {}
    for (const row of document.getElementsByTagNameNS(mainNs, 'row')) {
      const cells = {}
      for (const cell of children(row, 'c')) {
        const reference = cell.getAttribute('r')
        const column = reference?.replace(/\d/g, '')
        if (!column) continue
        const raw = content(first(cell, 'v'))
        cells[column] = {
          value: cell.getAttribute('t') === 's' ? shared[Number(raw)] : cell.getAttribute('t') === 'inlineStr' ? content(first(cell, 'is')) : raw,
          formula: content(first(cell, 'f')),
          hasFormula: Boolean(first(cell, 'f')),
        }
      }
      rows[Number(row.getAttribute('r'))] = cells
    }
    sheets[name] = rows
  }
  return sheets
}

const val = (rows, row, column) => rows[row]?.[column]?.value ?? null

export function stageWorkbook(buffer, sourceName = 'workbook.xlsm') {
  const sheets = readWorkbook(buffer)
  const customerSheet = Object.keys(sheets).find((name) => name.toLowerCase() === 'customers')
  if (!customerSheet) throw new Error('Customers sheet is missing')
  const rows = sheets[customerSheet]
  const indexes = Object.keys(rows).map(Number).sort((a, b) => a - b)
  const headers = indexes.filter((row) => ['arecivebal', 'areceivable', 'receivable'].includes(norm(val(rows, row, 'A')).toLowerCase()) && norm(val(rows, row, 'G')))
  if (!headers.length) throw new Error('No recognized Customers sections')
  const sections = [], transactions = [], issues = []
  for (let index = 0; index < headers.length; index += 1) {
    const start = headers[index], end = (headers[index + 1] ?? indexes.at(-1) + 1) - 1
    const originalName = norm(val(rows, start, 'G'))
    const proposedName = originalName.includes('/') ? originalName : originalName.replace(/\s+\d{1,3}$/u, '')
    const groupKey = createHash('sha256').update(proposedName).digest('hex').slice(0, 16)
    const sectionId = `S${start}`
    const summaries = indexes.filter((row) => row > start && row <= end && /^SUM\(C/i.test(rows[row]?.C?.formula ?? '') && rows[row]?.A?.hasFormula)
    const totalRow = summaries[0] ?? end + 1
    if (summaries.length !== 1) issues.push(issue('SUMMARY_NOT_UNIQUE', sectionId, start, `${summaries.length} total rows found`))
    const openingRow = start + 1
    const pricedFirst = n(val(rows, openingRow, 'D')) !== null || n(val(rows, openingRow, 'E')) !== null
    const opening = pricedFirst ? zero : (n(val(rows, openingRow, 'A')) ?? zero).minus(n(val(rows, openingRow, 'B')) ?? zero)
    if (pricedFirst && n(val(rows, openingRow, 'A'))?.isZero() === false) issues.push(issue('UNCLEAR_OPENING', sectionId, openingRow, 'Opening row also has product data'))
    let movement = zero, currentDate = null
    for (const row of indexes.filter((number) => number > start && number < totalRow)) {
      const raw = rows[row]
      const label = norm(val(rows, row, 'F'))
      const rawDateOrNote = val(rows, row, 'G')
      const explicitDate = date(rawDateOrNote)
      if (explicitDate) currentDate = explicitDate
      if (row === openingRow && !pricedFirst) continue
      const price = n(val(rows, row, 'D')), quantity = n(val(rows, row, 'E'))
      const cached = n(val(rows, row, 'C')), credit = n(val(rows, row, 'B'))
      const common = { sectionId, groupKey, sourceSheet: customerSheet, sourceRow: row,
        date: explicitDate, contextDate: !explicitDate ? currentDate : null,
        dateInherited: !explicitDate && Boolean(currentDate), rawDateOrNote,
        description: label, unitPrice: price?.toSignificantDigits(12).toFixed() ?? null,
        quantity: quantity?.toSignificantDigits(12).toFixed() ?? null, rawCells: raw }
      if (price !== null && quantity !== null) {
        const amount = price.mul(quantity)
        if (cached !== null && cached.minus(amount).abs().greaterThan('0.01')) issues.push(issue('LINE_TOTAL_MISMATCH', sectionId, row, `Cached ${money(cached)} vs calculated ${money(amount)}`))
        if (!amount.isZero() || label) {
          transactions.push({ ...common, id: `${customerSheet}:${row}:item`, type: amount.isNegative() ? 'return' : 'sale', amount: money(amount.abs()), balanceDelta: money(amount) })
          movement = movement.plus(amount)
        }
      } else if (price !== null || quantity !== null) {
        transactions.push({ ...common, id: `${customerSheet}:${row}:item`, type: 'incomplete_item', amount: null, balanceDelta: null })
        issues.push(issue('MISSING_PRICE_OR_QUANTITY', sectionId, row, `${label}: price=${money(price) ?? ''}, quantity=${money(quantity) ?? ''}`))
      } else if (cached && !cached.isZero()) {
        transactions.push({ ...common, id: `${customerSheet}:${row}:item`, type: 'unclassified_charge', amount: money(cached.abs()), balanceDelta: money(cached) })
        issues.push(issue('UNCLASSIFIED_CHARGE', sectionId, row, `Amount ${money(cached)} without price and quantity`))
        movement = movement.plus(cached)
      }
      if (credit && !credit.isZero()) {
        const type = /مرتجع/u.test(label) ? 'return_credit' : /خصم/u.test(label) ? 'discount'
          : /شي[كك]/u.test(label) ? 'cheque_payment' : /دفع|تسديد|نقد|كاش/u.test(label) ? 'payment' : 'unclassified_credit'
        transactions.push({ ...common, id: `${customerSheet}:${row}:credit`, type, amount: money(credit.abs()), balanceDelta: money(credit.neg()) })
        movement = movement.minus(credit)
        if (type === 'unclassified_credit') issues.push(issue('PAYMENT_TYPE_UNCLEAR', sectionId, row, 'Classify credit as payment, return, discount, or cheque'))
      }
    }
    const closing = n(val(rows, totalRow, 'A'))
    if (closing === null) issues.push(issue('MISSING_CLOSING', sectionId, totalRow, 'Cached closing balance missing'))
    else {
      const difference = closing.minus(opening).minus(movement)
      if (difference.abs().greaterThan(1)) issues.push(issue('SECTION_DOES_NOT_RECONCILE', sectionId, totalRow, `Difference ${money(difference)}`))
      else if (!difference.isZero()) issues.push(issue('ROUNDING_DIFFERENCE', sectionId, totalRow, `Difference ${difference.toFixed()}`, false))
    }
    sections.push({ id: sectionId, groupKey, proposedName, originalName, sourceSheet: customerSheet,
      sourceStart: start, sourceEnd: end, sourceTotalRow: totalRow,
      openingBalance: money(opening), movement: money(movement), calculatedClosing: money(opening.plus(movement)), recordedClosing: money(closing) })
  }
  const groups = new Map()
  for (const section of sections) {
    const chain = groups.get(section.groupKey) ?? []
    chain.push(section)
    groups.set(section.groupKey, chain)
  }
  for (const chain of groups.values()) {
    const numbered = chain.some((section) => section.originalName !== section.proposedName)
    if (numbered) issues.push(issue('CONFIRM_CUSTOMER_MAPPING', chain.at(-1).id, chain.at(-1).sourceStart, 'Confirm numbered continuations'))
    for (let i = 1; i < chain.length; i += 1) {
      const previous = n(chain[i - 1].recordedClosing), opening = n(chain[i].openingBalance)
      if (previous === null || opening === null || opening.minus(previous).abs().greaterThan(1)) issues.push(issue('CARRY_CHAIN_GAP', chain[i].id, chain[i].sourceStart + 1, `Previous ${money(previous)}, next ${money(opening)}`))
      else if (!opening.equals(previous)) issues.push(issue('CARRY_ROUNDING', chain[i].id, chain[i].sourceStart + 1, `Difference ${opening.minus(previous).toFixed()}`, false))
    }
  }
  if (!sheets['تقرير مبيعات']) issues.push(issue('REPORT_SHEET_MISSING', null, 0, 'Sales report sheet is missing'))
  const report = sheets['تقرير مبيعات'] ?? {}
  const covered = new Set()
  for (const [row, cells] of Object.entries(report)) {
    const match = /Customers!?!?G(\d+)$/i.exec(cells.G?.formula ?? '')
    if (!match) continue
    covered.add(Number(match[1]))
    const refs = ['D', 'E', 'F'].map((column) => /Customers!([ABC])(\d+)$/i.exec(cells[column]?.formula ?? ''))
    if (refs.some((item) => !item) || refs.map((item) => item[1]).join('') !== 'ABC' || new Set(refs.map((item) => item[2])).size !== 1) {
      issues.push(issue('REPORT_WRONG_REFERENCE', null, Number(row), 'Report references do not align; Customers controls balances', false))
    }
  }
  if (Object.keys(report).length && headers.some((row) => !covered.has(row))) issues.push(issue('REPORT_MISSING_SECTIONS', null, 0, `${headers.filter((row) => !covered.has(row)).length} customer sections absent from report`, false))
  for (const entry of issues) if (entry.sectionId) entry.sourceSheet = customerSheet
  return { sourceName, sourceSha256: createHash('sha256').update(buffer).digest('hex'),
    sheetsProcessed: [customerSheet, ...(sheets['تقرير مبيعات'] ? ['تقرير مبيعات'] : [])],
    sections, transactions, issues }
}
