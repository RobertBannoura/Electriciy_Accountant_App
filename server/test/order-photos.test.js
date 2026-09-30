import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import sharp from 'sharp'
import { normalizePhoto, parsePhotoDate } from '../src/photos/order-photos.js'
import { createLocalPhotoStorage, s3PhotoConfiguration, photoMedia } from '../src/photos/photo-storage.js'

test('custom photo buckets reject missing or mismatched credential pairs', () => {
  const base = { PHOTO_S3_BUCKET: 'test-bucket', PHOTO_S3_ENDPOINT: 'https://t3.storageapi.dev' }
  for (const credentials of [
    {}, { PHOTO_S3_ACCESS_KEY_ID: 'test-id' }, { PHOTO_S3_SECRET_ACCESS_KEY: 'test-secret' },
    { PHOTO_S3_ACCESS_KEY_ID: 'test-id', AWS_SECRET_ACCESS_KEY: 'unrelated-secret' },
  ]) {
    assert.throws(() => s3PhotoConfiguration({ ...base, ...credentials }), { code: 'PHOTO_STORAGE_NOT_CONFIGURED' })
  }
  const configured = s3PhotoConfiguration({ ...base, PHOTO_S3_ACCESS_KEY_ID: 'test-id', PHOTO_S3_SECRET_ACCESS_KEY: 'test-secret' })
  assert.equal(configured.clientOptions.region, 'auto')
  assert.equal(configured.clientOptions.forcePathStyle, false)
  assert.equal(configured.bucket, 'test-bucket')
})

test('Railway AWS variables work and dedicated photo configuration takes precedence', () => {
  const aws = { AWS_S3_BUCKET_NAME: 'test-bucket', AWS_ENDPOINT_URL: 'https://t3.storageapi.dev',
    AWS_DEFAULT_REGION: 'auto', AWS_S3_URL_STYLE: 'path', AWS_ACCESS_KEY_ID: 'test-id', AWS_SECRET_ACCESS_KEY: 'test-secret' }
  const configured = s3PhotoConfiguration(aws)
  assert.equal(configured.clientOptions.endpoint, aws.AWS_ENDPOINT_URL)
  assert.equal(configured.clientOptions.credentials.accessKeyId, 'test-id')
  assert.equal(configured.clientOptions.forcePathStyle, true)
  const overridden = s3PhotoConfiguration({ ...aws, PHOTO_S3_BUCKET: 'photo-bucket', PHOTO_S3_FORCE_PATH_STYLE: 'false' })
  assert.equal(overridden.bucket, 'photo-bucket')
  assert.equal(overridden.clientOptions.forcePathStyle, false)
  assert.equal(s3PhotoConfiguration({ PHOTO_S3_BUCKET: 'aws-bucket' }).clientOptions.credentials, undefined)
})

test('photos are decoded, oriented, and stored as WebP without source metadata', async () => {
  const source = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#008080' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer()
  const result = await normalizePhoto(source)
  assert.equal(result.width, 40)
  assert.equal(result.height, 80)
  const metadata = await sharp(result.data).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.exif, undefined)
  assert.equal(metadata.orientation, undefined)
  assert.equal((await sharp(result.thumbnail).metadata()).format, 'webp')
})

test('common still-image formats convert to WebP with bounded dimensions', async () => {
  for (const format of ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff']) {
    const source = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#bbaacc' } }).toFormat(format).toBuffer()
    const normalized = await normalizePhoto(source)
    const full = await sharp(normalized.data).metadata()
    const thumb = await sharp(normalized.thumbnail).metadata()
    assert.equal(full.format, 'webp', format)
    assert.equal(full.width, 800, format)
    assert.equal(thumb.format, 'webp', format)
    assert.equal(thumb.width, 600, format)
    assert.equal(thumb.height, 300, format)
  }
})

test('photo input rejects empty, invalid, SVG and invalid dates', async () => {
  await assert.rejects(normalizePhoto(Buffer.alloc(0)), { code: 'EMPTY_PHOTO' })
  await assert.rejects(normalizePhoto(Buffer.from('not an image')), { code: 'INVALID_PHOTO' })
  await assert.rejects(normalizePhoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')), { code: 'INVALID_PHOTO' })
  assert.equal(parsePhotoDate('2028-02-29'), '2028-02-29')
  for (const date of ['2026-02-29', ['2026-09-27'], {}, '../photos', '']) {
    assert.throws(() => parsePhotoDate(date), { code: 'INVALID_PHOTO_DATE' })
  }
})

test('local photo bucket reads only server-generated keys', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'order-photo-test-'))
  const storage = createLocalPhotoStorage(directory)
  const key = 'daily-orders/2026-09-27/1/5d6ca162-69e6-4d8a-9d22-814983948d47/full.jpg'
  try {
    await storage.put(key, Buffer.from('test'))
    assert.equal((await storage.get(key)).toString(), 'test')
    const webpKey = 'catalog/1/5d6ca162-69e6-4d8a-9d22-814983948d47/thumb.webp'
    await storage.put(webpKey, Buffer.from('webp-test'))
    assert.equal((await storage.get(webpKey)).toString(), 'webp-test')
    assert.deepEqual(photoMedia(webpKey), { type: 'image/webp', extension: 'webp' })
    assert.deepEqual(photoMedia(key), { type: 'image/jpeg', extension: 'jpg' })
    assert.throws(() => photoMedia('../test.webp'), { code: 'INVALID_PHOTO_KEY' })
    for (const key of ['../secrets', '/absolute/path', 'daily-orders/../file.jpg', 'daily-orders\\file.jpg']) {
      await assert.rejects(storage.get(key), { code: 'INVALID_PHOTO_KEY' })
    }
    await storage.remove(key)
    await assert.rejects(storage.get(key), { code: 'ENOENT' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
