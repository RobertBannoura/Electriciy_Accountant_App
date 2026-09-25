const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '..')
const vendorRoot = path.join(repositoryRoot, 'vendor', 'postgresql')
const archive = path.join(vendorRoot, 'windows-x64.zip')
const archiveSha256 = 'B88EBEC9316B77B18D6729278FD0FC961EEF1D01886EBEEDB269D5527A8273DE'

async function isComplete(directory) {
  try {
    for (const entry of ['bin/postgres.exe', 'bin/initdb.exe', 'bin/pg_ctl.exe',
      'bin/psql.exe', 'share/postgres.bki']) {
      await fs.access(path.join(directory, entry))
    }
    await fs.access(path.join(directory, 'lib'))
    return true
  } catch { return false }
}

async function ensurePostgresRuntime(destination = path.join(vendorRoot, 'windows-x64')) {
  if (await isComplete(destination)) return destination
  try {
    await fs.access(destination)
    throw new Error('The extracted PostgreSQL directory is incomplete; inspect it before rebuilding.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex').toUpperCase()
  if (digest !== archiveSha256) throw new Error('The bundled PostgreSQL archive checksum does not match.')
  const temporary = path.join(path.dirname(destination), `.postgres-extract-${process.pid}`)
  await fs.mkdir(temporary, { recursive: false })
  try {
    const result = spawnSync('tar.exe', ['-xf', archive, '-C', temporary], {
      windowsHide: true, shell: false, stdio: 'ignore', timeout: 180_000,
    })
    if (result.status !== 0 || !await isComplete(path.join(temporary, 'windows-x64'))) {
      throw new Error('The bundled PostgreSQL archive could not be extracted.')
    }
    await fs.rename(path.join(temporary, 'windows-x64'), destination)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
  return destination
}

module.exports = { ensurePostgresRuntime }
