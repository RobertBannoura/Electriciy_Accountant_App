export const SALE_UNITS = Object.freeze(['قطعة', 'متر'])

const BIGINT_MAX = 9_223_372_036_854_775_807n
const ID_PATTERN = /^[1-9]\d*$/
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

function normalizeDigits(value) {
  return value
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_DIGITS.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(PERSIAN_DIGITS.indexOf(digit)))
    .replace(/٫/g, '.')
}

export function parseId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    return null
  }

  return BigInt(value) <= BIGINT_MAX ? value : null
}

export function normalizeRequiredText(value, maxLength) {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 && Array.from(normalized).length <= maxLength
    ? normalized
    : null
}

export function normalizeOptionalText(value, maxLength) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  return normalizeRequiredText(value, maxLength)
}

export function normalizeBarcode(value) {
  if (value === undefined || value === null || value === '') return null

  const barcode = normalizeRequiredText(value, 100)
  return barcode && !/\s/.test(barcode) ? barcode : undefined
}

export function normalizeDecimal(value, { optional = false, scale = 2 } = {}) {
  if ((value === undefined || value === null || value === '') && optional) {
    return null
  }

  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = normalizeDigits(String(value).trim())
  const match = DECIMAL_PATTERN.exec(normalized)

  if (!match || (match[1]?.length ?? 0) > scale) {
    return undefined
  }

  const [integerPart, fractionPart = ''] = normalized.split('.')
  if (integerPart.length > 12) {
    return undefined
  }

  return fractionPart.length > 0
    ? `${BigInt(integerPart)}.${fractionPart}`
    : String(BigInt(integerPart))
}

export function isHalfShekelAmount(value) {
  if (value === null) {
    return true
  }

  const [, fraction = ''] = value.split('.')
  const hundredths = Number((fraction + '00').slice(0, 2))
  return hundredths === 0 || hundredths === 50
}

export function isSaleQuantityAllowed(unit, value) {
  const quantity = normalizeDecimal(value, { scale: 3 })
  if (quantity === undefined || decimalIsZero(quantity)) {
    return false
  }

  return unit === 'متر' || (unit === 'قطعة' && !hasFractionalValue(quantity))
}

function hasFractionalValue(value) {
  const [, fraction = ''] = value.split('.')
  return /[1-9]/.test(fraction)
}

function decimalIsZero(value) {
  return !/[1-9]/.test(value)
}

export function parseProductInput(body) {
  const name = normalizeRequiredText(body?.name, 150)
  const categoryId = parseId(body?.categoryId)
  const saleUnit = SALE_UNITS.includes(body?.saleUnit) ? body.saleUnit : null
  const barcode = normalizeBarcode(body?.barcode)
  const purchasePrice = normalizeDecimal(body?.currentPurchasePrice, {
    optional: true,
  })
  const salePrice = normalizeDecimal(body?.defaultSalePrice, { optional: true })
  const notes = normalizeOptionalText(body?.notes, 2000)

  if (!name) return { error: 'اسم الصنف مطلوب وبحد أقصى 150 حرفاً' }
  if (!categoryId) return { error: 'يجب اختيار تصنيف صالح' }
  if (!saleUnit) return { error: 'وحدة البيع يجب أن تكون قطعة أو متر' }
  if (barcode === undefined) return { error: 'الباركود غير صالح ولا يجوز أن يحتوي مسافات' }
  if (purchasePrice === undefined || !isHalfShekelAmount(purchasePrice)) {
    return { error: 'سعر الشراء يجب أن يكون صفراً أو موجباً وبمضاعفات ₪0.50' }
  }
  if (salePrice === undefined || !isHalfShekelAmount(salePrice)) {
    return { error: 'سعر البيع يجب أن يكون صفراً أو موجباً وبمضاعفات ₪0.50' }
  }
  if (
    body?.notes !== undefined &&
    body?.notes !== null &&
    (typeof body.notes !== 'string' || Array.from(body.notes.trim()).length > 2000)
  ) {
    return { error: 'الملاحظات تتجاوز 2000 حرف' }
  }

  return {
    value: {
      name,
      categoryId,
      saleUnit,
      barcode,
      purchasePrice,
      salePrice,
      notes,
    },
  }
}
