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
