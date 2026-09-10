import { currentBusinessDate } from '../checks/check-reminders.js'
import { parseStoreId } from '../stores/store-input.js'

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function parseReportFilters(query, today = currentBusinessDate()) {
  const from = query?.from ?? `${today.slice(0, 7)}-01`
  const to = query?.to ?? today
  const storeId = query?.storeId === undefined || query.storeId === ''
    ? null
    : parseStoreId(query.storeId)

  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    return { error: 'فترة التقرير غير صالحة' }
  }
  if (from > to) {
    return { error: 'بداية فترة التقرير يجب ألا تكون بعد نهايتها' }
  }
  const rangeDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  if (rangeDays > 366) {
    return { error: 'فترة التقرير الواحدة يجب ألا تتجاوز سنة' }
  }
  if (query?.storeId !== undefined && query.storeId !== '' && !storeId) {
    return { error: 'متجر التقرير غير صالح' }
  }

  return { value: { from, to, storeId } }
}
