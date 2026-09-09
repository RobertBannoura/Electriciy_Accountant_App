import { createHash, randomBytes } from 'node:crypto'

const sessionTokenPattern = /^[A-Za-z0-9_-]{43}$/

export function createSessionToken() {
  return randomBytes(32).toString('base64url')
}

export function isValidSessionToken(value) {
  return typeof value === 'string' && sessionTokenPattern.test(value)
}

export function hashSessionToken(token) {
  if (!isValidSessionToken(token)) {
    return null
  }

  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function readBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') {
    return null
  }

  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorizationHeader)
  return match?.[1] ?? null
}
