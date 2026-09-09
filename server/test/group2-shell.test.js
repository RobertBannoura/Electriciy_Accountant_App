import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const clientUrl = (path) => new URL(`../../client/${path}`, import.meta.url)
const electronUrl = (path) => new URL(`../../electron/${path}`, import.meta.url)

test('Arabic shell declares Arabic language and RTL direction', async () => {
  const html = await readFile(clientUrl('index.html'), 'utf8')
  const css = await readFile(clientUrl('src/styles.css'), 'utf8')

  assert.match(html, /<html lang="ar" dir="rtl">/)
  assert.match(css, /html\s*{[^}]*direction:\s*rtl/s)
  assert.match(css, /body\s*{[^}]*min-width:\s*320px/s)
})

test('home screen has exactly the eight required main actions in order', async () => {
  const source = await readFile(clientUrl('src/pages/HomePage.tsx'), 'utf8')
  const actionsBlock = source.match(/const homeActions = \[([\s\S]*?)\n\]/)?.[1]
  const labels = [...actionsBlock.matchAll(/label: '([^']+)'/g)].map((match) => match[1])
  const paths = [...actionsBlock.matchAll(/path: '([^']+)'/g)].map((match) => match[1])

  assert.deepEqual(labels, [
    'بيع جديد',
    'الأصناف',
    'العملاء',
    'الموردون',
    'المشتريات',
    'الشيكات',
    'المصاريف',
    'التقارير',
  ])
  assert.deepEqual(paths, [
    '/sale',
    '/products',
    '/customers',
    '/suppliers',
    '/purchases',
    '/checks',
    '/expenses',
    '/reports',
  ])
  assert.doesNotMatch(actionsBlock, /settings/)
})

test('all shell routes exist and products uses the implemented Group 3 page', async () => {
  const source = await readFile(clientUrl('src/App.tsx'), 'utf8')

  for (const path of [
    'sale',
    'products',
    'customers',
    'suppliers',
    'purchases',
    'checks',
    'expenses',
    'reports',
    'settings',
  ]) {
    assert.match(source, new RegExp(`path="${path}"`), path)
  }

  assert.match(source, /import \{ ProductsPage \}/)
  assert.match(source, /<ProductsPage/)
  assert.match(source, /defaultStoreId={configuredStoreId}/)
  assert.match(source, /stores={stores}/)
})

test('settings and Electron store status remain small conditional header actions', async () => {
  const shell = await readFile(clientUrl('src/components/AppShell.tsx'), 'utf8')
  const settings = await readFile(clientUrl('src/pages/SettingsPage.tsx'), 'utf8')

  assert.match(shell, /to="\/settings"/)
  assert.match(shell, /window\.desktop &&/)
  assert.match(shell, /المتجر الحالي:/)
  assert.match(settings, /هذا الجهاز تابع إلى:/)
  assert.match(settings, /window\.desktop &&/)
})

test('future Electron store requests attach validated local context', async () => {
  const api = await readFile(clientUrl('src/api.ts'), 'utf8')
  const preload = await readFile(electronUrl('preload.cjs'), 'utf8')
  const main = await readFile(electronUrl('main.cjs'), 'utf8')

  assert.match(api, /window\.desktop\.getStoreAssignment\(\)/)
  assert.match(api, /headers\.set\('X-Store-Id', storeId\)/)
  assert.match(api, /سياق متجر الجهاز متاح في تطبيق سطح المكتب فقط/)
  assert.match(preload, /contextBridge\.exposeInMainWorld\('desktop'/)
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /assertTrustedIpcSender/)
})
