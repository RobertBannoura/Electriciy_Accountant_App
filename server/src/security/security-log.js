import { createHash } from 'node:crypto'

const allowedDetailFields = new Set([
  'errorCode',
  'errorName',
  'identifierHash',
  'ip',
  'issueCount',
  'localDevelopment',
  'method',
  'outcome',
  'path',
  'reason',
  'requestId',
  'setting',
  'statusCode',
  'storeId',
  'userId',
])

const sensitiveFieldName = /authorization|cookie|password|secret|token|private|credential|body|payload|database.?url/i

export function securityFingerprint(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

export function securityRequestContext(request) {
  const requestId = Object.hasOwn(request, 'requestId')
    ? request.requestId
    : request.get?.('x-request-id')

  return {
    ip: normalizeValue(request.ip),
    method: normalizeValue(request.method),
    path: normalizeValue(request.path),
    requestId: normalizeValue(requestId),
  }
}

export function logSecurityEvent(level, event, details = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    category: 'security',
    event: normalizeEvent(event),
  }

  for (const [key, value] of Object.entries(details)) {
    if (
      !allowedDetailFields.has(key)
      || sensitiveFieldName.test(key)
      || value === null
      || value === undefined
    ) {
      continue
    }
    const normalized = normalizeValue(value)
    if (normalized !== null) record[key] = normalized
  }

  const line = `[security] ${JSON.stringify(record)}`
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

export function safeErrorDetails(error) {
  return {
    errorName: typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name
      : 'Error',
    errorCode: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : 'UNEXPECTED_ERROR',
  }
}

function normalizeEvent(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : 'invalid_security_event'
}

function normalizeValue(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value !== 'string') return null
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint >= 32 && codePoint !== 127
    })
    .join('')
    .slice(0, 200)
}
