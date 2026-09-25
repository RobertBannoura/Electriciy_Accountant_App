const { spawn } = require('node:child_process')
const { createHash, randomBytes } = require('node:crypto')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')

const databaseName = 'electricity_accountant'
const databaseUser = 'trial_owner'
const configName = 'runtime.json'
const maxOutputBytes = 1024 * 1024

function localDataRoot() {
  const localAppData = process.env.LOCALAPPDATA
  if (process.platform !== 'win32' || !localAppData || !path.isAbsolute(localAppData)) {
    throw new Error('Windows local application data is unavailable.')
  }
  return path.join(localAppData, 'ElectricityAccountantTrial')
}

function runtimePaths(app) {
  const root = localDataRoot()
  const bundle = app.isPackaged
    ? path.join(process.resourcesPath, 'windows-x64')
    : path.resolve(__dirname, '..', 'vendor', 'postgresql', 'windows-x64')
  const server = app.isPackaged
    ? path.join(process.resourcesPath, 'trial-server', 'server')
    : path.resolve(__dirname, '..', 'server')
  return {
    root,
    config: path.join(root, 'config'),
    data: path.join(root, 'postgres-data'),
    backups: path.join(root, 'backups'),
    logs: path.join(root, 'logs'),
    bundle,
    server,
    nodeExecutable: app.trialNodeExecutable ?? process.execPath,
  }
}

function assertConfig(config) {
  if (!config || config.version !== 1
    || !/^[a-f0-9]{64}$/.test(config.databasePassword)
    || !/^[a-f0-9]{64}$/.test(config.runtimeToken)
    || ![config.databasePort, config.backendPort].every(
      (port) => Number.isInteger(port) && port >= 1024 && port <= 65535,
    ) || config.databasePort === config.backendPort) {
    throw new Error('The local runtime configuration is invalid.')
  }
  return config
}

async function writeConfig(paths, config) {
  assertConfig(config)
  const destination = path.join(paths.config, configName)
  const temporary = `${destination}.${process.pid}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    })
    await fs.rename(temporary, destination)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

async function readOrCreateConfig(paths) {
  try {
    return assertConfig(JSON.parse(await fs.readFile(path.join(paths.config, configName), 'utf8')))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const config = {
    version: 1,
    databasePassword: randomBytes(32).toString('hex'),
    runtimeToken: randomBytes(32).toString('hex'),
    databasePort: await choosePort(),
    backendPort: await choosePort(),
  }
  if (config.backendPort === config.databasePort) config.backendPort = await choosePort()
  await writeConfig(paths, config)
  return config
}

function choosePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port
      listener.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const listener = net.createServer()
    listener.once('error', () => resolve(false))
    listener.listen(port, '127.0.0.1', () => listener.close(() => resolve(true)))
  })
}

function childEnvironment(extra = {}) {
  const inherited = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) inherited[key] = process.env[key]
  }
  return { ...inherited, ...extra }
}

function hiddenProcessOptions(options = {}) {
  return { ...options, windowsHide: true, detached: false, shell: false }
}

function childIsRunning(child) {
  return child && Number.isInteger(child.pid)
    && child.exitCode === null && child.signalCode === null
}

function waitForChild(child, timeout = 10_000) {
  if (!childIsRunning(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', finished); resolve(false) }, timeout)
    const finished = () => { clearTimeout(timer); resolve(true) }
    child.once('exit', finished)
  })
}

function run(executable, args, { env, cwd, timeout = 60_000, acceptFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, hiddenProcessOptions({
      cwd, env: childEnvironment(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    let output = ''
    let length = 0
    let settled = false
    const timer = setTimeout(() => child.kill(), timeout)
    const collect = (chunk) => {
      length += chunk.length
      if (length > maxOutputBytes) child.kill()
      else output += chunk.toString('utf8')
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const finish = (error, code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else if (code === 0 || acceptFailure) resolve({ code, output })
      else reject(new Error(`Local process failed with code ${code}.`))
    }
    child.once('error', (error) => finish(error))
    child.once('close', (code) => finish(null, code))
  })
}

function postgresTool(paths, name) {
  return path.join(paths.bundle, 'bin', `${name}.exe`)
}

async function assertBundle(paths) {
  for (const relative of [
    'bin/postgres.exe', 'bin/initdb.exe', 'bin/pg_ctl.exe',
    'bin/psql.exe', 'bin/createdb.exe', 'share/postgres.bki',
  ]) {
    await fs.access(path.join(paths.bundle, relative))
  }
  await fs.access(path.join(paths.bundle, 'lib'))
}

async function initializeData(paths, config) {
  try {
    await fs.access(path.join(paths.data, 'PG_VERSION'))
    return false
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  try {
    await fs.access(paths.data)
    throw new Error('The local data directory is incomplete and needs inspection.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const temporaryData = path.join(paths.root, 'postgres-data-initializing')
  if (path.dirname(path.resolve(temporaryData)) !== path.resolve(paths.root)) {
    throw new Error('Invalid temporary data path.')
  }
  await fs.rm(temporaryData, { recursive: true, force: true })
  await fs.mkdir(temporaryData, { recursive: true })
  const passwordFile = path.join(paths.config, `init-password-${process.pid}.tmp`)
  try {
    await fs.writeFile(passwordFile, `${config.databasePassword}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    })
    await run(postgresTool(paths, 'initdb'), [
      '-D', temporaryData, '-U', databaseUser, '--encoding=UTF8',
      '--auth-host=scram-sha-256', '--auth-local=scram-sha-256',
      '--pwfile', passwordFile,
    ], { timeout: 120_000 })
    await fs.rename(temporaryData, paths.data)
  } finally {
    await fs.rm(passwordFile, { force: true }).catch(() => {})
  }
  return true
}

