import { normalizeOptionalText } from '../products/product-input.js'
import { parseSalePayments } from '../sales/sale-payment-input.js'

export function parseCustomerPaymentInput(body) {
  const parsedPayments = parseSalePayments(body?.payments)
  if (parsedPayments.error) return parsedPayments
  if (parsedPayments.value.length === 0) {
    return { error: 'أضف طريقة دفع واحدة على الأقل' }
  }

  const notes = normalizeOptionalText(body?.notes, 2000)
  if (body?.notes !== undefined && body.notes !== null && body.notes !== '' && notes === null) {
    return { error: 'ملاحظات الدفعة تتجاوز 2000 حرف' }
  }

  const payments = parsedPayments.value.map((payment) => (
    payment.method === 'check' && !payment.notes && notes
      ? { ...payment, notes }
      : payment
  ))

  return { value: { payments, notes } }
}
