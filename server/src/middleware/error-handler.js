import { env } from '../config/env.js'
import { AppError } from '../errors/app-error.js'
import {
  logSecurityEvent,
  safeErrorDetails,
  securityRequestContext,
} from '../security/security-log.js'

const requestBodyErrors = Object.freeze({
  'entity.parse.failed': {
    statusCode: 400,
    code: 'INVALID_JSON',
    message: 'بيانات JSON المرسلة غير صالحة',
  },
  'entity.too.large': {
    statusCode: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'حجم الطلب أكبر من الحد المسموح',
  },
})

const securityRelevantErrorCodes = new Set([
  'ADMIN_ONLY',
  'ORIGIN_NOT_ALLOWED',
  'PERSISTENT_ADMIN_REQUIRED',
  'STORE_CONTEXT_MISMATCH',
])

const requestBoundaryErrorCodes = new Set([
  'INVALID_REQUEST_ID',
  'JSON_TOO_COMPLEX',
])

export function notFoundHandler(request, _response, next) {
  next(
    new AppError(
      `المسار غير موجود: ${request.method} ${request.originalUrl}`,
      404,
      'ROUTE_NOT_FOUND',
    ),
  )
}

export function errorHandler(error, request, response, _next) {
  const isKnownError = error instanceof AppError
  const requestBodyError = Object.hasOwn(requestBodyErrors, error?.type)
    ? requestBodyErrors[error.type]
    : undefined
  const isSafeClientError = Boolean(requestBodyError)
  const statusCode = isKnownError
    ? error.statusCode
    : (requestBodyError?.statusCode ?? 500)
  const code = isKnownError
    ? error.code
    : (requestBodyError?.code ?? 'INTERNAL_ERROR')
  const message = isKnownError
    ? error.message
    : (requestBodyError?.message ?? 'حدث خطأ داخلي في الخادم')

  if (isSafeClientError || (isKnownError && requestBoundaryErrorCodes.has(error.code))) {
    logSecurityEvent('warn', 'malformed_request_rejected', {
      ...securityRequestContext(request),
      outcome: 'failure',
      reason: code,
      statusCode,
    })
  } else if (isKnownError && error.code === 'ROUTE_NOT_FOUND' && request.path.startsWith('/api')) {
    logSecurityEvent('warn', 'unknown_api_route_rejected', {
      ...securityRequestContext(request),
      outcome: 'failure',
      reason: code,
      statusCode,
      userId: request.auth?.user?.id,
    })
  } else if (isKnownError && securityRelevantErrorCodes.has(error.code)) {
    logSecurityEvent('warn', 'access_denied', {
      ...securityRequestContext(request),
      outcome: 'failure',
      reason: error.code,
      statusCode,
      storeId: request.storeId,
      userId: request.auth?.user?.id,
    })
  } else if (!isKnownError) {
    logSecurityEvent('error', 'internal_error', {
      ...securityRequestContext(request),
      ...safeErrorDetails(error),
      outcome: 'failure',
      statusCode,
    })
  }

  response.status(statusCode).json({
    error: {
      code,
      message,
      ...(isKnownError && env.nodeEnv === 'development' && error.stack
        ? { stack: error.stack }
        : {}),
    },
  })
}
