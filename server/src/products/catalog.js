import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { parseId } from './product-input.js'
import { parsePagination, paginatedResult } from '../pagination/pagination.js'
import { getPhotoStorage, photoMedia } from '../photos/photo-storage.js'

export function catalogId(value) {
  const id = parseId(value)
  if (!id) throw new AppError('المعرّف غير صالح', 400, 'INVALID_CATALOG_ID')
  return id
}

const visible = `p.is_active AND EXISTS (SELECT 1 FROM store_inventory i JOIN stores s ON s.id = i.store_id
  WHERE i.product_id = p.id AND i.is_active AND s.is_active)`
const published = `COALESCE(e.is_published, FALSE) AND EXISTS (SELECT 1 FROM catalog_photo_links pl WHERE pl.product_id = p.id AND pl.is_active)`

export async function listCatalog(parameters, { admin = false } = {}) {
  const pagination = parsePagination(parameters, { defaultLimit: 24, maxLimit: 48 })
  if (parameters.search !== undefined && (typeof parameters.search !== 'string' || parameters.search.length > 150)) {
    throw new AppError('البحث طويل أو غير صالح', 400, 'INVALID_CATALOG_SEARCH')
  }
  const productId = parameters.productId === undefined ? null : catalogId(parameters.productId)
  const storeId = parameters.storeId === undefined ? null : catalogId(parameters.storeId)
  const categoryId = parameters.categoryId === undefined ? null : catalogId(parameters.categoryId)
  // Explicit customer allowlist: never select costs, inventory balances or internal descriptions.
  const result = await query(`SELECT p.id::TEXT, p.name, p.unit_name, p.default_sale_price::TEXT AS sale_price,
      c.name AS category_name, c.id::TEXT AS category_id, COALESCE(e.description, '') AS description,
      ${admin ? 'COALESCE(e.is_published, FALSE) AS is_published,' : ''}
      ARRAY(SELECT pl.photo_id::TEXT FROM catalog_photo_links pl WHERE pl.product_id = p.id AND pl.is_active ORDER BY pl.photo_id) AS photo_ids,
      (SELECT json_agg(json_build_object('id', s.id::TEXT, 'name', s.name) ORDER BY s.id)
        FROM store_inventory i JOIN stores s ON s.id = i.store_id
        WHERE i.product_id = p.id AND i.is_active AND s.is_active) AS stores
    FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN catalog_entries e ON e.product_id = p.id
    WHERE ${visible} ${admin ? '' : `AND ${published}`}
      AND ($1::TEXT IS NULL OR p.name ILIKE '%' || $1 || '%')
      AND ($2::BIGINT IS NULL OR p.category_id = $2)
      AND ($3::BIGINT IS NULL OR EXISTS (SELECT 1 FROM store_inventory i JOIN stores s ON s.id = i.store_id
        WHERE i.product_id = p.id AND i.store_id = $3 AND i.is_active AND s.is_active))
      AND ($4::BIGINT IS NULL OR p.id = $4)
    ORDER BY p.name, p.id LIMIT $5 OFFSET $6`,
  [parameters.search?.trim() || null, categoryId, storeId, productId, pagination.fetchLimit, pagination.offset])
  const page = paginatedResult(result.rows, pagination)
  return { products: page.rows, pagination: page.pagination }
}

export async function catalogFilters({ admin = false } = {}) {
  const predicate = `${visible} ${admin ? '' : `AND ${published}`}`
  const [categories, stores] = await Promise.all([
    query(`SELECT DISTINCT c.id::TEXT, c.name FROM categories c JOIN products p ON p.category_id = c.id
      LEFT JOIN catalog_entries e ON e.product_id = p.id WHERE ${predicate} ORDER BY c.name`),
    query(`SELECT DISTINCT s.id::TEXT, s.name FROM stores s JOIN store_inventory i ON i.store_id = s.id
      JOIN products p ON p.id = i.product_id LEFT JOIN catalog_entries e ON e.product_id = p.id
      WHERE s.is_active AND i.is_active AND ${predicate} ORDER BY s.name`),
  ])
  return { categories: categories.rows, stores: stores.rows }
}

export async function sendCatalogImage(request, response, { admin = false } = {}) {
  const id = catalogId(request.params.photoId)
  if (request.query.size !== undefined && !['thumbnail', 'full'].includes(request.query.size)) {
    throw new AppError('حجم الصورة غير صالح', 400, 'INVALID_PHOTO_SIZE')
  }
  const result = await query(`SELECT cp.object_key, cp.thumbnail_key FROM catalog_photos cp
    WHERE cp.id = $1 AND EXISTS (SELECT 1 FROM catalog_photo_links pl
      JOIN products p ON p.id = pl.product_id LEFT JOIN catalog_entries e ON e.product_id = p.id
      WHERE pl.photo_id = cp.id AND pl.is_active AND ${visible} ${admin ? '' : `AND ${published}`})`, [id])
  if (!result.rowCount) throw new AppError('الصورة غير موجودة', 404, 'PHOTO_NOT_FOUND')
  const storage = await getPhotoStorage()
  try {
    const key = request.query.size === 'thumbnail' ? result.rows[0].thumbnail_key : result.rows[0].object_key
    const bytes = await storage.get(key)
    const media = photoMedia(key)
    response.type(media.type).set('Content-Disposition', `inline; filename="catalog-${id}.${media.extension}"`).send(bytes)
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'NoSuchKey') throw new AppError('ملف الصورة غير موجود', 404, 'PHOTO_FILE_NOT_FOUND')
    throw error
  }
}
