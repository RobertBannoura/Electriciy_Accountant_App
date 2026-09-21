import {
  isHalfShekelAmount,
  normalizeDecimal,
  normalizeOptionalText,
  normalizeRequiredText,
  parseId,
} from '../products/product-input.js'
import { parseSalePayments } from '../sales/sale-payment-input.js'

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function optionalId(value) {
  if (value === undefined || value === null || value === '') return null
  return parseId(value) ?? undefined
}

export function isValidMaintenanceDate(value) {
  if (typeof value !== 'string') return false
  const match = DATE_PATTERN.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
}

export function parseMaintenanceInput(body) {
  const customerId = optionalId(body?.customerId)
  const itemDescription = normalizeRequiredText(body?.itemDescription, 200)
  const maintenanceDetails = normalizeOptionalText(body?.maintenanceDetails, 2000)
  const notes = normalizeOptionalText(body?.notes, 2000)
  const amount = normalizeDecimal(body?.amount, { scale: 2 })
  const businessDate = body?.businessDate ?? body?.date
  const payments = parseSalePayments(body?.payments)

  if (customerId === undefined) return { error: 'معرّف العميل غير صالح' }
  if (!itemDescription) return { error: 'وصف الجهاز أو القطعة مطلوب وبحد أقصى 200 حرف' }
  if (body?.maintenanceDetails && maintenanceDetails === null) {
    return { error: 'تفاصيل الصيانة تتجاوز 2000 حرف' }
  }
  if (body?.notes && notes === null) return { error: 'الملاحظات تتجاوز 2000 حرف' }
  if (amount === undefined || amount === '0' || !isHalfShekelAmount(amount)) {
    return { error: 'مبلغ الصيانة يجب أن يكون أكبر من صفر وبمضاعفات ₪0.50' }
  }
  if (!isValidMaintenanceDate(businessDate)) {
    return { error: 'تاريخ الصيانة غير صالح ويجب أن يكون بصيغة YYYY-MM-DD' }
  }
  if (payments.error) return payments

  return {
    value: {
      customerId,
      itemDescription,
      maintenanceDetails,
      notes,
      amount,
      businessDate,
      payments: payments.value,
    },
  }
}

export function parseMaintenanceReversalInput(body) {
  const reason = normalizeRequiredText(body?.reason, 1000)
  return reason
    ? { value: { reason } }
    : { error: 'سبب العكس مطلوب وبحد أقصى 1000 حرف' }
}
