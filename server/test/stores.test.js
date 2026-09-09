import assert from 'node:assert/strict'
import test from 'node:test'
import {
  STORE_NAME_MAX_LENGTH,
  normalizeStoreName,
  parseStoreId,
} from '../src/stores/store-input.js'

test('accepts PostgreSQL bigint store IDs as strings', () => {
  assert.equal(parseStoreId('1'), '1')
  assert.equal(parseStoreId('9223372036854775807'), '9223372036854775807')
})

test('rejects unsafe or malformed store IDs', () => {
  for (const value of [1, '0', '-1', '01', '1.5', 'abc', '', null]) {
    assert.equal(parseStoreId(value), null)
  }

  assert.equal(parseStoreId('9223372036854775808'), null)
})

test('normalizes valid display names without changing store identity', () => {
  assert.equal(normalizeStoreName('  كهرباء السلام الجديدة  '), 'كهرباء السلام الجديدة')
  assert.equal(normalizeStoreName('أ'.repeat(STORE_NAME_MAX_LENGTH)), 'أ'.repeat(100))
})

test('rejects empty and oversized display names', () => {
  assert.equal(normalizeStoreName('   '), null)
  assert.equal(normalizeStoreName('أ'.repeat(STORE_NAME_MAX_LENGTH + 1)), null)
  assert.equal(normalizeStoreName(null), null)
})
