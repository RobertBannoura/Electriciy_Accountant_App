import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError } from '../errors/app-error.js'
import { env } from '../config/env.js'

const keyPattern = /^(?:daily-orders\/\d{4}-\d{2}-\d{2}\/\d+|catalog\/\d+)\/[a-f0-9-]{36}\/(?:full|thumb)\.(?:jpg|webp)$/

export function photoMedia(key) {
  if (!keyPattern.test(key)) throw new AppError('مسار الصورة غير صالح', 400, 'INVALID_PHOTO_KEY')
  return key.endsWith('.webp') ? { type: 'image/webp', extension: 'webp' } : { type: 'image/jpeg', extension: 'jpg' }
}

export function createLocalPhotoStorage(directory) {
  const root = path.resolve(directory)
  function filename(key) {
    if (!keyPattern.test(key)) throw new AppError('مسار الصورة غير صالح', 400, 'INVALID_PHOTO_KEY')
    return path.join(root, ...key.split('/'))
  }
  return {
    async put(key, bytes) {
      const target = filename(key)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, bytes)
    },
    async get(key) { return readFile(filename(key)) },
    async remove(key) { await unlink(filename(key)).catch((error) => { if (error.code !== 'ENOENT') throw error }) },
  }
}

export function s3PhotoConfiguration(values = process.env) {
  const bucket = values.PHOTO_S3_BUCKET || values.AWS_S3_BUCKET_NAME
  const endpoint = values.PHOTO_S3_ENDPOINT || values.AWS_ENDPOINT_URL
  const photoCredentials = Boolean(values.PHOTO_S3_ACCESS_KEY_ID || values.PHOTO_S3_SECRET_ACCESS_KEY)
  const accessKeyId = photoCredentials ? values.PHOTO_S3_ACCESS_KEY_ID : values.AWS_ACCESS_KEY_ID
  const secretAccessKey = photoCredentials ? values.PHOTO_S3_SECRET_ACCESS_KEY : values.AWS_SECRET_ACCESS_KEY
  if (!bucket || Boolean(accessKeyId) !== Boolean(secretAccessKey) || (endpoint && !accessKeyId)) {
    throw new AppError('يجب إكمال إعداد حاوية الصور ومفاتيح الوصول على الخادم أولاً', 503, 'PHOTO_STORAGE_NOT_CONFIGURED')
  }
  return {
    bucket,
    clientOptions: {
      region: values.PHOTO_S3_REGION || values.AWS_REGION || values.AWS_DEFAULT_REGION || 'auto',
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: values.PHOTO_S3_FORCE_PATH_STYLE
        ? values.PHOTO_S3_FORCE_PATH_STYLE === 'true' : values.AWS_S3_URL_STYLE === 'path',
      ...(accessKeyId ? { credentials: {
        accessKeyId, secretAccessKey,
        ...(!photoCredentials && values.AWS_SESSION_TOKEN ? { sessionToken: values.AWS_SESSION_TOKEN } : {}),
      } } : {}),
    },
  }
}

let storage
export async function getPhotoStorage() {
  if (storage) return storage
  const driver = process.env.PHOTO_STORAGE_DRIVER ?? 'local'
  if (driver === 'local') {
    const configuredDirectory = process.env.PHOTO_STORAGE_DIR || undefined
    if (env.nodeEnv === 'production' && (!configuredDirectory || !path.isAbsolute(configuredDirectory))) {
      throw new AppError('يجب إعداد تخزين الصور على الخادم أولاً', 503, 'PHOTO_STORAGE_NOT_CONFIGURED')
    }
    const directory = configuredDirectory ?? fileURLToPath(new URL('../../data/photo-bucket/', import.meta.url))
    storage = createLocalPhotoStorage(directory)
  } else if (driver === 's3') {
    const { bucket, clientOptions } = s3PhotoConfiguration()
    const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    const client = new S3Client(clientOptions)
    const object = (key) => {
      if (!keyPattern.test(key)) throw new AppError('مسار الصورة غير صالح', 400, 'INVALID_PHOTO_KEY')
      return { Bucket: bucket, Key: key }
    }
    storage = {
      async put(key, bytes) { await client.send(new PutObjectCommand({ ...object(key), Body: bytes, ContentType: photoMedia(key).type })) },
      async get(key) {
        const result = await client.send(new GetObjectCommand(object(key)))
        return Buffer.from(await result.Body.transformToByteArray())
      },
      async remove(key) { await client.send(new DeleteObjectCommand(object(key))) },
    }
  } else {
    throw new AppError('إعداد تخزين الصور غير صالح', 503, 'PHOTO_STORAGE_NOT_CONFIGURED')
  }
  return storage
}
