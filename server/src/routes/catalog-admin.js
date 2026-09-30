import { Router, raw } from 'express'
import { rateLimit } from 'express-rate-limit'
import { pool, query } from '../db/pool.js'
import { createSessionToken, hashSessionToken } from '../auth/session-token.js'
import { AppError } from '../errors/app-error.js'
import { catalogId, listCatalog, catalogFilters, sendCatalogImage } from '../products/catalog.js'
import { saveCatalogPhoto } from '../photos/catalog-photos.js'

export const catalogAdminRouter = Router()
catalogAdminRouter.get('/', async (request, response) => response.json(await listCatalog(request.query, { admin: true })))
catalogAdminRouter.get('/filters', async (_request, response) => response.json(await catalogFilters({ admin: true })))
catalogAdminRouter.get('/settings', async (_request, response) => {
  const result = await query('SELECT show_sale_prices FROM catalog_settings WHERE id = 1')
  response.json({ showSalePrices: result.rows[0].show_sale_prices })
})
catalogAdminRouter.put('/settings', async (request, response) => {
  if (typeof request.body?.showSalePrices !== 'boolean') throw new AppError('إعداد الأسعار غير صالح', 400, 'INVALID_CATALOG_SETTINGS')
  await query('UPDATE catalog_settings SET show_sale_prices = $1 WHERE id = 1', [request.body.showSalePrices])
  response.json({ saved: true })
})
catalogAdminRouter.post('/session', async (request, response) => {
  const token = createSessionToken()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM catalog_sessions WHERE expires_at <= NOW()')
    await client.query('INSERT INTO catalog_sessions (token_hash, user_id) VALUES ($1, $2)', [hashSessionToken(token), request.auth.user.id])
    await client.query('DELETE FROM auth_sessions WHERE id = $1', [request.auth.sessionId])
    await client.query('COMMIT')
    response.json({ token })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
})
catalogAdminRouter.get('/photos/:photoId/image', async (request, response) => sendCatalogImage(request, response, { admin: true }))

catalogAdminRouter.put('/:productId', async (request, response) => {
  const id = catalogId(request.params.productId)
  const { isPublished, description } = request.body ?? {}
  if (typeof isPublished !== 'boolean' || typeof description !== 'string' || description.length > 2000) {
    throw new AppError('أدخل وصفاً حتى 2000 حرف وحالة عرض صالحة', 400, 'INVALID_CATALOG_ENTRY')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const product = await client.query('SELECT id FROM products WHERE id = $1 AND is_active FOR UPDATE', [id])
    if (!product.rowCount) throw new AppError('الصنف غير موجود', 404, 'PRODUCT_NOT_FOUND')
    if (isPublished) {
      const photos = await client.query('SELECT photo_id FROM catalog_photo_links WHERE product_id = $1 AND is_active LIMIT 1', [id])
      if (!photos.rowCount) throw new AppError('أضف صورة قبل عرض الصنف في الكتالوج', 400, 'CATALOG_PHOTO_REQUIRED')
    }
    await client.query(`INSERT INTO catalog_entries (product_id, is_published, description) VALUES ($1, $2, $3)
      ON CONFLICT (product_id) DO UPDATE SET is_published = EXCLUDED.is_published, description = EXCLUDED.description`,
    [id, isPublished, description.trim()])
    await client.query('COMMIT')
    response.json({ saved: true })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
})

const uploadLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false })
catalogAdminRouter.put('/:productId/photos/:uploadId', uploadLimit, raw({ type: ['image/*', 'application/octet-stream'], limit: '25mb' }), async (request, response) => {
  const productId = catalogId(request.params.productId)
  const uploadId = request.params.uploadId.toLowerCase()
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uploadId)) {
    throw new AppError('معرّف الرفع غير صالح', 400, 'INVALID_PHOTO_UPLOAD_ID')
  }
  if (!Buffer.isBuffer(request.body) || !request.body.length) throw new AppError('اختر صورة', 400, 'EMPTY_PHOTO')
  const result = await saveCatalogPhoto({ productId, uploadId, bytes: request.body })
  response.status(result.created ? 201 : 200).json({ photo: { id: result.id } })
})

catalogAdminRouter.delete('/:productId/photos/:photoId', async (request, response) => {
  const productId = catalogId(request.params.productId)
  const photoId = catalogId(request.params.photoId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [productId])
    const photo = await client.query('UPDATE catalog_photo_links SET is_active = FALSE WHERE photo_id = $1 AND product_id = $2 RETURNING photo_id', [photoId, productId])
    if (!photo.rowCount) throw new AppError('الصورة غير موجودة', 404, 'PHOTO_NOT_FOUND')
    await client.query(`UPDATE catalog_entries SET is_published = FALSE WHERE product_id = $1
      AND NOT EXISTS (SELECT 1 FROM catalog_photo_links WHERE product_id = $1 AND is_active)`, [productId])
    await client.query('COMMIT')
    response.json({ removed: true })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
})

catalogAdminRouter.put('/:productId/shared-photos/:photoId', async (request, response) => {
  const productId = catalogId(request.params.productId)
  const photoId = catalogId(request.params.photoId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const product = await client.query('SELECT id FROM products WHERE id = $1 AND is_active FOR UPDATE', [productId])
    if (!product.rowCount) throw new AppError('الصنف غير موجود', 404, 'PRODUCT_NOT_FOUND')
    const photo = await client.query('SELECT id FROM catalog_photos WHERE id = $1', [photoId])
    if (!photo.rowCount) throw new AppError('الصورة غير موجودة', 404, 'PHOTO_NOT_FOUND')
    const links = await client.query('SELECT photo_id::TEXT FROM catalog_photo_links WHERE product_id = $1 AND is_active', [productId])
    if (links.rowCount >= 12 && !links.rows.some((link) => link.photo_id === photoId)) {
      throw new AppError('يمكن إضافة 12 صورة لكل صنف', 400, 'CATALOG_PHOTO_LIMIT')
    }
    await client.query(`INSERT INTO catalog_photo_links (product_id, photo_id) VALUES ($1, $2)
      ON CONFLICT (product_id, photo_id) DO UPDATE SET is_active = TRUE`, [productId, photoId])
    await client.query('COMMIT')
    response.json({ linked: true })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
})
