import {
  normalizeDecimal,
  normalizeOptionalText,
  normalizeRequiredText,
  parseId,
} from '../products/product-input.js'

export function parseOwnerCheckInput(body) {
  const checkNumber = normalizeRequiredText(body?.checkNumber, 100)
  const amount = normalizeDecimal(body?.amount)
  const dueDate = normalizeRequiredText(body?.dueDate, 10)
  const supplierId = parseId(body?.supplierId)
  const notes = normalizeOptionalText(body?.notes, 2000)

  if (!checkNumber) return { error: 'رقم الشيك مطلوب وبحد أقصى 100 حرف' }
  if (amount === undefined || !/[1-9]/.test(amount)) {
    return { error: 'مبلغ الشيك يجب أن يكون أكبر من صفر وبحد أقصى منزلتين عشريتين' }
  }
  if (!isValidBusinessDate(dueDate)) {
    return { error: 'تاريخ الاستحقاق غير صالح ويجب أن يكون بصيغة YYYY-MM-DD' }
  }
  if (!supplierId) return { error: 'يجب اختيار مورد صالح' }
  if (body?.notes != null && body.notes !== '' && notes === null) {
    return { error: 'الملاحظات تتجاوز 2000 حرف' }
  }

  return { value: { checkNumber, amount, dueDate, supplierId, notes } }
}

export function parseReminderSettingsInput(body) {
  const businessDays = body?.businessDays
  if (typeof businessDays !== 'number'
      || !Number.isInteger(businessDays)
      || businessDays < 1
      || businessDays > 30) {
    return { error: 'عدد أيام العمل يجب أن يكون عدداً صحيحاً من 1 إلى 30' }
  }
  return { value: { businessDays } }
}

export function isValidBusinessDate(value) {
  if (!value) return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
}
