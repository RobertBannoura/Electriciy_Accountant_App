import { currentBusinessDate } from '../checks/check-reminders.js'

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function parseStatementRange(query, today = currentBusinessDate()) {
  const from = query?.from ?? `${today.slice(0, 4)}-01-01`
  const to = query?.to ?? today
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    return { error: 'فترة كشف الحساب غير صالحة' }
  }
  if (from > to) {
    return { error: 'بداية كشف الحساب يجب ألا تكون بعد نهايته' }
  }
  const rangeDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  if (rangeDays > 366) {
    return { error: 'فترة كشف الحساب الواحدة يجب ألا تتجاوز سنة' }
  }
  return { value: { from, to } }
}
