export const INTERNAL_EAN13_PREFIX = '200'
const MAX_INTERNAL_SEQUENCE = 999_999_999n

export function calculateEan13CheckDigit(twelveDigits) {
  if (typeof twelveDigits !== 'string' || !/^\d{12}$/.test(twelveDigits)) {
    return null
  }

  const sum = [...twelveDigits].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  )
  return String((10 - (sum % 10)) % 10)
}

export function isValidEan13(value) {
  if (typeof value !== 'string' || !/^\d{13}$/.test(value)) {
    return false
  }

  return calculateEan13CheckDigit(value.slice(0, 12)) === value.at(-1)
}

export function generateInternalEan13(sequenceValue) {
  let sequence
  try {
    sequence = BigInt(sequenceValue)
  } catch {
    return null
  }

  if (sequence < 1n || sequence > MAX_INTERNAL_SEQUENCE) {
    return null
  }

  const body = `${INTERNAL_EAN13_PREFIX}${sequence.toString().padStart(9, '0')}`
  const checkDigit = calculateEan13CheckDigit(body)
  return checkDigit === null ? null : `${body}${checkDigit}`
}
