import assert from 'node:assert/strict'
import test from 'node:test'
import { nameKey, rankNameMatches } from '../src/customers/name-matching.js'
import { parseSaleInput } from '../src/sales/sale-input.js'

test('name suggestions rank exact names, Arabic variants, reordered words, typos and phone matches', () => {
  const records = [
    { name: 'أحمد علي', phone: '0599123456' },
    { name: 'احمد علي' },
    { name: 'محمد حسن' },
    { name: 'محمود خالد' },
  ]
  assert.equal(rankNameMatches(records, 'احمد علي')[0], records[1])
  assert.ok(rankNameMatches(records, 'اَحمد').includes(records[0]))
  assert.ok(rankNameMatches(records, 'علي أحمد').includes(records[0]))
  assert.ok(rankNameMatches(records, 'محود خالذ').includes(records[3]))
  assert.deepEqual(rankNameMatches(records, '059912'), [records[0]])
  assert.deepEqual(rankNameMatches(records, 'مزرعة الزيتون'), [])
  assert.equal(nameKey('  JOHN   Smith  '), nameKey('john smith'))
  assert.notEqual(nameKey('أحمد'), nameKey('احمد'), 'similar names must not silently merge')
})

test('sale accepts names with no IDs and rejects invalid or conflicting identities', () => {
  const base = { date: '2026-09-27', items: [{ description: 'تركيب', quantity: '1', actualPrice: '10' }] }
  const parsed = parseSaleInput({ ...base, customerName: '  عميل جديد  ', customerProjectName: '  بيت  ' })
  assert.equal(parsed.value.customerName, 'عميل جديد')
  assert.equal(parsed.value.customerProjectName, 'بيت')
  for (const fields of [
    { customerName: 123 }, { customerName: 'a'.repeat(151) },
    { customerProjectName: {} }, { customerProjectName: 'بيت' },
    { customerId: '1', customerName: 'عميل' },
    { customerId: '1', customerProjectId: '2', customerProjectName: 'بيت' },
    { customerName: 'عميل', customerProjectId: '2' },
  ]) assert.ok(parseSaleInput({ ...base, ...fields }).error)
})
