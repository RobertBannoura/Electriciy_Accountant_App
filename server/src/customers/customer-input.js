import {
  normalizeOptionalText,
  normalizeRequiredText,
} from '../products/product-input.js'

export function parseCustomerInput(body) {
  const name = normalizeRequiredText(body?.name, 150)
  const phone = normalizeOptionalText(body?.phone, 50)
  const address = normalizeOptionalText(body?.address, 500)
  const notes = normalizeOptionalText(body?.notes, 2000)

  if (!name) {
    return { error: 'اسم العميل مطلوب وبحد أقصى 150 حرفاً' }
  }
  if (!isValidOptionalText(body?.phone, phone)) {
    return { error: 'رقم الهاتف يتجاوز 50 حرفاً' }
  }
  if (!isValidOptionalText(body?.address, address)) {
    return { error: 'العنوان يتجاوز 500 حرف' }
  }
  if (!isValidOptionalText(body?.notes, notes)) {
    return { error: 'الملاحظات تتجاوز 2000 حرف' }
  }

  return { value: { name, phone, address, notes } }
}

export function parseCustomerProjectInput(body) {
  const name = normalizeRequiredText(body?.name, 150)
  const notes = normalizeOptionalText(body?.notes, 2000)

  if (!name) {
    return { error: 'اسم المشروع مطلوب وبحد أقصى 150 حرفاً' }
  }
  if (!isValidOptionalText(body?.notes, notes)) {
    return { error: 'ملاحظات المشروع تتجاوز 2000 حرف' }
  }

  return { value: { name, notes } }
}

function isValidOptionalText(rawValue, normalizedValue) {
  return (
    rawValue === undefined ||
    rawValue === null ||
    rawValue === '' ||
    (typeof rawValue === 'string' && rawValue.trim() === '') ||
    normalizedValue !== null
  )
}