async function configurePostgres(paths, port) {
  const configPath = path.join(paths.data, 'postgresql.conf')
  const original = await fs.readFile(configPath, 'utf8')
  const marker = '\n# Electricity Accountant Trial managed settings\n'
  const base = original.split(marker)[0]
  await fs.writeFile(configPath, `${base}${marker}listen_addresses = '127.0.0.1'\nport = ${port}\nssl = off\npassword_encryption = 'scram-sha-256'\n`, 'utf8')
  await fs.writeFile(path.join(paths.data, 'pg_hba.conf'),
    '# Local trial only\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 reject\n', 'utf8')
}

function databaseEnvironment(config) {
  return { PGPASSWORD: config.databasePassword, PGCONNECT_TIMEOUT: '5' }
}

async function psql(paths, config, database, sql) {
  const result = await run(postgresTool(paths, 'psql'), [
    '-X', '-w', '-t', '-A', '-h', '127.0.0.1', '-p', String(config.databasePort),
    '-U', databaseUser, '-d', database, '-c', sql,
  ], { env: databaseEnvironment(config), timeout: 15_000 })
  return result.output.trim()
}

function sameDirectory(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

async function assertOwnPostgres(paths, config) {
  const actual = await psql(paths, config, 'postgres',
    "SELECT current_setting('data_directory') || '|' || current_setting('listen_addresses')")
  const [directory, listenAddresses] = actual.split('|')
  if (!sameDirectory(directory, paths.data) || listenAddresses !== '127.0.0.1') {
    throw new Error('The local database identity or loopback binding is invalid.')
  }
}

async function stopPostgres(paths, config, child = null) {
  const status = await run(postgresTool(paths, 'pg_ctl'), ['-D', paths.data, 'status'], {
    acceptFailure: true, timeout: 10_000,
  })
  if (status.code === 0) {
    const pidLines = (await fs.readFile(path.join(paths.data, 'postmaster.pid'), 'utf8')).split(/\r?\n/)
    const runningPort = Number(pidLines[3])
    if (!Number.isInteger(runningPort) || runningPort < 1 || runningPort > 65535) {
      throw new Error('The local database has invalid process information.')
    }
    const actual = { ...config, databasePort: runningPort }
    await assertOwnPostgres(paths, actual)
    await run(postgresTool(paths, 'pg_ctl'), [
      '-D', paths.data, '-m', 'fast', '-w', '-t', '30', 'stop',
    ], { timeout: 40_000 })
  }
  if (childIsRunning(child) && !(await waitForChild(child, 5_000))) {
    child.kill()
    if (!(await waitForChild(child, 5_000))) throw new Error('The local database process did not stop.')
  }
}

async function stopBackend(paths, config, child = null) {
  const existing = await request(config.backendPort, config.runtimeToken, 'GET',
    '/api/health/trial-runtime')
  if (existing?.status === 200) {
    const result = await request(config.backendPort, config.runtimeToken, 'POST',
      '/api/health/trial-shutdown')
    if (result?.status !== 204) throw new Error('The local service rejected shutdown.')
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await portIsFree(config.backendPort)) break
      await pause(250)
    }
    if (!(await portIsFree(config.backendPort))) throw new Error('The local service did not stop.')
  }
  if (childIsRunning(child) && !(await waitForChild(child, 5_000))) {
    child.kill()
    if (!(await waitForChild(child, 5_000))) throw new Error('The local service process did not stop.')
  }
}

