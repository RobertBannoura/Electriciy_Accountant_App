import { AppError } from '../errors/app-error.js'
import { isIP } from 'node:net'

const requestIdPattern = /^[A-Za-z0-9._:-]{1,100}$/

export function createProxyClientIpNormalizer(clientIpHeader) {
  if (clientIpHeader === 'x-forwarded-for') {
    return function retainStandardForwardedFor(_request, _response, next) {
      next()
    }
  }

  if (clientIpHeader !== 'x-real-ip') {
    throw new Error('Unsupported proxy client IP header.')
  }

  return function normalizeTrustedProxyClientIp(request, _response, next) {
    const trustProxy = request.app.get('trust proxy fn')
    const socketAddress = request.socket.remoteAddress

    if (typeof trustProxy !== 'function' || !trustProxy(socketAddress, 0)) {
      next()
      return
    }

    const realIp = request.get('x-real-ip')
    if (realIp === undefined) {
      delete request.headers['x-forwarded-for']
      next()
      return
    }

    if (!isIP(realIp)) {
      throw new AppError(
        'عنوان عميل الوكيل غير صالح',
        400,
        'INVALID_PROXY_CLIENT_IP',
      )
    }

    request.headers['x-forwarded-for'] = realIp
    next()
  }
}

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
