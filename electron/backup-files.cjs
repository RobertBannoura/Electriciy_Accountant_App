const fs = require('node:fs/promises')
const path = require('node:path')

const maxBackupBytes = 100 * 1024 * 1024
const maximumBackupDepth = 32
const maximumBackupNodes = 2_000_000
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const schemaVersionPattern = /^\d{4}_[A-Za-z0-9_-]+\.sql$/

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || !isoTimestampPattern.test(value)) return false
  const timestamp = new Date(value)
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value
}

function localDateKey(date = new Date()) {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function assertBackupEnvelope(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)
    || backup.format !== 'electricity-accountant-backup'
    || backup.formatVersion !== 1
    || !isCanonicalTimestamp(backup.timestamp)
    || typeof backup.schemaVersion !== 'string'
    || !schemaVersionPattern.test(backup.schemaVersion)
    || backup.schemaVersion.length > 128
    || typeof backup.checksum !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(backup.checksum)) {
    throw new TypeError('ملف النسخة الاحتياطية غير صالح')
  }
  assertBoundedJsonTree(backup)
  return backup
}

function assertBoundedJsonTree(value) {
  const pending = [{ value, depth: 0 }]
  const seen = new Set()
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    nodes += 1
    if (nodes > maximumBackupNodes || current.depth > maximumBackupDepth) {
      throw new TypeError('بنية ملف النسخة الاحتياطية معقدة أكثر من الحد المسموح')
    }
    if (current.value === null || typeof current.value !== 'object') continue
    if (seen.has(current.value)) throw new TypeError('بنية ملف النسخة الاحتياطية دائرية وغير صالحة')
    seen.add(current.value)
    for (const child of Object.values(current.value)) {
      pending.push({ value: child, depth: current.depth + 1 })
    }
  }
}

function samePath(left, right) {
  const normalize = (value) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase()
    : path.resolve(value)
  return normalize(left) === normalize(right)
}

async function requireOrdinaryDirectory(directory) {
  const resolved = path.resolve(directory)
  const stats = await fs.lstat(resolved)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('مجلد النسخ الاحتياطي غير متاح أو يشير إلى رابط')
  }
  const real = await fs.realpath(resolved)
  if (!samePath(real, resolved)) {
    throw new Error('مجلد النسخ الاحتياطي لا يجوز أن يمر عبر رابط رمزي')
  }
  return real
}

function createBackupFileStore(deviceSettings, { now = () => new Date() } = {}) {
  let saveQueue = Promise.resolve()

  async function getStatus() {
    const settings = await deviceSettings.getBackupSettings()
    const today = localDateKey(now())
    return Object.freeze({
      ...settings,
      today,
      automaticBackupDue: Boolean(
        settings.directory && settings.lastAutomaticBackupDate !== today,
      ),
    })
  }

  function saveBackup(backup, { automatic = false } = {}) {
    const operation = saveQueue.then(async () => {
      assertBackupEnvelope(backup)
      const status = await getStatus()
      if (!status.directory) {
        if (automatic) return { saved: false, skipped: true, reason: 'directory-not-configured' }
        throw new Error('يجب اختيار مجلد النسخ الاحتياطي أولاً')
      }
      if (automatic && !status.automaticBackupDue) {
        return { saved: false, skipped: true, reason: 'already-created-today' }
      }

      const backupDirectory = await requireOrdinaryDirectory(status.directory)

      const serialized = `${JSON.stringify(backup, null, 2)}\n`
      if (Buffer.byteLength(serialized, 'utf8') > maxBackupBytes) {
        throw new Error('حجم النسخة الاحتياطية أكبر من الحد المسموح')
      }

      const stamp = backup.timestamp.replace(/[-:.Z]/g, '').slice(0, 17)
      const filename = automatic
        ? `electricity-accountant-automatic-${status.today}.json`
        : `electricity-accountant-${stamp}-manual.json`
      const destination = path.join(backupDirectory, filename)
      const temporary = path.join(backupDirectory, `.${filename}.${process.pid}.${Date.now()}.tmp`)

      if (automatic) {
        try {
          const existing = await fs.stat(destination)
          if (existing.isFile()) {
            await deviceSettings.setLastAutomaticBackupDate(status.today)
            return { saved: false, skipped: true, reason: 'already-created-today' }
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }

      try {
        await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await fs.rename(temporary, destination)
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {})
        throw new Error('تعذر كتابة ملف النسخة الاحتياطية', { cause: error })
      }

      if (automatic) await deviceSettings.setLastAutomaticBackupDate(status.today)
      return { saved: true, skipped: false, path: destination }
    })
    saveQueue = operation.catch(() => {})
    return operation
  }

  async function readBackup(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || path.extname(filePath).toLowerCase() !== '.json') {
      throw new TypeError('مسار ملف النسخة الاحتياطية غير صالح')
    }
    const stats = await fs.lstat(filePath)
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > maxBackupBytes) {
      throw new Error('حجم ملف النسخة الاحتياطية غير صالح')
    }
    let backup
    try {
      backup = JSON.parse(await fs.readFile(filePath, 'utf8'))
    } catch (error) {
      throw new Error('تعذر قراءة ملف النسخة الاحتياطية', { cause: error })
    }
    assertBackupEnvelope(backup)
    return { path: filePath, name: path.basename(filePath), backup }
  }

  return Object.freeze({ getStatus, saveBackup, readBackup })
}

module.exports = {
  assertBackupEnvelope,
  createBackupFileStore,
  localDateKey,
  maxBackupBytes,
  requireOrdinaryDirectory,
}
