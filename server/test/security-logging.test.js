import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  logSecurityEvent,
  safeErrorDetails,
  securityFingerprint,
} from '../src/security/security-log.js'
import { notifyAdminAfterCommit } from '../src/notifications/push-service.js'

const runFile = promisify(execFile)

test('security logs retain useful metadata and reject secret-bearing fields', () => {
  const captured = []
  const originalWarn = console.warn
  const sentinels = {
    password: 'password-sentinel-value',
    authorizationHeader: 'Bearer authorization-sentinel-value',
    cookie: 'session=cookie-sentinel-value',
    token: 'token-sentinel-value',
    payload: 'payload-sentinel-value',
    databaseUrl: 'postgresql://database-sentinel-value',
    privateKey: 'private-key-sentinel-value',
  }

  console.warn = (...values) => captured.push(values)
  try {
    logSecurityEvent('warn', 'login_failed', {
      ...sentinels,
      identifierHash: securityFingerprint('ADMIN'),
      ip: '127.0.0.1\nforged=true',
      outcome: 'failure',
      reason: 'invalid_credentials',
      statusCode: 401,
      unexpectedField: 'unexpected-sentinel-value',
    })
  } finally {
    console.warn = originalWarn
  }

  const serialized = JSON.stringify(captured)
  assert.match(serialized, /login_failed/)
  assert.match(serialized, /invalid_credentials/)
  assert.match(serialized, /127\.0\.0\.1forged=true/)
  assert.doesNotMatch(serialized, /unexpected-sentinel-value/)
  for (const value of Object.values(sentinels)) assert.equal(serialized.includes(value), false)
})

test('safe error metadata never includes an exception message or attached secret data', () => {
  const error = Object.assign(new Error('password=exception-message-sentinel'), {
    code: 'CONNECTION_FAILED',
    connectionString: 'postgresql://exception-property-sentinel',
  })

  assert.deepEqual(safeErrorDetails(error), {
    errorCode: 'CONNECTION_FAILED',
    errorName: 'Error',
  })
  assert.deepEqual(safeErrorDetails(Object.assign(new Error('ignored'), {
    code: 'token=error-code-sentinel',
    name: 'Error\npassword=error-name-sentinel',
  })), {
    errorCode: 'UNEXPECTED_ERROR',
    errorName: 'Error',
  })
})

test('push failure logging excludes provider exception messages and endpoints', async () => {
  const logs = []
  const secretMessage = 'endpoint=https://push.example.test/private-token'
  const result = await notifyAdminAfterCommit({
    category: 'sale_created',
    sourceType: 'sale',
    sourceId: '9',
    businessDate: '2026-09-10',
    title: 'test',
    body: 'test',
  }, {
    configured: true,
    dbQuery: async () => { throw Object.assign(new Error(secretMessage), { code: 'PROVIDER_FAILURE' }) },
    logger: { error: (...values) => logs.push(values), warn: () => {} },
  })

  const serialized = JSON.stringify(logs)
  assert.deepEqual(result, { skipped: 'failed', successes: 0, failures: 1 })
  assert.match(serialized, /PROVIDER_FAILURE/)
  assert.equal(serialized.includes(secretMessage), false)
})

test('VAPID generation writes a new ignored file without printing the private key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vapid-security-test-'))
  const outputPath = path.join(directory, 'generated-vapid.env')

  try {
    const { stdout, stderr } = await runFile(
      process.execPath,
      [fileURLToPath(new URL('../src/notifications/generate-vapid-keys.js', import.meta.url))],
      { env: { ...process.env, VAPID_OUTPUT_FILE: outputPath }, windowsHide: true },
    )
    const generated = await readFile(outputPath, 'utf8')
    const privateKey = generated.match(/^VAPID_PRIVATE_KEY=(.+)$/m)?.[1]

    assert.ok(privateKey)
    assert.match(generated, /^VAPID_PUBLIC_KEY=.+$/m)
    assert.match(stdout, /private key was not printed/i)
    assert.equal(stdout.includes(privateKey), false)
    assert.equal(stderr.includes(privateKey), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