async function stopTrial(trial) {
  if (!trial) return
  const { paths, config, backendChild, postgresChild } = trial
  let firstError = null
  try { await stopBackend(paths, config, backendChild) } catch (error) { firstError = error }
  try { await stopPostgres(paths, config, postgresChild) } catch (error) { firstError ??= error }
  if (firstError) throw firstError
}

async function startPostgres(paths, config) {
  const status = await run(postgresTool(paths, 'pg_ctl'), ['-D', paths.data, 'status'], {
    acceptFailure: true, timeout: 10_000,
  })
  if (status.code === 0) {
    const pidLines = (await fs.readFile(path.join(paths.data, 'postmaster.pid'), 'utf8')).split(/\r?\n/)
    const runningPort = Number(pidLines[3])
    if (!Number.isInteger(runningPort) || runningPort < 1 || runningPort > 65535) {
      throw new Error('The running local database has invalid process information.')
    }
    await assertOwnPostgres(paths, { ...config, databasePort: runningPort })
    await stopPostgres(paths, config)
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!(await portIsFree(config.databasePort)) || config.databasePort === config.backendPort) {
      config.databasePort = await choosePort()
      await writeConfig(paths, config)
    }
    await configurePostgres(paths, config.databasePort)
    const logFd = fsSync.openSync(path.join(paths.logs, 'postgres.log'), 'a')
    let child
    let launchError = null
    try {
      child = spawn(postgresTool(paths, 'postgres'), ['-D', paths.data], hiddenProcessOptions({
        cwd: paths.root, env: childEnvironment(),
        stdio: ['ignore', logFd, logFd],
      }))
      child.once('error', (error) => { launchError = error })
    } finally {
      fsSync.closeSync(logFd)
    }
    for (let check = 0; check < 120; check += 1) {
      if (launchError || !childIsRunning(child)) break
      try {
        await assertOwnPostgres(paths, config)
        return child
      } catch { /* Wait for database readiness or a port collision. */ }
      await pause(250)
    }
    if (childIsRunning(child)) await stopPostgres(paths, config, child)
    config.databasePort = await choosePort()
    await writeConfig(paths, config)
  }
  throw new Error('The local database did not start.')
}

async function ensureDatabase(paths, config) {
  const exists = await psql(paths, config, 'postgres',
    `SELECT 1 FROM pg_database WHERE datname = '${databaseName}'`)
  if (exists === '1') return
  await run(postgresTool(paths, 'createdb'), [
    '-h', '127.0.0.1', '-p', String(config.databasePort),
    '-U', databaseUser, '-O', databaseUser, databaseName,
  ], { env: databaseEnvironment(config) })
}

function backendEnvironment(config, buildId, extra = {}) {
  const databaseUrl = new URL(`postgresql://127.0.0.1:${config.databasePort}/${databaseName}`)
  databaseUrl.username = databaseUser
  databaseUrl.password = config.databasePassword
  return {
    ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'trial', TRIAL_OFFLINE: '1',
    HOST: '127.0.0.1', PORT: String(config.backendPort),
    DATABASE_URL: databaseUrl.toString(), ELECTRON_ORIGIN: 'app://renderer',
    CLIENT_ORIGIN: 'http://127.0.0.1:1', TIMEZONE: 'Asia/Hebron',
    TRIAL_RUNTIME_TOKEN: config.runtimeToken, TRIAL_BUILD_ID: buildId,
    ...extra,
  }
}

async function runServerScript(paths, config, buildId, relative, extra = {}) {
  await run(paths.nodeExecutable, [path.join(paths.server, relative)], {
    cwd: paths.root, env: backendEnvironment(config, buildId, extra), timeout: 180_000,
  })
}

