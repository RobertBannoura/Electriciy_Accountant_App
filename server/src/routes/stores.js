import { Router } from 'express'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { logSecurityEvent, securityRequestContext } from '../security/security-log.js'
import { normalizeStoreName, parseStoreId } from '../stores/store-input.js'

export const storesRouter = Router()

storesRouter.get('/', async (_request, response) => {
  const result = await query(`
    SELECT id::TEXT AS id, code, name
    FROM stores
    WHERE is_active = TRUE
    ORDER BY id
  `)

  response.json({ stores: result.rows })
})

storesRouter.patch('/:storeId', async (request, response) => {
  const storeId = parseStoreId(request.params.storeId)

  if (!storeId) {
    throw new AppError('معرّف المتجر غير صالح', 400, 'INVALID_STORE_ID')
  }

  const name = normalizeStoreName(request.body?.name)

  if (!name) {
    throw new AppError(
      'يجب أن يكون اسم المتجر بين حرف واحد و100 حرف',
      400,
      'INVALID_STORE_NAME',
    )
  }

  const result = await query(
    `
      WITH updated AS (
        UPDATE stores
        SET name = $1
        WHERE id = $2::BIGINT AND is_active = TRUE
        RETURNING id, code, name
      ), audit AS (
        INSERT INTO audit_log (
          store_id, actor_user_id, action, entity_type, entity_id, new_values
        )
        SELECT id, $3::BIGINT, 'settings_change', 'store_settings', id,
          jsonb_build_object('name', name)
        FROM updated
        RETURNING 1
      )
      SELECT updated.id::TEXT AS id, updated.code, updated.name
      FROM updated CROSS JOIN audit
    `,
    [name, storeId, request.auth.user.id],
  )

  if (result.rowCount === 0) {
    throw new AppError('المتجر غير موجود', 404, 'STORE_NOT_FOUND')
  }

  logSecurityEvent('info', 'admin_settings_changed', {
    ...securityRequestContext(request),
    outcome: 'success',
    setting: 'store_name',
    storeId,
    userId: request.auth.user.id,
  })
  response.json({ store: result.rows[0] })
})
