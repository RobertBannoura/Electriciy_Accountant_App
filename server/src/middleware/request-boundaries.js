import { AppError } from '../errors/app-error.js'

const requestIdPattern = /^[A-Za-z0-9._:-]{1,100}$/

export function validateRequestMetadata(request, _response, next) {
  const requestId = request.get('x-request-id')
  request.requestId = null

  if (requestId !== undefined && !requestIdPattern.test(requestId)) {
    throw new AppError(
      'معرّف الطلب غير صالح',
      400,
      'INVALID_REQUEST_ID',
    )
  }

  request.requestId = requestId ?? null
  next()
}

export function createOriginGuard(trustedOrigins) {
  const trusted = new Set(trustedOrigins)

  return function requireTrustedOrigin(request, _response, next) {
    const origin = request.get('origin')

    if (origin !== undefined && !trusted.has(origin)) {
      throw new AppError(
        'مصدر الطلب غير مسموح',
        403,
        'ORIGIN_NOT_ALLOWED',
      )
    }

    next()
  }
}

export function createJsonComplexityGuard({ maxDepth = 32, maxNodes = 20_000 } = {}) {
  return function rejectComplexJson(request, _response, next) {
    if (request.body === undefined) {
      next()
      return
    }

    const pending = [{ value: request.body, depth: 1 }]
    let nodeCount = 0

    while (pending.length > 0) {
      const { value, depth } = pending.pop()
      nodeCount += 1

      if (depth > maxDepth || nodeCount > maxNodes) {
        throw new AppError(
          'بنية بيانات JSON تتجاوز الحد المسموح',
          413,
          'JSON_TOO_COMPLEX',
        )
      }

      if (value === null || typeof value !== 'object') continue
      for (const child of Object.values(value)) {
        pending.push({ value: child, depth: depth + 1 })
      }
    }

    next()
  }
}
