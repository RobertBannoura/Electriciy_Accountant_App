import Decimal from 'decimal.js'
import { isHalfShekelAmount, normalizeDecimal, normalizeOptionalText } from '../products/product-input.js'

export const DEFAULT_EXPENSE_CATEGORIES = Object.freeze([
  'كهرباء', 'أجار', 'رواتب', 'مواصلات', 'صيانة', 'مشتريات للمحل', 'أخرى',
])

const ExpenseDecimal = Decimal.clone({ precision: 100 })

export function parseExpenseInput(body) {
  const amount = normalizeDecimal(body?.amount, { scale: 2 })
  const category = DEFAULT_EXPENSE_CATEGORIES.includes(body?.category) ? body.category : null
  const expenseDate = body?.date ?? body?.expenseDate
  const paymentMethod = body?.paymentMethod === 'bank' ? 'bank_card' : body?.paymentMethod
  const notes = normalizeOptionalText(body?.notes, 1000)
  if (amount === undefined || !new ExpenseDecimal(amount).greaterThan(0) || !isHalfShekelAmount(amount)) {
    return { error: 'المبلغ يجب أن يكون أكبر من صفر وبمضاعفات نصف شيكل' }
  }
  if (!category) return { error: 'يجب اختيار تصنيف مصروف صالح' }
  if (!isValidDate(expenseDate)) return { error: 'تاريخ المصروف غير صالح' }
  if (!['cash', 'bank_card'].includes(paymentMethod)) {
    return { error: 'طريقة دفع المصروف يجب أن تكون نقداً أو بنكاً' }
  }
  if (body?.notes != null && body.notes !== '' && notes === null) {
    return { error: 'ملاحظات المصروف تتجاوز 1000 حرف' }
  }
  return { value: { amount, category, expenseDate, paymentMethod, notes } }
}

function isValidDate(value) {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
}
