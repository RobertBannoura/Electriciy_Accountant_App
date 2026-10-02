import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

const databaseUrl = process.env.PHOTO_INTEGRATION_DATABASE_URL
test('private daily photos upload, retry and view through the authenticated API', {
  skip: databaseUrl ? false : 'PHOTO_INTEGRATION_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = databaseUrl
  process.env.NODE_ENV = 'test'
  process.env.PHOTO_STORAGE_DRIVER = 'local'
  process.env.PHOTO_STORAGE_DIR = await mkdtemp(path.join(os.tmpdir(), 'order-photo-api-'))
  const [{ app }, { pool }, { provisionAdmin }] = await Promise.all([
    import('../src/app.js'), import('../src/db/pool.js'), import('../src/auth/provision-admin.js'),
  ])
  const username = `photos_${randomBytes(8).toString('hex')}`
  const password = randomBytes(32).toString('base64url')
  await provisionAdmin(pool, { username, password, displayName: 'Photos QA' })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api`
  try {
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
    const { token } = await login.json()
    const auth = { Authorization: `Bearer ${token}` }
    const { stores } = await (await fetch(`${base}/stores`, { headers: auth })).json()
    const headers = { ...auth, 'X-Store-Id': stores[0].id, 'Content-Type': 'image/jpeg' }
    const date = '2026-09-27'
    const image = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#008080' } }).png().toBuffer()
    const uploadId = randomUUID()
    const url = `${base}/order-photos/${uploadId}?date=${date}`
    assert.equal((await fetch(url, { method: 'PUT', body: image, headers: { 'Content-Type': 'image/jpeg' } })).status, 401)
    const uploaded = await fetch(url, { method: 'PUT', headers, body: image })
    assert.equal(uploaded.status, 201)
    const { photo } = await uploaded.json()
    assert.equal(photo.business_date, date)
    assert.equal(photo.width, 640)
    assert.equal(photo.object_key, undefined)
    const retry = await fetch(url, { method: 'PUT', headers, body: image })
    assert.equal(retry.status, 200)
    assert.equal((await retry.json()).photo.id, photo.id)
    assert.equal((await fetch(url, { method: 'PUT', headers, body: Buffer.from('different') })).status, 409)
    assert.equal((await fetch(`${base}/order-photos/${randomUUID()}?date=${date}`, { method: 'PUT', headers, body: Buffer.from('fake JPEG') })).status, 400)
    assert.equal((await fetch(`${base}/order-photos/${randomUUID()}?date=invalid`, { method: 'PUT', headers, body: image })).status, 400)
    assert.equal((await fetch(`${base}/order-photos/${randomUUID()}`, { method: 'PUT', headers, body: Buffer.alloc(25 * 1024 * 1024 + 1) })).status, 413)
    const listing = await (await fetch(`${base}/order-photos?date=${date}`, { headers })).json()
    assert.ok(listing.photos.some((row) => row.id === photo.id))
    const anotherDay = await (await fetch(`${base}/order-photos?date=2026-09-26`, { headers })).json()
    assert.ok(!anotherDay.photos.some((row) => row.id === photo.id))
    const downloadUrl = `${base}/order-photos/${photo.id}/image?size=thumbnail`
    assert.equal((await fetch(downloadUrl)).status, 401)
    assert.equal((await fetch(downloadUrl, { headers: { ...headers, 'X-Store-Id': stores[1].id } })).status, 404)
    const downloaded = await fetch(downloadUrl, { headers })
    assert.equal(downloaded.status, 200)
    assert.equal(downloaded.headers.get('content-type'), 'image/webp')
    assert.match(downloaded.headers.get('content-disposition'), /\.webp"$/)
    assert.equal(downloaded.headers.get('cache-control'), 'no-store')
    const thumbnail = await sharp(Buffer.from(await downloaded.arrayBuffer())).metadata()
    assert.equal(thumbnail.width, 600)
    assert.equal(thumbnail.format, 'webp')
    assert.equal(thumbnail.exif, undefined)
    const before = await (await fetch(`${base}/order-photos?date=${date}&before=${photo.id}`, { headers })).json()
    assert.ok(!before.photos.some((row) => row.id === photo.id))
    const { getPhotoStorage } = await import('../src/photos/photo-storage.js')
    const storage = await getPhotoStorage()
    const legacyKey = `daily-orders/${date}/${stores[0].id}/${uploadId}/thumb.jpg`
    await storage.put(legacyKey, await sharp(image).jpeg().toBuffer())
    await pool.query('UPDATE daily_order_photos SET thumbnail_key = $1 WHERE id = $2', [legacyKey, photo.id])
    const legacy = await fetch(downloadUrl, { headers })
    assert.equal(legacy.headers.get('content-type'), 'image/jpeg')
    assert.match(legacy.headers.get('content-disposition'), /\.jpg"$/)
    assert.equal((await sharp(Buffer.from(await legacy.arrayBuffer())).metadata()).format, 'jpeg')
    assert.equal((await fetch(`${base}/order-photos/${photo.id}`, { method: 'DELETE', headers: { ...headers, 'X-Store-Id': stores[1].id } })).status, 404)
    assert.equal((await fetch(`${base}/order-photos/${photo.id}`, { method: 'DELETE', headers })).status, 200)
    assert.equal((await fetch(downloadUrl, { headers })).status, 404)
    assert.equal((await fetch(`${base}/order-photos/${photo.id}`, { method: 'DELETE', headers })).status, 404)
    assert.ok((await pool.query('SELECT deleted_at FROM daily_order_photos WHERE id = $1', [photo.id])).rows[0].deleted_at)
    assert.equal((await fetch(url, { method: 'PUT', headers, body: image })).status, 409, 'a delayed retry cannot restore a deleted image')
    assert.ok(!(await (await fetch(`${base}/order-photos?date=${date}`, { headers })).json()).photos.some((row) => row.id === photo.id))
    await assert.rejects(storage.get(legacyKey), { code: 'ENOENT' })
    await assert.rejects(storage.get(`daily-orders/${date}/${stores[0].id}/${uploadId}/full.webp`), { code: 'ENOENT' })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await pool.end()
  }
})
