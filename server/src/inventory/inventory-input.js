import {
  normalizeDecimal,
  normalizeOptionalText,
  parseId,
} from '../products/product-input.js'

export const INVENTORY_MOVEMENT_TYPES = Object.freeze([
  'opening',
  'purchase',
  'sale',
  'customer_return',
  'supplier_return',
  'correction',
  'reversal',
])

const MAXIMUM_INVENTORY_SETTINGS = 100

const POSITIVE_MOVEMENTS = new Set(['opening', 'purchase', 'customer_return'])
const NEGATIVE_MOVEMENTS = new Set(['sale', 'supplier_return'])

export function normalizeSignedDecimal(value, scale = 12) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  const negative = trimmed.startsWith('-') || trimmed.startsWith('−')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const normalized = normalizeDecimal(unsigned, { scale })

  if (normalized === undefined) return undefined
  return negative && !isZeroDecimal(normalized) ? `-${normalized}` : normalized
}

export function isZeroDecimal(value) {
  return !/[1-9]/.test(value)
}

export function isWholeDecimal(value) {
  const [, fraction = ''] = value.split('.')
  return !/[1-9]/.test(fraction)
}

export function parseInventorySettings(value, saleUnit, { opening = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'يجب اختيار متجر واحد على الأقل للصنف' }
  }
  if (value.length > MAXIMUM_INVENTORY_SETTINGS) {
    return { error: 'قائمة متاجر الصنف تتجاوز الحد المسموح' }
  }

  const seenStoreIds = new Set()
  const settings = []

  for (const item of value) {
    const storeId = parseId(item?.storeId)
    const reorderLevel = normalizeDecimal(item?.reorderLevel, { scale: 12 })
    const openingQuantity = opening
      ? normalizeDecimal(item?.openingQuantity ?? '0', { scale: 12 })
      : '0'

    if (!storeId || seenStoreIds.has(storeId)) {
      return { error: 'قائمة متاجر الصنف غير صالحة' }
    }
    if (reorderLevel === undefined) {
      return { error: 'حد تنبيه المخزون مطلوب لكل متجر' }
    }
    if (openingQuantity === undefined) {
      return { error: 'الكمية الافتتاحية غير صالحة' }
    }
    if (
      saleUnit === 'قطعة' &&
      (!isWholeDecimal(reorderLevel) || !isWholeDecimal(openingQuantity))
    ) {
      return { error: 'كميات الصنف المباع بالقطعة يجب أن تكون أعداداً صحيحة' }
    }

    seenStoreIds.add(storeId)
    settings.push({ storeId, reorderLevel, openingQuantity })
  }

  return { value: settings }
}

export function parseMovementInput(body, saleUnit) {
  const storeId = parseId(body?.storeId)
  const movementType = INVENTORY_MOVEMENT_TYPES.includes(body?.movementType)
    ? body.movementType
    : null
  const quantityDelta = normalizeSignedDecimal(body?.quantityDelta)
  const reason = normalizeOptionalText(body?.reason, 500)

  if (!storeId) return { error: 'يجب اختيار متجر صالح' }
  if (!movementType) return { error: 'نوع حركة المخزون غير صالح' }
  if (quantityDelta === undefined || isZeroDecimal(quantityDelta)) {
    return { error: 'كمية الحركة مطلوبة ولا يجوز أن تكون صفراً' }
  }
  if (saleUnit === 'قطعة' && !isWholeDecimal(quantityDelta)) {
    return { error: 'كمية الصنف المباع بالقطعة يجب أن تكون عدداً صحيحاً' }
  }
  if (POSITIVE_MOVEMENTS.has(movementType) && quantityDelta.startsWith('-')) {
    return { error: 'نوع الحركة المحدد يحتاج إلى كمية موجبة' }
  }
  if (NEGATIVE_MOVEMENTS.has(movementType) && !quantityDelta.startsWith('-')) {
    return { error: 'نوع الحركة المحدد يحتاج إلى كمية سالبة' }
  }
  if (
    body?.reason !== undefined &&
    body?.reason !== null &&
    (typeof body.reason !== 'string' || Array.from(body.reason.trim()).length > 500)
  ) {
    return { error: 'سبب الحركة يتجاوز 500 حرف' }
  }

  return { value: { storeId, movementType, quantityDelta, reason } }
}
