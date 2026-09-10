import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { parseStoreId } from '../stores/store-input.js'
import { logSecurityEvent, securityRequestContext } from '../security/security-log.js'

export async function requireStore(request, _response, next) {
  const storeId = parseStoreId(request.get('X-Store-Id'))

  if (!storeId) {
    logSecurityEvent('warn', 'store_context_rejected', {
      ...securityRequestContext(request),
      outcome: 'failure',
      reason: 'missing_or_malformed',
      statusCode: 400,
      userId: request.auth?.user?.id,
    })
    throw new AppError(
      'يجب تحديد متجر صالح لإكمال العملية',
      400,
      'STORE_CONTEXT_REQUIRED',
    )
  }

  const result = await query(
    'SELECT id FROM stores WHERE id = $1::BIGINT AND is_active = TRUE',
    [storeId],
  )

  if (result.rowCount === 0) {
    logSecurityEvent('warn', 'store_context_rejected', {
      ...securityRequestContext(request),
      outcome: 'failure',
      reason: 'nonexistent_or_inactive',
      statusCode: 404,
      storeId,
      userId: request.auth?.user?.id,
    })
    throw new AppError('المتجر غير موجود أو غير فعال', 404, 'STORE_NOT_FOUND')
  }

  request.storeId = storeId
  next()
}
