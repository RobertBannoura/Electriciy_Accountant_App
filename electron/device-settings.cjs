const fs = require('node:fs/promises')
const path = require('node:path')

const settingsFilename = 'device-settings.json'
const storeIdPattern = /^[1-9]\d*$/
const postgresBigintMax = 9_223_372_036_854_775_807n

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

  async function getStoreAssignment() {
    let content

    try {
      content = await fs.readFile(settingsPath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') {
        return Object.freeze({ storeId: null })
      }

      throw new Error('تعذر قراءة إعدادات المتجر المحلية', { cause: error })
    }

    try {
      const settings = JSON.parse(content)
      return Object.freeze({ storeId: assertStoreId(settings.storeId) })
    } catch (error) {
      throw new Error('إعدادات المتجر المحلية غير صالحة', { cause: error })
    }
  }

  async function setStoreAssignment(storeId) {
    const validatedStoreId = assertStoreId(storeId)
    const temporaryPath = `${settingsPath}.${process.pid}.tmp`
    const serializedSettings = `${JSON.stringify({ storeId: validatedStoreId }, null, 2)}\n`

    await fs.mkdir(userDataDirectory, { recursive: true })

    try {
      await fs.writeFile(temporaryPath, serializedSettings, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await fs.rename(temporaryPath, settingsPath)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {})
      throw new Error('تعذر حفظ إعدادات المتجر المحلية', { cause: error })
    }

    return Object.freeze({ storeId: validatedStoreId })
  }

  return Object.freeze({ getStoreAssignment, setStoreAssignment })
}

module.exports = {
  assertStoreId,
  createDeviceSettingsStore,
}
