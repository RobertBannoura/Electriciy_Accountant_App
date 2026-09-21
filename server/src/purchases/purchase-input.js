import Decimal from 'decimal.js'
import {
  isHalfShekelAmount,
  normalizeDecimal,
  normalizeOptionalText,
  normalizeRequiredText,
  parseId,
} from '../products/product-input.js'
import { parseSupplierPayments } from '../suppliers/supplier-payment-input.js'

const PurchaseDecimal = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP })
const MAXIMUM_ITEMS = 500

export function parsePurchaseInput(body) {
  const supplierId = parseId(body?.supplierId)
  const documentNumber = normalizeOptionalText(body?.documentNumber, 100)
  const businessDate = body?.businessDate ?? body?.date
  const notes = normalizeOptionalText(body?.notes, 2000)
  const parsedPayments = parseSupplierPayments(body?.payments, { allowEmpty: true })
  const hasProvidedDocumentNumber = body?.documentNumber != null
    && String(body.documentNumber).trim() !== ''

  if (!supplierId) return { error: 'يجب اختيار مورد صالح' }
  if (hasProvidedDocumentNumber && documentNumber === null) {
    return { error: 'رقم فاتورة الشراء يجب أن يكون بحد أقصى 100 حرف' }
  }
  if (!isValidDate(businessDate)) return { error: 'تاريخ الشراء غير صالح ويجب أن يكون بصيغة YYYY-MM-DD' }
  if (body?.notes != null && body.notes !== '' && notes === null) {
    return { error: 'ملاحظات الشراء تتجاوز 2000 حرف' }
  }
  if (parsedPayments.error) return parsedPayments
  if (!Array.isArray(body?.items) || body.items.length === 0) {
    return { error: 'يجب أن تحتوي فاتورة الشراء على صنف واحد على الأقل' }
  }
  if (body.items.length > MAXIMUM_ITEMS) {
    return { error: `لا يمكن أن تتجاوز الفاتورة ${MAXIMUM_ITEMS} بنداً` }
  }

  const items = []
  const productIds = new Set()
  for (const row of body.items) {
    const productId = row?.productId == null ? null : parseId(row.productId)
    const description = normalizeRequiredText(row?.description, 500)
    const quantity = normalizeDecimal(row?.quantity, { scale: 3 })
    const purchasePrice = normalizeDecimal(row?.purchasePrice ?? row?.unitCost, { scale: 2 })
    if (row?.productId != null && !productId) return { error: 'أحد معرّفات الأصناف غير صالح' }
    if (!productId && !description) {
      return { error: 'اسم الصنف اليدوي مطلوب وبحد أقصى 500 حرف' }
    }
    if (productId && productIds.has(productId)) {
      return { error: 'لا يمكن تكرار الصنف في فاتورة الشراء' }
    }
    if (quantity === undefined || new PurchaseDecimal(quantity).lessThanOrEqualTo(0)) {
      return { error: 'كمية كل بند يجب أن تكون أكبر من صفر وبحد أقصى ثلاث منازل عشرية' }
    }
    if (purchasePrice === undefined || !isHalfShekelAmount(purchasePrice)) {
      return { error: 'سعر الشراء مطلوب ويجب أن يكون موجباً أو صفراً وبمضاعفات ₪0.50' }
    }
    if (productId) productIds.add(productId)
    items.push({ productId, ...(productId ? {} : { description }), quantity, purchasePrice })
  }

  return {
    value: {
      supplierId,
      documentNumber,
      businessDate,
      notes,
      items,
      payments: parsedPayments.value,
    },
  }
}

export function calculatePurchase(items) {
  let total = new PurchaseDecimal(0)
  const calculatedItems = items.map((item) => {
    const lineTotal = new PurchaseDecimal(item.quantity).mul(item.purchasePrice)
    total = total.plus(lineTotal)
    return { ...item, lineTotal: lineTotal.toFixed() }
  })
  return { items: calculatedItems, total: total.toFixed() }
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
