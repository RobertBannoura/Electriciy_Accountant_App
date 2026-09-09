import { env } from '../config/env.js'
import { AppError } from '../errors/app-error.js'

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

export function notFoundHandler(request, _response, next) {
  next(
    new AppError(
      `المسار غير موجود: ${request.method} ${request.originalUrl}`,
      404,
      'ROUTE_NOT_FOUND',
    ),
  )
}

export function errorHandler(error, _request, response, _next) {
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

  if (!isKnownError && !isSafeClientError) {
    console.error(error)
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
