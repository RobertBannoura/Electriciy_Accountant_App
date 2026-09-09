export const STORE_NAME_MAX_LENGTH = 100

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n
const STORE_ID_PATTERN = /^[1-9]\d*$/

export function parseStoreId(value) {
  if (typeof value !== 'string' || !STORE_ID_PATTERN.test(value)) {
    return null
  }

  const storeId = BigInt(value)

  if (storeId > POSTGRES_BIGINT_MAX) {
    return null
  }

  return value
}

export function normalizeStoreName(value) {
  if (typeof value !== 'string') {
    return null
  }

  const normalizedName = value.trim()

  if (
    normalizedName.length === 0 ||
    Array.from(normalizedName).length > STORE_NAME_MAX_LENGTH
  ) {
    return null
  }

  return normalizedName
}
