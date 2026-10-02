import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { pool } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { isValidBusinessDate } from '../checks/check-input.js'
import { currentBusinessDate } from '../checks/check-reminders.js'
import { getPhotoStorage } from './photo-storage.js'

export const photoColumns = `id::TEXT, upload_id::TEXT, store_id::TEXT, business_date::TEXT,
  byte_size, width, height, created_at`

export function parsePhotoDate(value = currentBusinessDate()) {
  if (typeof value !== 'string' || !isValidBusinessDate(value)) {
    throw new AppError('تاريخ الصور غير صالح', 400, 'INVALID_PHOTO_DATE')
  }
  return value
}

export async function normalizePhoto(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new AppError('اختر صورة لرفعها', 400, 'EMPTY_PHOTO')
  try {
    const photo = sharp(bytes, { limitInputPixels: 60_000_000, failOn: 'error' })
    const metadata = await photo.metadata()
    if (!['jpeg', 'png', 'webp', 'heif', 'gif', 'tiff'].includes(metadata.format) || (metadata.pages ?? 1) > 1) throw new Error('Unsupported format')
    // Decode and re-encode; remove EXIF/GPS and preserve phone orientation.
    const oriented = photo.rotate().flatten({ background: '#ffffff' })
    const { data, info } = await oriented.clone().resize({ width: 5000, height: 5000, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, effort: 4 }).toBuffer({ resolveWithObject: true })
    // Encode each size from the source, avoiding a second lossy compression pass.
    const thumbnail = await oriented.clone().resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 }).toBuffer()
    return { data, thumbnail, width: info.width, height: info.height }
  } catch {
    throw new AppError('تعذّر قراءة الصورة. استخدم صورة ثابتة بصيغة JPEG أو PNG أو WebP أو AVIF أو GIF أو TIFF، أو التقط صورة بالكاميرا.', 400, 'INVALID_PHOTO')
  }
}

export async function saveOrderPhoto({ uploadId, storeId, date, bytes, userId, dbPool = pool, storage }) {
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const client = await dbPool.connect()
  const written = []
  let commitStarted = false
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [uploadId])
    const existing = await client.query(`SELECT ${photoColumns}, content_hash, deleted_at FROM daily_order_photos WHERE upload_id = $1::UUID`, [uploadId])
    if (existing.rowCount) {
      const photo = existing.rows[0]
      if (photo.deleted_at) throw new AppError('هذه الصورة محذوفة ولا يمكن إعادة رفعها بنفس المعرّف', 409, 'PHOTO_UPLOAD_DELETED')
      if (photo.store_id !== storeId || photo.business_date !== date || photo.content_hash !== contentHash) {
        throw new AppError('معرّف الرفع مستخدم لصورة أخرى', 409, 'PHOTO_UPLOAD_CONFLICT')
      }
      await client.query('ROLLBACK')
      delete photo.content_hash
      delete photo.deleted_at
      return { photo, created: false }
    }
    const normalized = await normalizePhoto(bytes)
    storage ??= await getPhotoStorage()
    const prefix = `daily-orders/${date}/${storeId}/${uploadId}`
    const key = `${prefix}/full.webp`
    const thumbKey = `${prefix}/thumb.webp`
    for (const [objectKey, data] of [[key, normalized.data], [thumbKey, normalized.thumbnail]]) {
      written.push(objectKey)
      await storage.put(objectKey, data)
    }
    const result = await client.query(`
      INSERT INTO daily_order_photos (upload_id, store_id, business_date, object_key, thumbnail_key,
        content_hash, byte_size, width, height, created_by_user_id)
      VALUES ($1::UUID, $2::BIGINT, $3::DATE, $4, $5, $6, $7, $8, $9, $10::BIGINT)
      RETURNING ${photoColumns}
    `, [uploadId, storeId, date, key, thumbKey, contentHash, normalized.data.length, normalized.width, normalized.height,
      /^\d+$/.test(userId ?? '') ? userId : null])
    commitStarted = true
    await client.query('COMMIT')
    return { photo: result.rows[0], created: true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    // Preserve objects if COMMIT's outcome is uncertain; a retry can find the saved row.
    if (!commitStarted && storage) await Promise.all(written.map((key) => storage.remove(key).catch(() => {})))
    throw error
  } finally { client.release() }
}
