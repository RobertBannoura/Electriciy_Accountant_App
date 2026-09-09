import { Router } from 'express'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
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
      UPDATE stores
      SET name = $1
      WHERE id = $2::BIGINT
        AND is_active = TRUE
      RETURNING id::TEXT AS id, code, name
    `,
    [name, storeId],
  )

  if (result.rowCount === 0) {
    throw new AppError('المتجر غير موجود', 404, 'STORE_NOT_FOUND')
  }

  response.json({ store: result.rows[0] })
})
