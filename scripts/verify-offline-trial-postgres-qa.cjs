const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs/promises')
const net = require('node:net')
const path = require('node:path')
const { Client } = require('pg')
const { prepareTrial } = require('../electron/trial-runtime.cjs')

const root = path.resolve(__dirname, '..')
const qaRoot = path.join(root, 'tmp', 'qa')
const localAppData = path.join(qaRoot, 'group10-localappdata')
const dataRoot = path.join(localAppData, 'ElectricityAccountantTrial')
const packageRoot = path.join(root, 'release', 'ElectricityAccountant-win32-x64')

function chooseHighPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port
      listener.close((error) => error ? reject(error) : resolve(port >= 55000 ? port : chooseHighPort()))
    })
  })
}

function testEnvironment(extra = {}) {
  const env = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return { ...env, NODE_ENV: 'test', TRIAL_OFFLINE: '0', HOST: '127.0.0.1',
    CLIENT_ORIGIN: 'http://localhost:5173', ...extra }
}

async function run(file, args, env, logName, timeout = 240_000) {
  const log = await fs.open(path.join(qaRoot, logName), 'w')
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: qaRoot, env: testEnvironment(env), windowsHide: true,
      stdio: ['ignore', log.fd, log.fd],
    })
    const timer = setTimeout(() => child.kill(), timeout)
    child.once('error', async (error) => { clearTimeout(timer); await log.close(); reject(error) })
    child.once('exit', async (code) => {
      clearTimeout(timer)
      await log.close()
      code === 0 ? resolve() : reject(new Error(`${logName} failed with exit ${code}`))
    })
  })
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  assert.equal(path.dirname(localAppData), qaRoot)
  await fs.rm(localAppData, { recursive: true, force: true })
  await fs.mkdir(path.join(dataRoot, 'config'), { recursive: true })
  process.env.LOCALAPPDATA = localAppData
  process.resourcesPath = path.join(packageRoot, 'resources')
  const databasePort = await chooseHighPort()
  let backendPort = await chooseHighPort()
  while (backendPort === databasePort) backendPort = await chooseHighPort()
  await fs.writeFile(path.join(dataRoot, 'config', 'runtime.json'), JSON.stringify({
    version: 1, databasePassword: randomBytes(32).toString('hex'),
    runtimeToken: randomBytes(32).toString('hex'), databasePort, backendPort,
  }))
  const app = { isPackaged: true,
    trialNodeExecutable: path.join(packageRoot, 'ElectricityAccountant.exe') }
  let config
  try {
    await prepareTrial(app)
    config = JSON.parse(await fs.readFile(path.join(dataRoot, 'config', 'runtime.json'), 'utf8'))
    assert.ok(config.databasePort >= 55000)
    const admin = new Client({ host: '127.0.0.1', port: config.databasePort,
      user: 'trial_owner', password: config.databasePassword, database: 'postgres', ssl: false })
    await admin.connect()
    try {
      await admin.query('CREATE DATABASE group10_financial_qa')
      await admin.query('CREATE DATABASE group10_authz_qa')
    } finally { await admin.end() }
    const url = (name) => `postgresql://trial_owner:${config.databasePassword}@127.0.0.1:${config.databasePort}/${name}`
    const migration = path.join(root, 'server', 'src', 'db', 'migrate.js')
    const verifySchema = path.join(root, 'server', 'src', 'db', 'verify-schema.js')
    const provisionAdmin = path.join(root, 'server', 'src', 'db', 'provision-admin.js')
    for (const name of ['group10_financial_qa', 'group10_authz_qa']) {
      await run(process.execPath, [migration], { DATABASE_URL: url(name) }, `migrate-${name}.log`)
      await run(process.execPath, [provisionAdmin], {
        DATABASE_URL: url(name), ADMIN_USERNAME: 'group10_qa_seed',
        ADMIN_PASSWORD: randomBytes(32).toString('base64url'),
      }, `admin-${name}.log`)
      await run(process.execPath, [verifySchema], { DATABASE_URL: url(name) }, `verify-${name}.log`)
    }
    console.log('Database migrations and schema verification passed on both disposable databases.')
    await run(process.execPath,
      ['--test', path.join(root, 'server', 'security-test', 'group10-financial-security-postgres.integration.js')],
      { GROUP10_FINANCIAL_DATABASE_URL: url('group10_financial_qa') }, 'group10-financial.log')
    console.log('Group 10 financial security suite passed.')
    await run(process.execPath,
      ['--test', path.join(root, 'server', 'test', 'group10-authorization-postgres.integration.test.js')],
      { GROUP10_INTEGRATION_DATABASE_URL: url('group10_authz_qa') }, 'group10-authz.log')
    console.log('Group 10 authorization PostgreSQL suite passed.')
  } finally {
    if (config) {
      await fetch(`http://127.0.0.1:${config.backendPort}/api/health/trial-shutdown`, {
        method: 'POST', headers: { 'X-Trial-Runtime-Token': config.runtimeToken },
      }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 750))
      await run(path.join(packageRoot, 'resources', 'windows-x64', 'bin', 'pg_ctl.exe'),
        ['-D', path.join(dataRoot, 'postgres-data'), '-m', 'fast', 'stop'],
        {}, 'group10-postgres-stop.log', 30_000).catch(() => {})
    }
  }
}

main().catch((error) => {
  console.error('Isolated Group 10 QA failed:', error.message)
  process.exitCode = 1
})
