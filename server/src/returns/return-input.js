import Decimal from 'decimal.js'
import { normalizeDecimal, parseId } from '../products/product-input.js'

const ReturnDecimal = Decimal.clone({ precision: 100 })

export function parseReturnInput(body) {
  const sourceDocumentId = parseId(
    body?.sourceDocumentId ?? body?.saleId ?? body?.purchaseId,
  )
  if (!sourceDocumentId) return { error: 'يجب اختيار الفاتورة الأصلية' }
  if (!Array.isArray(body?.items) || body.items.length === 0 || body.items.length > 500) {
    return { error: 'يجب اختيار بند واحد على الأقل للمرتجع' }
  }

  const itemIds = new Set()
  const items = []
  for (const row of body.items) {
    const sourceItemId = parseId(row?.sourceItemId ?? row?.saleItemId ?? row?.purchaseItemId)
    const quantity = normalizeDecimal(row?.quantity, { scale: 3 })
    if (!sourceItemId || itemIds.has(sourceItemId)) {
      return { error: 'بنود المرتجع غير صالحة أو تحتوي على بند مكرر' }
    }
    if (quantity === undefined || !new ReturnDecimal(quantity).greaterThan(0)) {
      return { error: 'كمية المرتجع يجب أن تكون أكبر من صفر وبحد أقصى ثلاث منازل عشرية' }
    }
    itemIds.add(sourceItemId)
    items.push({ sourceItemId, quantity })
  }
  return { value: { sourceDocumentId, items } }
}
