const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createBackupFileStore, localDateKey } = require('../backup-files.cjs')
const { createDeviceSettingsStore } = require('../device-settings.cjs')

const sampleBackup = Object.freeze({
  format: 'electricity-accountant-backup',
  formatVersion: 1,
  schemaVersion: '0022_vapid_admin_notifications.sql',
  timestamp: '2026-09-09T10:20:30.000Z',
  checksum: `sha256:${'a'.repeat(64)}`,
  data: {},
})

test('uses the Windows-local calendar date for the daily guard', () => {
  assert.equal(localDateKey(new Date(2026, 8, 9, 23, 59)), '2026-09-09')
})

test('preserves device assignment while adding backup settings', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-settings-'))
  const backupDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-target-'))
  try {
    const settings = createDeviceSettingsStore(directory)
    await settings.setStoreAssignment('2')
    await settings.setBackupDirectory(backupDirectory)
    assert.deepEqual(await settings.getStoreAssignment(), { storeId: '2' })
    assert.deepEqual(await settings.getBackupSettings(), {
      directory: backupDirectory,
      lastAutomaticBackupDate: null,
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(backupDirectory, { recursive: true, force: true })
  }
})

test('writes no more than one successful automatic backup per day', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-settings-'))
  const backupDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-target-'))
  try {
    const settings = createDeviceSettingsStore(directory)
    await settings.setBackupDirectory(backupDirectory)
    const files = createBackupFileStore(settings, {
      now: () => new Date(2026, 8, 9, 12, 0),
    })

    const first = await files.saveBackup(sampleBackup, { automatic: true })
    const second = await files.saveBackup(sampleBackup, { automatic: true })
    assert.equal(first.saved, true)
    assert.deepEqual(second, {
      saved: false,
      skipped: true,
      reason: 'already-created-today',
    })
    const savedFiles = (await fs.readdir(backupDirectory)).filter((name) => name.endsWith('.json'))
    assert.equal(savedFiles.length, 1)
    assert.equal((await settings.getBackupSettings()).lastAutomaticBackupDate, '2026-09-09')
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(backupDirectory, { recursive: true, force: true })
  }
})

test('reads a selected JSON backup without accepting arbitrary JSON', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-read-'))
  try {
    const settings = {
      getBackupSettings: async () => ({ directory, lastAutomaticBackupDate: null }),
    }
    const files = createBackupFileStore(settings)
    const validPath = path.join(directory, 'valid.json')
    const invalidPath = path.join(directory, 'invalid.json')
    const htmlPath = path.join(directory, 'backup.html')
    await fs.writeFile(validPath, JSON.stringify(sampleBackup), 'utf8')
    await fs.writeFile(invalidPath, '{"hello":"world"}', 'utf8')
    await fs.writeFile(htmlPath, JSON.stringify(sampleBackup), 'utf8')
    assert.equal((await files.readBackup(validPath)).backup.checksum, sampleBackup.checksum)
    await assert.rejects(files.readBackup(invalidPath), /ملف النسخة الاحتياطية غير صالح/)
    await assert.rejects(files.readBackup(htmlPath), TypeError)
    await assert.rejects(files.readBackup('..\\relative-backup.json'), TypeError)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('malicious backup timestamps, checksums, and deeply nested IPC payloads are rejected', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-hostile-'))
  try {
    const settings = {
      getBackupSettings: async () => ({ directory, lastAutomaticBackupDate: null }),
    }
    const files = createBackupFileStore(settings)
    await assert.rejects(
      files.saveBackup({ ...sampleBackup, timestamp: '09/10/2026/../../escape' }),
      TypeError,
    )
    await assert.rejects(
      files.saveBackup({ ...sampleBackup, timestamp: '2026-99-99T99:99:99.999Z' }),
      TypeError,
    )
    await assert.rejects(
      files.saveBackup({ ...sampleBackup, checksum: 'sha256:not-a-checksum' }),
      TypeError,
    )
    let nested = {}
    for (let index = 0; index < 34; index += 1) nested = { child: nested }
    await assert.rejects(
      files.saveBackup({ ...sampleBackup, data: nested }),
      /معقدة/,
    )
    assert.deepEqual(await fs.readdir(directory), [])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('backup destinations cannot be symbolic links or directory junctions', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-link-parent-'))
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-link-target-'))
  const link = path.join(parent, 'redirected-backups')
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    const settings = createDeviceSettingsStore(path.join(parent, 'settings'))
    await assert.rejects(settings.setBackupDirectory(link), /رابط/)
  } finally {
    await fs.rm(parent, { recursive: true, force: true })
    await fs.rm(target, { recursive: true, force: true })
  }
})
