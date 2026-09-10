const fs = require('node:fs/promises')
const path = require('node:path')

const settingsFilename = 'device-settings.json'
const storeIdPattern = /^[1-9]\d*$/
const postgresBigintMax = 9_223_372_036_854_775_807n
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/

function assertStoreId(storeId) {
  if (
    typeof storeId !== 'string' ||
    !storeIdPattern.test(storeId) ||
    BigInt(storeId) > postgresBigintMax
  ) {
    throw new TypeError('معرّف المتجر غير صالح')
  }

  return storeId
}

function createDeviceSettingsStore(userDataDirectory) {
  const settingsPath = path.join(userDataDirectory, settingsFilename)
  let updateQueue = Promise.resolve()

  async function readSettings() {
    let content
    try {
      content = await fs.readFile(settingsPath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw new Error('تعذر قراءة إعدادات الجهاز المحلية', { cause: error })
    }

    try {
      const settings = JSON.parse(content)
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError()
      if (settings.storeId !== undefined) assertStoreId(settings.storeId)
      if (settings.backupDirectory !== undefined
        && (typeof settings.backupDirectory !== 'string' || !path.isAbsolute(settings.backupDirectory))) {
        throw new TypeError()
      }
      if (settings.lastAutomaticBackupDate !== undefined
        && (typeof settings.lastAutomaticBackupDate !== 'string'
          || !localDatePattern.test(settings.lastAutomaticBackupDate))) {
        throw new TypeError()
      }
      return settings
    } catch (error) {
      throw new Error('إعدادات المتجر المحلية غير صالحة', { cause: error })
    }
  }

  function updateSettings(change) {
    const operation = updateQueue.then(async () => {
      const current = await readSettings()
      const updated = { ...current, ...change }
      const temporaryPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`
      await fs.mkdir(userDataDirectory, { recursive: true })
      try {
        await fs.writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        })
        await fs.rename(temporaryPath, settingsPath)
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => {})
        throw new Error('تعذر حفظ إعدادات الجهاز المحلية', { cause: error })
      }
      return updated
    })
    updateQueue = operation.catch(() => {})
    return operation
  }

  async function getStoreAssignment() {
    const settings = await readSettings()
    return Object.freeze({ storeId: settings.storeId ?? null })
  }

  async function setStoreAssignment(storeId) {
    const validatedStoreId = assertStoreId(storeId)
    await updateSettings({ storeId: validatedStoreId })
    return Object.freeze({ storeId: validatedStoreId })
  }

  async function getBackupSettings() {
    const settings = await readSettings()
    return Object.freeze({
      directory: settings.backupDirectory ?? null,
      lastAutomaticBackupDate: settings.lastAutomaticBackupDate ?? null,
    })
  }

  async function setBackupDirectory(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new TypeError('مجلد النسخ الاحتياطي غير صالح')
    }
    const resolved = path.resolve(directory)
    const stats = await fs.lstat(resolved)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new TypeError('مجلد النسخ الاحتياطي غير صالح أو يشير إلى رابط')
    }
    const canonicalDirectory = await fs.realpath(resolved)
    await updateSettings({ backupDirectory: canonicalDirectory })
    return Object.freeze({ directory: canonicalDirectory })
  }

  async function setLastAutomaticBackupDate(date) {
    if (typeof date !== 'string' || !localDatePattern.test(date)) {
      throw new TypeError('تاريخ النسخ التلقائي غير صالح')
    }
    await updateSettings({ lastAutomaticBackupDate: date })
    return Object.freeze({ lastAutomaticBackupDate: date })
  }

  return Object.freeze({
    getStoreAssignment,
    setStoreAssignment,
    getBackupSettings,
    setBackupDirectory,
    setLastAutomaticBackupDate,
  })
}

module.exports = {
  assertStoreId,
  createDeviceSettingsStore,
}
