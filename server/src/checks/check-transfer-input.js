import { normalizeRequiredText, parseId } from '../products/product-input.js'

export function parseCheckTransferInput(body) {
  const supplierId = parseId(body?.supplierId)
  const transferDate = normalizeRequiredText(body?.transferDate, 10)

  if (!supplierId) return { error: 'يجب اختيار مورد صالح' }
  if (!isValidDate(transferDate)) {
    return { error: 'تاريخ التحويل غير صالح ويجب أن يكون بصيغة YYYY-MM-DD' }
  }

  return { value: { supplierId, transferDate } }
}

function isValidDate(value) {
  if (!value) return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
}

