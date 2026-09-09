export const USERNAME_MAX_LENGTH = 64
export const PASSWORD_MAX_LENGTH = 1024
export const PROVISIONED_PASSWORD_MIN_LENGTH = 12

export function normalizeUsername(value) {
  if (typeof value !== 'string') {
    return null
  }

  const username = value.trim()

  if (username.length === 0 || username.length > USERNAME_MAX_LENGTH) {
    return null
  }

  return username
}

export function isValidLoginPassword(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PASSWORD_MAX_LENGTH
  )
}

export function isValidProvisionedPassword(value) {
  return (
    isValidLoginPassword(value) &&
    value.length >= PROVISIONED_PASSWORD_MIN_LENGTH
  )
}
