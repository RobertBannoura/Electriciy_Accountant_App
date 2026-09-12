const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  assertSafePdfData,
  assertSafeSelectedFile,
  desktopCheckNotification,
  safeSuggestedName,
} = require('../platform-security.cjs')

const mainProcessPath = path.join(__dirname, '..', 'main.cjs')

test('packaged builds cannot be switched into developer renderer mode', async () => {
  const source = await fs.readFile(mainProcessPath, 'utf8')

  assert.match(
    source,
    /const isDevelopment = !app\.isPackaged && process\.argv\.includes\('--dev'\)/,
  )
})

test('the client-facing Electron window removes the default English application menu', async () => {
  const source = await fs.readFile(mainProcessPath, 'utf8')

  assert.match(source, /Menu\.setApplicationMenu\(null\)/)
})

test('renderer-created windows are denied without forwarding arbitrary URLs to the OS', async () => {
  const source = await fs.readFile(mainProcessPath, 'utf8')

  assert.match(
    source,
    /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/,
  )
  assert.doesNotMatch(source, /shell\.openExternal/)
})

test('Electron operational errors do not write full exception objects or messages', async () => {
  const sources = await Promise.all([
    'launch.cjs',
    'main.cjs',
    'package-windows.cjs',
  ].map((fileName) => fs.readFile(path.join(__dirname, '..', fileName), 'utf8')))
  const combined = sources.join('\n')

  assert.doesNotMatch(combined, /console\.error\([^\n]*,\s*error\)/)
  assert.doesNotMatch(combined, /console\.error\([^\n]*error\.message/)
})

test('custom-protocol paths are resolved inside the packaged renderer root', async () => {
  const source = await fs.readFile(mainProcessPath, 'utf8')

  assert.match(source, /const filePath = path\.resolve\(rendererRoot, relativePath\)/)
  assert.match(source, /filePath\.startsWith\(`\$\{rendererRoot\}\$\{path\.sep\}`\)/)
  assert.match(source, /return new Response\('Not found', \{ status: 404 \}\)/)
})

test('PDF output is size- and signature-bounded and filenames are sanitized before save dialogs', async () => {
  const [source, security] = await Promise.all([
    fs.readFile(mainProcessPath, 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'platform-security.cjs'), 'utf8'),
  ])

  assert.match(security, /data\.length > maxPdfBytes/)
  assert.match(security, /toString\('ascii'\) !== '%PDF-'/)
  assert.equal(safeSuggestedName('../hostile?.pdf'), '..-hostile-.pdf')
  assert.match(source, /filters: \[\{ name: 'PDF', extensions: \['pdf'\] \}\]/)
  assert.match(source, /assertSafeSelectedFile\(selection\.filePath, '\.pdf'\)/)
})

test('hostile active PDF actions and malformed PDF IPC data are rejected', () => {
  assert.throws(() => assertSafePdfData(Buffer.from('not a pdf')), TypeError)
  assert.throws(
    () => assertSafePdfData(Buffer.from('%PDF-1.7\n1 0 obj <</OpenAction 2 0 R>>\n')),
    /إجراءات|تفاعلية/,
  )
  assert.throws(
    () => assertSafePdfData(Buffer.from('%PDF-1.7\n1 0 obj <</#4AavaScript 2 0 R>>\n')),
    /إجراءات|تفاعلية/,
  )
  assert.equal(assertSafePdfData(Buffer.from('%PDF-1.7\n1 0 obj <<>>\n')).length > 0, true)
})

test('PDF save targets require an absolute PDF path and reject symbolic-link targets', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-save-security-'))
  try {
    const safePath = path.join(directory, 'invoice.pdf')
    assert.equal(await assertSafeSelectedFile(safePath, '.pdf'), safePath)
    await assert.rejects(assertSafeSelectedFile(path.join(directory, 'invoice.html'), '.pdf'), TypeError)
    await assert.rejects(assertSafeSelectedFile('..\\invoice.pdf', '.pdf'), TypeError)
    await assert.rejects(
      assertSafeSelectedFile(safePath, '.pdf', {
        fsApi: {
          stat: async () => ({ isDirectory: () => true }),
          lstat: async () => ({ isSymbolicLink: () => true, isFile: () => true }),
        },
      }),
      /رابط|مسار/,
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('desktop notification IPC accepts only generic check counts', () => {
  assert.deepEqual(desktopCheckNotification({ kind: 'checks_due', count: 2 }), {
    title: 'شيكات مستحقة اليوم',
    body: 'يوجد 2 شيك مستحق. افتح التطبيق لعرض التفاصيل.',
  })
  assert.throws(
    () => desktopCheckNotification({ kind: 'checks_due', count: 1, body: 'عميل — ₪500 — 123' }),
    TypeError,
  )
  assert.throws(() => desktopCheckNotification({ kind: 'arbitrary', count: 1 }), TypeError)
})

test('redirects, webviews, permission checks, and device permissions are denied', async () => {
  const source = await fs.readFile(mainProcessPath, 'utf8')
  assert.match(source, /setPermissionRequestHandler/)
  assert.match(source, /setPermissionCheckHandler\(\(\) => false\)/)
  assert.match(source, /setDevicePermissionHandler\(\(\) => false\)/)
  assert.match(source, /on\('will-attach-webview'/)
  assert.match(source, /on\('will-redirect'/)
})

test('backup import is restricted to one native-selected JSON file', async () => {
  const source = await fs.readFile(mainProcessPath, 'utf8')

  assert.match(source, /filters: \[\{ name: '[^']+', extensions: \['json'\] \}\]/)
  assert.match(source, /properties: \['openFile'\]/)
  assert.match(source, /selection\.filePaths\.length !== 1/)
  assert.doesNotMatch(source, /backup:select-file[^]*options\?\.filePath/)
})

test('preload exposes only the declared narrow IPC methods and no generic channel', async () => {
  const [main, preload] = await Promise.all([
    fs.readFile(mainProcessPath, 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.cjs'), 'utf8'),
  ])
  const expected = [
    'app:get-versions',
    'device:get-store-assignment',
    'device:set-store-assignment',
    'backup:get-status',
    'backup:choose-directory',
    'backup:save',
    'backup:select-file',
    'app:show-notification',
    'app:save-pdf',
    'app:save-pdf-data',
  ]
  const handled = [...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((match) => match[1]).sort()
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]).sort()
  assert.deepEqual(handled, [...expected].sort())
  assert.deepEqual(invoked, [...expected].sort())
  assert.equal((main.match(/\n {4}assertTrustedIpcSender\(event\)/g) ?? []).length, expected.length)
  assert.doesNotMatch(preload, /ipcRenderer\.(?:send|on|sendSync)|exposeInMainWorld\([^]*ipcRenderer/)
  assert.doesNotMatch(`${main}\n${preload}`, /invoke-channel|generic-ipc|shell-command|execute-command/i)
})

test('the packaged application includes the platform security boundary module', async () => {
  const packager = await fs.readFile(path.join(__dirname, '..', 'package-windows.cjs'), 'utf8')
  assert.match(packager, /'platform-security\.cjs'/)
})
