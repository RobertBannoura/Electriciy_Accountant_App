import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

const databaseUrl = process.env.CATALOG_INTEGRATION_DATABASE_URL
test('catalog handoff, private uploads, shared model photos and customer data boundaries', {
  skip: databaseUrl ? false : 'CATALOG_INTEGRATION_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = databaseUrl
  process.env.NODE_ENV = 'test'
  process.env.PHOTO_STORAGE_DRIVER = 'local'
  process.env.PHOTO_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'catalog-api-'))
  const [{ app }, { pool }, { provisionAdmin }, backup] = await Promise.all([
    import('../src/app.js'), import('../src/db/pool.js'), import('../src/auth/provision-admin.js'), import('../src/backups/backup-service.js'),
  ])
  const username = `catalog_${randomBytes(8).toString('hex')}`
  const password = randomBytes(32).toString('base64url')
  await provisionAdmin(pool, { username, password, displayName: 'Catalog QA' })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api`
  const call = (url, token, method = 'GET', body) => fetch(`${base}${url}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const login = async () => (await (await call('/auth/login', null, 'POST', { username, password })).json()).token
  try {
    const admin = await login()
    const stores = (await pool.query('SELECT id::TEXT FROM stores WHERE is_active ORDER BY id')).rows
    const category = (await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [username])).rows[0].id
    const fixture = async (name, store) => {
      const result = await pool.query(`INSERT INTO products (name, category_id, unit_name, description, current_purchase_price, default_sale_price)
        VALUES ($1, $2, 'قطعة', 'PRIVATE supplier and purchase note', 123.50, 250) RETURNING id::TEXT`, [name, category])
      await pool.query('INSERT INTO store_inventory (store_id, product_id, reorder_level) VALUES ($1, $2, 0)', [store, result.rows[0].id])
      return result.rows[0].id
    }
    const first = await fixture('Catalog light A ' + username, stores[0].id)
    const second = await fixture('Catalog light B ' + username, stores[1].id)
    await pool.query('UPDATE products SET default_sale_price = 350 WHERE id = $1', [second])
    const hidden = await fixture('Catalog hidden ' + username, stores[0].id)
    const publish = (id, visible = true) => call(`/catalog-admin/${id}`, admin, 'PUT', { isPublished: visible, description: 'Customer lighting description' })
    assert.equal((await publish(first)).status, 400)
    const bytes = await sharp({ create: { width: 700, height: 500, channels: 3, background: '#bd9551' } }).png().toBuffer()
    const uploadId = randomUUID()
    const upload = () => fetch(`${base}/catalog-admin/${first}/photos/${uploadId}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'image/png' }, body: bytes,
    })
    const created = await upload()
    assert.equal(created.status, 201)
    const photoId = (await created.json()).photo.id
    assert.equal((await upload()).status, 200)
    assert.equal((await call(`/catalog-admin/${second}/shared-photos/${photoId}`, admin, 'PUT')).status, 200)
    assert.equal((await call(`/catalog-admin/${second}/shared-photos/${photoId}`, admin, 'PUT')).status, 200)
    assert.equal((await publish(first)).status, 200)
    assert.equal((await publish(second)).status, 200)
    assert.equal((await call('/catalog-admin/settings', admin, 'PUT', { showSalePrices: true })).status, 200)
    const catalogToken = (await (await call('/catalog-admin/session', admin, 'POST')).json()).token
    assert.equal((await call('/products', admin)).status, 401, 'handoff revokes privileged token')
    for (const url of ['/products', '/catalog-admin', '/customers', '/backups/export', '/order-photos']) {
      assert.equal((await call(url, catalogToken)).status, 401, `${url} must reject catalog tokens`)
    }
    assert.equal((await call(`/catalog-admin/${first}`, catalogToken, 'PUT', { isPublished: false, description: '' })).status, 401)
    assert.equal((await call('/catalog')).status, 401)
    const listing = await call(`/catalog?categoryId=${category}`, catalogToken)
    assert.equal(listing.headers.get('cache-control'), 'no-store')
    const data = await listing.json()
    assert.equal(data.products.length, 2)
    assert.deepEqual(data.products.map((p) => p.id).sort(), [first, second].sort())
    for (const product of data.products) {
      assert.deepEqual(Object.keys(product).sort(), ['id', 'name', 'unit_name', 'sale_price', 'category_name', 'category_id', 'description', 'photo_ids', 'stores'].sort())
      assert.deepEqual(product.photo_ids, [photoId])
      assert.equal(product.description, 'Customer lighting description')
      assert.equal(product.sale_price, product.id === second ? '350.00' : '250.00')
    }
    assert.ok(!JSON.stringify(data).includes('PRIVATE'))
    assert.equal((await (await call('/catalog/settings', catalogToken)).json()).showSalePrices, true)
    const filtered = await (await call(`/catalog?categoryId=${category}&storeId=${stores[1].id}`, catalogToken)).json()
    assert.deepEqual(filtered.products.map((p) => p.id), [second])
    assert.equal((await (await call(`/catalog?productId=${hidden}`, catalogToken)).json()).products.length, 0)
    assert.equal((await call('/catalog?storeId=abc', catalogToken)).status, 400)
    const image = await call(`/catalog/photos/${photoId}/image?size=thumbnail`, catalogToken)
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/webp')
    const imageMetadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata()
    assert.equal(imageMetadata.width, 600)
    assert.equal(imageMetadata.format, 'webp')
    const { getPhotoStorage } = await import('../src/photos/photo-storage.js')
    const storage = await getPhotoStorage()
    const legacyKey = `catalog/${first}/${uploadId}/full.jpg`
    await storage.put(legacyKey, await sharp(bytes).jpeg().toBuffer())
    await pool.query('UPDATE catalog_photos SET object_key = $1 WHERE id = $2', [legacyKey, photoId])
    const legacy = await call(`/catalog/photos/${photoId}/image`, catalogToken)
    assert.equal(legacy.headers.get('content-type'), 'image/jpeg')
    assert.equal((await sharp(Buffer.from(await legacy.arrayBuffer())).metadata()).format, 'jpeg')
    const freshAdmin = await login()
    // Removing a shared photo only detaches it from that model.
    assert.equal((await call(`/catalog-admin/${first}/photos/${photoId}`, freshAdmin, 'DELETE')).status, 200)
    assert.equal((await call(`/catalog/photos/${photoId}/image`, catalogToken)).status, 200)
    assert.equal((await (await call(`/catalog?productId=${first}`, catalogToken)).json()).products.length, 0)
    assert.equal((await (await call(`/catalog?productId=${second}`, catalogToken)).json()).products.length, 1)
    const rows = await pool.query('SELECT COUNT(*)::INTEGER AS count FROM catalog_photos WHERE id = $1', [photoId])
    assert.equal(rows.rows[0].count, 1, 'one stored object record shared by both models')
    assert.equal((await call(`/catalog-admin/${second}`, freshAdmin, 'PUT', { isPublished: false, description: '' })).status, 200)
    assert.equal((await call(`/catalog/photos/${photoId}/image`, catalogToken)).status, 404)
    const backupData = await backup.createBackup()
    assert.ok(backupData.data.catalogPhotoLinks.rows.some((r) => String(r.photo_id) === photoId))
    assert.equal(backupData.data.catalogSessions, undefined)
    assert.equal((await call('/catalog/session', catalogToken, 'DELETE')).status, 200)
    assert.equal((await call('/catalog', catalogToken)).status, 401)
    await backup.restoreBackup(backupData)
    const restored = await pool.query('SELECT photo_id::TEXT, is_active FROM catalog_photo_links WHERE product_id = $1', [second])
    assert.deepEqual(restored.rows, [{ photo_id: photoId, is_active: true }])
    assert.equal((await pool.query('SELECT show_sale_prices FROM catalog_settings WHERE id = 1')).rows[0].show_sale_prices, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await pool.end()
  }
})
