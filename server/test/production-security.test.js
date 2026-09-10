import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const envModuleUrl = new URL('../src/config/env.js', import.meta.url).href
const serverEntryUrl = new URL('../src/index.js', import.meta.url).href
const baseEnvironment = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://application@database.example.com:5432/application',
  CLIENT_ORIGIN: 'https://app.example.com',
  ELECTRON_ORIGIN: 'app://renderer',
  HOST: '0.0.0.0',
  TRUST_PROXY: 'loopback',
  PROXY_CLIENT_IP_HEADER: 'x-real-ip',
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
  VAPID_SUBJECT: '',
}

function importEnvironment(overrides = {}) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import(${JSON.stringify(envModuleUrl)}).then(({ env }) => process.stdout.write(JSON.stringify(env)))`,
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
      env: { ...baseEnvironment, ...overrides },
    },
  )
}

test('production rejects wildcard and non-origin CORS configuration', () => {
  for (const clientOrigin of ['*', 'null', 'https://app.example.com/path']) {
    const result = importEnvironment({ CLIENT_ORIGIN: clientOrigin })

    assert.notEqual(result.status, 0, clientOrigin)
    assert.match(result.stderr, /CLIENT_ORIGIN/)
  }
})

test('production rejects cleartext non-loopback browser origins', () => {
  const result = importEnvironment({ CLIENT_ORIGIN: 'http://app.example.com' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CLIENT_ORIGIN must use HTTPS in production/)
})

test('production accepts an exact HTTPS origin', () => {
  const result = importEnvironment()

  assert.equal(result.status, 0, result.stderr)
  const configuration = JSON.parse(result.stdout)
  assert.equal(configuration.clientOrigin, 'https://app.example.com')
  assert.equal(configuration.electronOrigin, 'app://renderer')
  assert.equal(configuration.host, '0.0.0.0')
  assert.deepEqual(configuration.trustedProxyRanges, ['loopback'])
  assert.equal(configuration.proxyClientIpHeader, 'x-real-ip')
  assert.deepEqual(configuration.databaseTls, { rejectUnauthorized: true })
})

test('production requires an explicit valid listen host', () => {
  for (const host of ['', 'localhost', 'not a host']) {
    const result = importEnvironment({ HOST: host })
    assert.notEqual(result.status, 0, `unexpectedly accepted HOST=${host}`)
    assert.match(result.stderr, /HOST/)
  }

  const loopback = importEnvironment({ HOST: '127.0.0.1' })
  assert.equal(loopback.status, 0, loopback.stderr)
})

test('production database TLS cannot be disabled or replaced by URL parameters', () => {
  for (const query of [
    'ssl=0',
    'sslmode=disable',
    'sslmode=require',
    'sslrootcert=attacker.crt',
  ]) {
    const result = importEnvironment({
      DATABASE_URL: `postgresql://application@database.example.com:5432/application?${query}`,
    })

    assert.notEqual(result.status, 0, query)
    assert.match(result.stderr, /must not contain SSL parameters/)
  }
})

test('production accepts only bounded PEM database trust roots', () => {
  const accepted = importEnvironment({
    DATABASE_TLS_CA: '-----BEGIN CERTIFICATE-----\\nQA-only-placeholder\\n-----END CERTIFICATE-----',
  })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(JSON.parse(accepted.stdout).databaseTls.rejectUnauthorized, true)

  const rejected = importEnvironment({ DATABASE_TLS_CA: 'not-a-certificate' })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /DATABASE_TLS_CA/)
})

test('production proxy trust rejects broad or ambiguous configurations', () => {
  for (const trustProxy of ['true', '1', '*', '10.0.0.0/99']) {
    const result = importEnvironment({ TRUST_PROXY: trustProxy })

    assert.notEqual(result.status, 0, trustProxy)
    assert.match(result.stderr, /TRUST_PROXY/)
  }

  const missing = importEnvironment({ TRUST_PROXY: '' })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /TRUST_PROXY/)
})

test('local disposable PostgreSQL remains plaintext-capable outside production', () => {
  const result = importEnvironment({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres@127.0.0.1:55443/disposable_qa',
    TRUST_PROXY: '',
    PROXY_CLIENT_IP_HEADER: 'x-forwarded-for',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).databaseTls, false)
})

test('the privileged Electron CORS origin cannot be redirected by configuration', () => {
  const result = importEnvironment({ ELECTRON_ORIGIN: 'https://attacker.example.com' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ELECTRON_ORIGIN/)
})

test('the server entry point refuses an implicit development environment', () => {
  const cleanDirectory = mkdtempSync(path.join(os.tmpdir(), 'production-config-test-'))
  const childEnvironment = { ...process.env }
  delete childEnvironment.NODE_ENV
  delete childEnvironment.DATABASE_URL

  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `import(${JSON.stringify(serverEntryUrl)})`],
      { cwd: cleanDirectory, encoding: 'utf8', env: childEnvironment },
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /NODE_ENV must be set explicitly/)
  } finally {
    rmSync(cleanDirectory, { recursive: true, force: true })
  }
})

test('the production client build explicitly disables source maps', () => {
  const viteConfiguration = readFileSync(
    new URL('../../client/vite.config.ts', import.meta.url),
    'utf8',
  )

  assert.match(viteConfiguration, /build:\s*\{\s*sourcemap:\s*false/)
})
