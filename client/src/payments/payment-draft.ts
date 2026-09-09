import Decimal from 'decimal.js'

export type PaymentMethod = 'cash' | 'bank_card' | 'check'
export type Currency = 'ILS' | 'USD' | 'JOD'
export type PaymentDraft = {
  id: string
  method: PaymentMethod
  currency: Currency
  amount: string
  exchangeRate: string
  reference: string
  checkNumber: string
  dueDate: string
  notes: string
  isGiro: boolean
  originalOwnerName: string
  originalOwnerPhone: string
}

const PaymentDecimal = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP })
const arabicDigits = '٠١٢٣٤٥٦٧٨٩'
const persianDigits = '۰۱۲۳۴۵۶۷۸۹'

export function parsePaymentDecimal(value: string, maximumScale: number) {
  const normalized = value.trim()
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)))
    .replace(/٫/g, '.')
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(normalized)
  if (!match || (match[1]?.length ?? 0) > maximumScale) return null
  return new PaymentDecimal(normalized)
}

export function normalizePaymentDecimal(value: string, maximumScale: number) {
  return parsePaymentDecimal(value, maximumScale)?.toFixed() ?? value
}

export function newPayment(method: PaymentMethod, dueDate: string, isGiro = false): PaymentDraft {
  return {
    id: crypto.randomUUID(), method, currency: 'ILS', amount: '', exchangeRate: '',
    reference: '', checkNumber: '', dueDate, notes: '', isGiro,
    originalOwnerName: '', originalOwnerPhone: '',
  }
}

export function calculatePayment(payment: PaymentDraft) {
  const foreign = payment.method === 'cash' && payment.currency !== 'ILS'
  const amount = parsePaymentDecimal(payment.amount, foreign ? 6 : 2)
  if (!amount || !amount.greaterThan(0)) return { amount: null, error: 'أدخل مبلغاً أكبر من صفر' }
  if (!foreign && !amount.mod('0.5').isZero()) {
    return { amount: null, error: 'المبلغ بالشيكل يجب أن يكون بمضاعفات 0.50' }
  }
  if (payment.method === 'check' && !payment.checkNumber.trim()) {
    return { amount: null, error: 'رقم الشيك مطلوب' }
  }
  if (payment.method === 'check' && !payment.dueDate) {
    return { amount: null, error: 'تاريخ استحقاق الشيك مطلوب' }
  }
  if (payment.method === 'check' && payment.isGiro && !payment.originalOwnerName.trim()) {
    return { amount: null, error: 'اسم صاحب الشيك الأصلي مطلوب' }
  }
  if (payment.method === 'check' && payment.isGiro && !payment.originalOwnerPhone.trim()) {
    return { amount: null, error: 'رقم هاتف صاحب الشيك الأصلي مطلوب' }
  }
  if (!foreign) return { amount, error: null }
  const rate = parsePaymentDecimal(payment.exchangeRate, 6)
  if (!rate || !rate.greaterThan(0)) return { amount: null, error: 'أدخل سعر الصرف يدوياً' }
  return { amount: amount.mul(rate), error: null }
}

export function paymentsTotal(payments: PaymentDraft[]) {
  const calculated = payments.map(calculatePayment)
  if (calculated.some((row) => row.amount === null)) return null
  return calculated.reduce((sum, row) => sum.plus(row.amount!), new PaymentDecimal(0))
}

export function serializePayments(payments: PaymentDraft[]) {
  return payments.map((payment) => ({
    method: payment.method,
    currency: payment.method === 'cash' ? payment.currency : 'ILS',
    amount: normalizePaymentDecimal(
      payment.amount,
      payment.method === 'cash' && payment.currency !== 'ILS' ? 6 : 2,
    ),
    ...(payment.method === 'cash' && payment.currency !== 'ILS'
      ? { exchangeRate: normalizePaymentDecimal(payment.exchangeRate, 6) }
      : {}),
    ...(payment.method === 'bank_card'
      ? { reference: payment.reference.trim() || null }
      : {}),
    ...(payment.method === 'check'
      ? {
          checkNumber: payment.checkNumber.trim(),
          dueDate: payment.dueDate,
          notes: payment.notes.trim() || null,
          isGiro: payment.isGiro,
          ...(payment.isGiro
            ? {
                originalOwnerName: payment.originalOwnerName.trim(),
                originalOwnerPhone: payment.originalOwnerPhone.trim(),
              }
            : {}),
        }
      : {}),
  }))
}
