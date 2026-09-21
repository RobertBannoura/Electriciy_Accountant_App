import { AppError } from '../errors/app-error.js'
import { isIP } from 'node:net'

const requestIdPattern = /^[A-Za-z0-9._:-]{1,100}$/

function isPrivateOrLoopbackIpv4(hostname) {
  const octets = hostname.split('.').map(Number)
  return octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && (
      octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
    )
}

export function isDevelopmentBrowserOrigin(origin) {
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/') {
    return false
  }

  if (parsed.search || parsed.hash || !parsed.port) return false
  if (parsed.hostname === 'localhost') return true
  return isIP(parsed.hostname) === 4 && isPrivateOrLoopbackIpv4(parsed.hostname)
}

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

export function createOriginGuard(trustedOrigins, { allowDevelopmentBrowserOrigins = false } = {}) {
  const trusted = new Set(trustedOrigins)

  return function requireTrustedOrigin(request, _response, next) {
    const origin = request.get('origin')

    const trustedOrigin = origin === undefined
      || trusted.has(origin)
      || (allowDevelopmentBrowserOrigins && isDevelopmentBrowserOrigin(origin))

    if (!trustedOrigin) {
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
