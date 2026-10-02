import { createHash } from 'node:crypto'
import { pool } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { normalizePhoto } from './order-photos.js'
import { getPhotoStorage } from './photo-storage.js'

export async function saveCatalogPhoto({ productId, uploadId, bytes, storage }) {
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const client = await pool.connect()
  const written = []
  let commitStarted = false
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [uploadId])
    const product = await client.query('SELECT id FROM products WHERE id = $1 AND is_active FOR UPDATE', [productId])
    if (!product.rowCount) throw new AppError('الصنف غير موجود', 404, 'PRODUCT_NOT_FOUND')
    const existing = await client.query(`SELECT cp.id::TEXT, cp.product_id::TEXT, cp.content_hash,
      EXISTS (SELECT 1 FROM catalog_photo_links pl WHERE pl.product_id = cp.product_id AND pl.photo_id = cp.id AND pl.is_active) AS is_active
      FROM catalog_photos cp WHERE cp.upload_id = $1`, [uploadId])
    if (existing.rowCount) {
      const photo = existing.rows[0]
      if (photo.product_id !== productId || photo.content_hash !== contentHash || !photo.is_active) {
        throw new AppError('معرّف الرفع مستخدم مسبقاً', 409, 'PHOTO_UPLOAD_CONFLICT')
      }
      await client.query('ROLLBACK')
      return { id: photo.id, created: false }
    }
    const count = await client.query('SELECT COUNT(*)::INTEGER AS count FROM catalog_photo_links WHERE product_id = $1 AND is_active', [productId])
    if (count.rows[0].count >= 12) throw new AppError('يمكن إضافة 12 صورة لكل صنف', 400, 'CATALOG_PHOTO_LIMIT')
    const normalized = await normalizePhoto(bytes)
    storage ??= await getPhotoStorage()
    const key = `catalog/${productId}/${uploadId}/full.webp`
    const thumbnail = `catalog/${productId}/${uploadId}/thumb.webp`
    for (const [objectKey, data] of [[key, normalized.data], [thumbnail, normalized.thumbnail]]) {
      written.push(objectKey)
      await storage.put(objectKey, data)
    }
    const saved = await client.query(`INSERT INTO catalog_photos
      (upload_id, product_id, object_key, thumbnail_key, content_hash, byte_size, width, height)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::TEXT`,
    [uploadId, productId, key, thumbnail, contentHash, normalized.data.length, normalized.width, normalized.height])
    await client.query('INSERT INTO catalog_photo_links (product_id, photo_id) VALUES ($1, $2)', [productId, saved.rows[0].id])
    commitStarted = true
    await client.query('COMMIT')
    return { id: saved.rows[0].id, created: true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (!commitStarted && storage) await Promise.all(written.map((key) => storage.remove(key).catch(() => {})))
    throw error
  } finally { client.release() }
}
