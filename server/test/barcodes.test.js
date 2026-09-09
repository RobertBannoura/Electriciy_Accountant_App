import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateEan13CheckDigit,
  generateInternalEan13,
  INTERNAL_EAN13_PREFIX,
  isValidEan13,
} from '../src/barcodes/ean13.js'

test('validates EAN-13 check digits', () => {
  assert.equal(calculateEan13CheckDigit('400638133393'), '1')
  assert.equal(isValidEan13('4006381333931'), true)
  assert.equal(isValidEan13('4006381333932'), false)
  assert.equal(isValidEan13('123'), false)
})

test('generates unique internal EAN-13 candidates from non-repeating sequences', () => {
  const first = generateInternalEan13('1')
  const second = generateInternalEan13('2')

  assert.equal(first?.startsWith(INTERNAL_EAN13_PREFIX), true)
  assert.equal(isValidEan13(first), true)
  assert.equal(isValidEan13(second), true)
  assert.notEqual(first, second)
})

test('rejects invalid or exhausted internal sequence values', () => {
  assert.equal(generateInternalEan13('0'), null)
  assert.equal(generateInternalEan13('1000000000'), null)
  assert.equal(generateInternalEan13('invalid'), null)
})
