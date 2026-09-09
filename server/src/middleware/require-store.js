import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { parseStoreId } from '../stores/store-input.js'

export async function requireStore(request, _response, next) {
  const storeId = parseStoreId(request.get('X-Store-Id'))

  if (!storeId) {
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
    throw new AppError('المتجر غير موجود أو غير فعال', 404, 'STORE_NOT_FOUND')
  }

  request.storeId = storeId
  next()
}
