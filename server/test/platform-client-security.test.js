import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { backupTables } from '../src/backups/backup-service.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('Electron IPC documentation covers every registered channel', async () => {
  const [main, preload, documentation] = await Promise.all([
    read('electron/main.cjs'),
    read('electron/preload.cjs'),
    read('docs/ELECTRON_IPC_SECURITY.md'),
  ])
  const handled = [...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((match) => match[1]).sort()
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]).sort()
  assert.deepEqual(invoked, handled)
  for (const channel of handled) {
    assert.ok(documentation.includes(`| \`${channel}\` |`), `missing IPC documentation for ${channel}`)
  }
})

test('backup allowlist excludes authentication, sessions, subscriptions, secrets, and replay metadata', () => {
  const tables = new Set(backupTables.map(({ table }) => table))
  for (const excluded of [
    'users',
    'user_sessions',
    'push_subscriptions',
    'financial_operation_requests',
    'schema_migrations',
  ]) {
    assert.equal(tables.has(excluded), false, `${excluded} must not be backed up`)
  }
})

test('renderer and Electron production sources contain no backend private configuration', async () => {
  const files = await Promise.all([
    collectTextFiles('client/src'),
    collectTextFiles('client/public'),
    collectTextFiles('electron', new Set(['test'])),
  ])
  const source = files.flat().join('\n')
  assert.doesNotMatch(source, /VAPID_PRIVATE_KEY|vapidPrivateKey|DATABASE_URL|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/)
  assert.doesNotMatch(source, /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/i)
})

test('PDF factories render untrusted values as text without URL or local-file primitives', async () => {
  const pdf = await read('client/src/pdf-documents.tsx')
  assert.match(pdf, /<Text/)
  assert.doesNotMatch(pdf, /dangerouslySetInnerHTML|<Image|<Link|<Canvas|file:\/\/|https?:\/\//i)
  assert.match(pdf, /Amiri-Regular\.ttf\?url/)
})

test('all API responses are no-store and PWA storage has no financial offline database', async () => {
  const [app, api, worker, store, home] = await Promise.all([
    read('server/src/app.js'),
    read('client/src/api.ts'),
    read('client/public/sw.js'),
    read('client/src/browser-active-store.ts'),
    read('client/src/pages/HomePage.tsx'),
  ])
  assert.match(app, /app\.use\('\/api'[^]*Cache-Control', 'no-store'/)
  assert.match(worker, /request\.method !== 'GET'/)
  assert.match(worker, /request\.headers\.has\('Authorization'\)/)
  assert.doesNotMatch(`${api}\n${worker}\n${store}\n${home}`, /indexedDB|sync\.register|addEventListener\(['"]sync['"]/i)
  assert.match(api, /sessionStorage\.setItem\(sessionTokenKey, token\)/)
  assert.match(api, /localStorage\.setItem\(rememberedSessionTokenKey/)
  assert.match(api, /localStorage\.removeItem\(rememberedSessionTokenKey\)/)
  assert.doesNotMatch(api, /localStorage\.setItem\(sessionTokenKey/)
})

async function read(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8')
}

async function collectTextFiles(relativeDirectory, excludedNames = new Set()) {
  const directory = path.join(repositoryRoot, relativeDirectory)
  const entries = await readdir(directory, { withFileTypes: true })
  const results = []
  for (const entry of entries) {
    if (excludedNames.has(entry.name)) continue
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      results.push(...await collectTextFiles(path.relative(repositoryRoot, fullPath), excludedNames))
    } else if (/\.(?:cjs|js|json|ts|tsx|webmanifest)$/.test(entry.name)) {
      results.push(await readFile(fullPath, 'utf8'))
    }
  }
  return results
}
