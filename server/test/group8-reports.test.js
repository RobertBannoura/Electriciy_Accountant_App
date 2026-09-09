import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseReportFilters } from '../src/reports/report-input.js'

test('report filters accept valid ranges and optional bigint store identity', () => {
  assert.deepEqual(
    parseReportFilters({ from: '2026-09-01', to: '2026-09-09', storeId: '9223372036854775807' }, '2026-09-09'),
    { value: { from: '2026-09-01', to: '2026-09-09', storeId: '9223372036854775807' } },
  )
  assert.deepEqual(
    parseReportFilters({}, '2026-09-09'),
    { value: { from: '2026-09-01', to: '2026-09-09', storeId: null } },
  )
})

test('report filters reject impossible dates, reversed ranges, and unsafe stores', () => {
  assert.match(parseReportFilters({ from: '2026-02-30', to: '2026-03-01' }).error, /فترة/)
  assert.match(parseReportFilters({ from: '2026-09-10', to: '2026-09-09' }).error, /بداية/)
  assert.match(parseReportFilters({ from: '2026-09-01', to: '2026-09-09', storeId: '1 OR 1=1' }).error, /متجر/)
})

test('simple reports use immutable sale cost snapshots and subtract explicit returns', async () => {
  const route = await readFile(new URL('../src/routes/reports.js', import.meta.url), 'utf8')
  assert.match(route, /SUM\(cost_total\)/)
  assert.match(route, /sold\.cost - sale_returns\.cost/)
  assert.match(route, /customer_returns/)
  assert.match(route, /supplier_returns/)
  assert.match(route, /AT TIME ZONE 'Asia\/Hebron'/)
  assert.match(route, /store_inventory_cost_balances/)
  assert.match(route, /GREATEST\(balance, 0::NUMERIC\)/)
  assert.doesNotMatch(route, /current_purchase_price/)
})

test('reports page stays compact and home keeps eight actions ahead of summaries', async () => {
  const [page, home, app] = await Promise.all([
    readFile(new URL('../../client/src/pages/ReportsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/HomePage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/App.tsx', import.meta.url), 'utf8'),
  ])
  for (const label of ['المبيعات', 'المشتريات', 'الأرباح', 'المصاريف', 'ديون العملاء', 'ديون الموردين', 'المخزون', 'حركة الأموال', 'الشيكات', 'مقارنة المحلين']) {
    assert.match(page, new RegExp(label))
  }
  for (const label of ['اليوم', 'هذا الأسبوع', 'هذا الشهر', 'فترة مخصصة', 'الكل']) {
    assert.match(page, new RegExp(label))
  }
  for (const label of ['تكلفة البضاعة', 'الربح الإجمالي', 'صافي الربح']) {
    assert.match(page, new RegExp(label))
  }
  assert.match(page, /لقطة التكلفة المحفوظة وقت البيع/)
  assert.ok(home.indexOf('{homeActions.map') < home.indexOf('id="home-summary-title"'))
  assert.match(home, /مبيعات اليوم/)
  assert.match(home, /الصندوق والبنك/)
  assert.match(home, /المخزون المنخفض/)
  assert.match(app, /<ReportsPage stores={stores}/)
})
