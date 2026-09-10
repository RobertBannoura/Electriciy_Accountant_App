import { AppError } from '../errors/app-error.js'
import { logSecurityEvent, securityRequestContext } from '../security/security-log.js'

export function requireAdmin(request, _response, next) {
  if (request.auth?.user?.role !== 'admin') {
    logSecurityEvent('warn', 'access_denied', {
      ...securityRequestContext(request),
      outcome: 'failure',
      reason: 'admin_required',
      statusCode: 403,
      userId: request.auth?.user?.id,
    })
    throw new AppError(
      'لا تملك صلاحية الوصول إلى هذه الوظيفة',
      403,
      'ADMIN_REQUIRED',
    )
  }

  next()
}
