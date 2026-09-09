import Decimal from 'decimal.js'
import {
  isHalfShekelAmount,
  normalizeDecimal,
  normalizeOptionalText,
  normalizeRequiredText,
  parseId,
} from '../products/product-input.js'

const PaymentDecimal = Decimal.clone({ precision: 100 })
const METHODS = new Set(['cash', 'bank', 'bank_card', 'owner_check', 'transferred_customer_check'])

export function parseSupplierPayments(value, { allowEmpty = false } = {}) {
  if (value == null) return allowEmpty ? { value: [] } : { error: 'أضف طريقة دفع واحدة على الأقل' }
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    return { error: 'أضف طريقة دفع واحدة على الأقل' }
  }
  if (value.length > 50) return { error: 'لا يمكن تسجيل أكثر من 50 طريقة دفع في عملية واحدة' }

  const payments = []
  const transferredCheckIds = new Set()
  for (const row of value) {
    if (!METHODS.has(row?.method)) return { error: 'طريقة دفع المورد غير صالحة' }
    const method = row.method === 'bank_card' ? 'bank' : row.method

    if (method === 'transferred_customer_check') {
      const checkId = parseId(row?.checkId)
      if (!checkId) return { error: 'يجب اختيار شيك عميل صالح للتحويل' }
      if (transferredCheckIds.has(checkId)) return { error: 'لا يمكن تحويل شيك العميل نفسه مرتين' }
      transferredCheckIds.add(checkId)
      payments.push({ method, checkId })
      continue
    }

    const amount = normalizeDecimal(row?.amount, { scale: 2 })
    if (amount === undefined || new PaymentDecimal(amount).lessThanOrEqualTo(0) || !isHalfShekelAmount(amount)) {
      return { error: 'مبلغ الدفعة يجب أن يكون أكبر من صفر وبمضاعفات نصف شيكل' }
    }

    if (method === 'owner_check') {
      const checkNumber = normalizeRequiredText(row?.checkNumber, 100)
      const dueDate = row?.dueDate
      const notes = normalizeOptionalText(row?.notes, 2000)
      if (!checkNumber) return { error: 'رقم شيك المنشأة مطلوب وبحد أقصى 100 حرف' }
      if (!isValidDate(dueDate)) return { error: 'تاريخ استحقاق شيك المنشأة غير صالح' }
      if (row?.notes != null && row.notes !== '' && notes === null) return { error: 'ملاحظات الشيك تتجاوز 2000 حرف' }
      payments.push({ method, amount, checkNumber, dueDate, notes })
      continue
    }

    const reference = normalizeOptionalText(row?.reference, 200)
    if (row?.reference != null && row.reference !== '' && reference === null) {
      return { error: 'مرجع الدفعة يتجاوز 200 حرف' }
    }
    payments.push({ method, amount, reference })
  }
  return { value: payments }
}

export function parseSupplierPaymentInput(body) {
  const parsed = parseSupplierPayments(body?.payments)
  if (parsed.error) return parsed
  const notes = normalizeOptionalText(body?.notes, 2000)
  if (body?.notes != null && body.notes !== '' && notes === null) {
    return { error: 'ملاحظات الدفعة تتجاوز 2000 حرف' }
  }
  return { value: { payments: parsed.value, notes } }
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