async function computeBuildId(paths) {
  const hash = createHash('sha256')
  async function addDirectory(directory) {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await addDirectory(full)
      else if (entry.isFile()) {
        hash.update(path.relative(paths.server, full))
        hash.update(await fs.readFile(full))
      }
    }
  }
  await addDirectory(path.join(paths.server, 'src'))
  await addDirectory(path.join(paths.server, 'db', 'migrations'))
  return hash.digest('hex')
}

function request(port, token, method, endpoint) {
  return new Promise((resolve) => {
    const outgoing = http.request({
      hostname: '127.0.0.1', port, path: endpoint, method,
      headers: { 'X-Trial-Runtime-Token': token }, timeout: 1500,
    }, (incoming) => {
      let body = ''
      incoming.on('data', (chunk) => { if (body.length < 4096) body += chunk })
      incoming.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(body) } catch { /* Empty responses are expected. */ }
        resolve({ status: incoming.statusCode, body: parsed })
      })
    })
    outgoing.on('timeout', () => outgoing.destroy())
    outgoing.on('error', () => resolve(null))
    outgoing.end()
  })
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function startBackend(paths, config, buildId) {
  let existing = await request(config.backendPort, config.runtimeToken, 'GET',
    '/api/health/trial-runtime')
  if (existing?.status === 200) {
    await stopBackend(paths, config)
  } else if (!(await portIsFree(config.backendPort))) {
    config.backendPort = await choosePort()
    await writeConfig(paths, config)
  }
  const logFd = fsSync.openSync(path.join(paths.logs, 'backend.log'), 'a')
  let child
  try {
    child = spawn(paths.nodeExecutable, [path.join(paths.server, 'src', 'index.js')], hiddenProcessOptions({
      cwd: paths.root,
      env: childEnvironment(backendEnvironment(config, buildId)),
      stdio: ['ignore', logFd, logFd],
    }))
  } finally {
    fsSync.closeSync(logFd)
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    existing = await request(config.backendPort, config.runtimeToken, 'GET',
      '/api/health/trial-runtime')
    if (existing?.status === 200 && existing.body?.buildId === buildId) {
      const ready = await request(config.backendPort, config.runtimeToken, 'GET',
        '/api/health/readiness')
      if (ready?.status === 200) return child
    }
    if (!childIsRunning(child)) break
    await pause(250)
  }
  await stopBackend(paths, config, child)
  throw new Error('The local service did not become ready.')
}

async function ensureAdmin(paths, config, buildId) {
  const marker = path.join(paths.config, 'trial-admin-v1')
  const exists = await psql(paths, config, databaseName,
    "SELECT 1 FROM users WHERE username = 'admin' AND role = 'admin' AND is_active = TRUE LIMIT 1")
  let provisioned = false
  try {
    await fs.access(marker)
    provisioned = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!provisioned || exists !== '1') {
    await runServerScript(paths, config, buildId, 'src/db/provision-admin.js', {
      ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin',
    })
    await fs.writeFile(marker, '1\n', { encoding: 'utf8', mode: 0o600 })
  }
  await fs.rm(path.join(paths.config, 'first-run-secret.bin'), { force: true })
}

async function prepareTrial(app) {
  const paths = runtimePaths(app)
  if (!app.isPackaged) {
    await require('../scripts/materialize-postgres.cjs').ensurePostgresRuntime()
  }
  for (const directory of [paths.root, paths.config, paths.backups, paths.logs]) {
    await fs.mkdir(directory, { recursive: true })
  }
  await assertBundle(paths)
  const config = await readOrCreateConfig(paths)
  const trial = { paths, config, backendChild: null, postgresChild: null }
  try {
    const firstRun = await initializeData(paths, config)
    await stopBackend(paths, config)
    trial.postgresChild = await startPostgres(paths, config)
    await ensureDatabase(paths, config)
    const buildId = await computeBuildId(paths)
    await runServerScript(paths, config, buildId, 'src/db/migrate.js')
    await ensureAdmin(paths, config, buildId)
    await runServerScript(paths, config, buildId, 'src/db/verify-schema.js')
    trial.backendChild = await startBackend(paths, config, buildId)
    return { ...trial, backendPort: config.backendPort, firstRun }
  } catch (error) {
    await stopTrial(trial).catch(() => {})
    throw error
  }
}

module.exports = {
  assertConfig, backendEnvironment, choosePort, hiddenProcessOptions, localDataRoot,
  prepareTrial, runtimePaths, stopTrial, writeConfig,
}
