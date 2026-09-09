const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  assertStoreId,
  createDeviceSettingsStore,
} = require('../device-settings.cjs')

test('validates store IDs before they reach local settings', () => {
  assert.equal(assertStoreId('42'), '42')

  for (const value of [
    42,
    '0',
    '01',
    '-1',
    '1.5',
    '9223372036854775808',
    '',
    null,
  ]) {
    assert.throws(() => assertStoreId(value), TypeError)
  }
})

test('returns an unconfigured assignment when no local file exists', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'store-settings-'))

  try {
    const settings = createDeviceSettingsStore(directory)
    assert.deepEqual(await settings.getStoreAssignment(), { storeId: null })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('persists the selected store only in the local settings directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'store-settings-'))

  try {
    const settings = createDeviceSettingsStore(directory)
    assert.deepEqual(await settings.setStoreAssignment('2'), { storeId: '2' })
    assert.deepEqual(await settings.getStoreAssignment(), { storeId: '2' })

    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, 'device-settings.json'), 'utf8'),
    )
    assert.deepEqual(persisted, { storeId: '2' })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('rejects a corrupt local assignment instead of silently changing stores', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'store-settings-'))

  try {
    await fs.writeFile(
      path.join(directory, 'device-settings.json'),
      '{"storeId":"not-an-id"}',
      'utf8',
    )
    const settings = createDeviceSettingsStore(directory)

    await assert.rejects(
      settings.getStoreAssignment(),
      /إعدادات المتجر المحلية غير صالحة/,
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
