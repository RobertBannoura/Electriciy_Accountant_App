import { Router, raw } from 'express'
import { rateLimit } from 'express-rate-limit'
import { pool, query } from '../db/pool.js'
import { requireStore } from '../middleware/require-store.js'
import { AppError } from '../errors/app-error.js'
import { parseId } from '../products/product-input.js'
import { parsePhotoDate, photoColumns, saveOrderPhoto } from '../photos/order-photos.js'
import { getPhotoStorage, photoMedia } from '../photos/photo-storage.js'
import { removePhotoObjects } from '../photos/remove-photo-objects.js'

export const orderPhotosRouter = Router()
orderPhotosRouter.use(requireStore)
const uploadLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: { code: 'PHOTO_UPLOAD_RATE_LIMIT', message: 'عدد الصور كبير. انتظر دقيقة ثم أعد المحاولة.' } } })

orderPhotosRouter.get('/', async (request, response) => {
  const date = parsePhotoDate(request.query.date)
  const before = request.query.before === undefined ? null : parseId(request.query.before)
  if (request.query.before !== undefined && !before) throw new AppError('معرّف الصفحة غير صالح', 400, 'INVALID_PHOTO_CURSOR')
  const result = await query(`SELECT ${photoColumns} FROM daily_order_photos
    WHERE store_id = $1::BIGINT AND business_date = $2::DATE AND deleted_at IS NULL AND ($3::BIGINT IS NULL OR id < $3::BIGINT)
    ORDER BY id DESC LIMIT 41`, [request.storeId, date, before])
  const photos = result.rows.slice(0, 40)
  response.json({ date, photos, nextCursor: result.rows.length > 40 ? photos.at(-1).id : null })
})

orderPhotosRouter.put('/:uploadId', uploadLimit, raw({ type: ['image/*', 'application/octet-stream'], limit: '25mb' }), async (request, response) => {
  const uploadId = request.params.uploadId
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(uploadId)) {
    throw new AppError('معرّف الرفع غير صالح', 400, 'INVALID_PHOTO_UPLOAD_ID')
  }
  if (!Buffer.isBuffer(request.body) || !request.body.length) throw new AppError('اختر ملف صورة صالحاً', 400, 'EMPTY_PHOTO')
  const result = await saveOrderPhoto({ uploadId: uploadId.toLowerCase(), storeId: request.storeId,
    date: parsePhotoDate(request.query.date), bytes: request.body, userId: request.auth.user.id })
  response.status(result.created ? 201 : 200).json({ photo: result.photo })
})

orderPhotosRouter.delete('/:photoId', async (request, response) => {
  const id = parseId(request.params.photoId)
  if (!id) throw new AppError('معرّف الصورة غير صالح', 400, 'INVALID_PHOTO_ID')
  const client = await pool.connect()
  let restoreObjects
  let commitStarted = false
  try {
    await client.query('BEGIN')
    const result = await client.query('SELECT object_key, thumbnail_key FROM daily_order_photos WHERE id = $1::BIGINT AND store_id = $2::BIGINT AND deleted_at IS NULL FOR UPDATE', [id, request.storeId])
    if (!result.rowCount) throw new AppError('الصورة غير موجودة', 404, 'PHOTO_NOT_FOUND')
    const storage = await getPhotoStorage()
    restoreObjects = await removePhotoObjects(storage, [result.rows[0].object_key, result.rows[0].thumbnail_key])
    await client.query('UPDATE daily_order_photos SET deleted_at = NOW() WHERE id = $1::BIGINT', [id])
    commitStarted = true
    await client.query('COMMIT')
    response.json({ removed: true })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (!commitStarted && restoreObjects) await restoreObjects()
    throw error
  } finally { client.release() }
})

orderPhotosRouter.get('/:photoId/image', async (request, response) => {
  const id = parseId(request.params.photoId)
  if (!id) throw new AppError('معرّف الصورة غير صالح', 400, 'INVALID_PHOTO_ID')
  if (request.query.size !== undefined && !['thumbnail', 'full'].includes(request.query.size)) {
    throw new AppError('حجم الصورة غير صالح', 400, 'INVALID_PHOTO_SIZE')
  }
  const result = await query('SELECT object_key, thumbnail_key FROM daily_order_photos WHERE id = $1::BIGINT AND store_id = $2::BIGINT AND deleted_at IS NULL', [id, request.storeId])
  if (!result.rowCount) throw new AppError('الصورة غير موجودة', 404, 'PHOTO_NOT_FOUND')
  const key = request.query.size === 'thumbnail' ? result.rows[0].thumbnail_key : result.rows[0].object_key
  try {
    const storage = await getPhotoStorage()
    const bytes = await storage.get(key)
    const media = photoMedia(key)
    response.type(media.type).set('Content-Disposition', `inline; filename="order-${id}.${media.extension}"`).send(bytes)
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') throw new AppError('ملف الصورة غير موجود في التخزين', 404, 'PHOTO_FILE_NOT_FOUND')
    throw error
  }
})
