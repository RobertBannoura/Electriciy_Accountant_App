import Decimal from 'decimal.js'
import {
  isHalfShekelAmount,
  normalizeDecimal,
  normalizeRequiredText,
  parseId,
} from '../products/product-input.js'
import { parseSalePayments } from './sale-payment-input.js'

const SaleDecimal = Decimal.clone({
  precision: 100,
  rounding: Decimal.ROUND_HALF_UP,
})

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MAXIMUM_ITEMS = 500

function parseOptionalId(value) {
  if (value === undefined || value === null || value === '') return null
  return parseId(value) ?? undefined
}

function isValidBusinessDate(value) {
  if (typeof value !== 'string') return false
  const match = DATE_PATTERN.exec(value)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function parseMoney(value, { optionalZero = false } = {}) {
  const candidate = optionalZero && (value === undefined || value === null || value === '')
    ? '0'
    : value
  const normalized = normalizeDecimal(candidate, { scale: 2 })
  return normalized !== undefined && isHalfShekelAmount(normalized)
    ? normalized
    : undefined
}

export function parseSaleInput(body) {
  const rawInvoiceNumber = body?.invoiceNumber
  const invoiceNumber = typeof rawInvoiceNumber === 'string' && rawInvoiceNumber.trim() === ''
    ? null
    : rawInvoiceNumber === undefined || rawInvoiceNumber === null
      ? null
      : normalizeRequiredText(rawInvoiceNumber, 100)
  const businessDateValue = body?.businessDate ?? body?.date
  const customerId = parseOptionalId(body?.customerId)
  const customerProjectId = parseOptionalId(body?.customerProjectId)
  const invoiceDiscount = parseMoney(body?.invoiceDiscount, { optionalZero: true })
  const parsedPayments = parseSalePayments(body?.payments)

  if (rawInvoiceNumber !== undefined && rawInvoiceNumber !== null && invoiceNumber === null
    && !(typeof rawInvoiceNumber === 'string' && rawInvoiceNumber.trim() === '')) {
    return { error: 'رقم الفاتورة المرسل يجب ألا يتجاوز 100 حرف' }
  }
  if (!isValidBusinessDate(businessDateValue)) {
    return { error: 'تاريخ الفاتورة غير صالح ويجب أن يكون بصيغة YYYY-MM-DD' }
  }
  if (customerId === undefined) return { error: 'معرّف العميل غير صالح' }
  if (customerProjectId === undefined) {
    return { error: 'معرّف مشروع العميل غير صالح' }
  }
  if (customerProjectId && !customerId) {
    return { error: 'يجب اختيار العميل عند اختيار مشروع له' }
  }
  if (invoiceDiscount === undefined) {
    return { error: 'خصم الفاتورة يجب أن يكون مبلغاً موجباً أو صفراً وبمضاعفات ₪0.50' }
  }
  if (parsedPayments.error) return parsedPayments
  if (!Array.isArray(body?.items) || body.items.length === 0) {
    return { error: 'يجب أن تحتوي الفاتورة على صنف واحد على الأقل' }
  }
  if (body.items.length > MAXIMUM_ITEMS) {
    return { error: `لا يمكن أن تتجاوز الفاتورة ${MAXIMUM_ITEMS} بنداً` }
  }

  const items = []
  for (const item of body.items) {
    const productId = parseOptionalId(item?.productId)
    const description = productId === null
      ? normalizeRequiredText(item?.description, 500)
      : null
    const quantity = normalizeDecimal(item?.quantity, { scale: 3 })
    const actualPrice = parseMoney(item?.actualPrice ?? item?.actualSalePrice)
    const discount = parseMoney(item?.discount, { optionalZero: true })

    if (productId === undefined) return { error: 'أحد معرّفات الأصناف غير صالح' }
    if (productId === null && !description) {
      return { error: 'اسم الصنف مطلوب لكل بند يدوي وبحد أقصى 500 حرف' }
    }
    if (quantity === undefined || new SaleDecimal(quantity).lessThanOrEqualTo(0)) {
      return { error: 'كمية كل بند يجب أن تكون أكبر من صفر وبحد أقصى ثلاث منازل عشرية' }
    }
    if (actualPrice === undefined) {
      return { error: 'سعر البيع الفعلي لكل بند مطلوب وبمضاعفات ₪0.50' }
    }
    if (discount === undefined) {
      return { error: 'خصم كل بند يجب أن يكون مبلغاً موجباً أو صفراً وبمضاعفات ₪0.50' }
    }

    items.push(productId === null
      ? { productId: null, description, quantity, actualPrice, discount }
      : { productId, quantity, actualPrice, discount })
  }

  return {
    value: {
      invoiceNumber,
      businessDate: businessDateValue,
      customerId,
      customerProjectId,
      invoiceDiscount,
      items,
      payments: parsedPayments.value,
    },
  }
}

export function calculateSale(items, invoiceDiscount) {
  let itemsSubtotal = new SaleDecimal(0)
  const calculatedItems = []

  for (const item of items) {
    const quantity = new SaleDecimal(item.quantity)
    const actualPrice = new SaleDecimal(item.actualPrice)
    const discount = new SaleDecimal(item.discount)

    if (item.saleUnit === 'قطعة' && !quantity.isInteger()) {
      return { error: `كمية الصنف «${item.productName}» يجب أن تكون عدداً صحيحاً` }
    }

    const valueBeforeDiscount = quantity.mul(actualPrice)
    if (discount.greaterThan(valueBeforeDiscount)) {
      return { error: `خصم الصنف «${item.productName}» أكبر من قيمة البند` }
    }

    const lineTotal = valueBeforeDiscount.minus(discount)
    itemsSubtotal = itemsSubtotal.plus(lineTotal)
    calculatedItems.push({ ...item, lineTotal: lineTotal.toFixed() })
  }

  const invoiceDiscountValue = new SaleDecimal(invoiceDiscount)
  if (invoiceDiscountValue.greaterThan(itemsSubtotal)) {
    return { error: 'خصم الفاتورة أكبر من مجموع بنودها' }
  }

  return {
    value: {
      items: calculatedItems,
      itemsSubtotal: itemsSubtotal.toFixed(),
      invoiceDiscount,
      total: itemsSubtotal.minus(invoiceDiscountValue).toFixed(),
    },
  }
}
