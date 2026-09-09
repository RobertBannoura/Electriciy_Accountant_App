import Decimal from 'decimal.js'
import { parsePaymentDecimal } from './payment-draft'

export type SupplierPaymentMethod = 'cash' | 'bank' | 'owner_check' | 'transferred_customer_check'
export type SupplierPaymentDraft = {
  id: string
  method: SupplierPaymentMethod
  amount: string
  reference: string
  checkNumber: string
  dueDate: string
  checkId: string
}
export type TransferableCheck = {
  id: string
  check_number: string
  amount: string
  due_date: string
  customer_name: string | null
  supplier_id: string | null
  status: string
}

const PaymentDecimal = Decimal.clone({ precision: 100 })

export function newSupplierPayment(method: SupplierPaymentMethod, dueDate: string): SupplierPaymentDraft {
  return { id: crypto.randomUUID(), method, amount: '', reference: '', checkNumber: '', dueDate, checkId: '' }
}

export function calculateSupplierPayment(payment: SupplierPaymentDraft, checks: TransferableCheck[]) {
  if (payment.method === 'transferred_customer_check') {
    const check = checks.find((item) => item.id === payment.checkId)
    return check ? { amount: new PaymentDecimal(check.amount), error: null } : { amount: null, error: 'اختر شيك عميل متاحاً' }
  }
  const amount = parsePaymentDecimal(payment.amount, 2)
  if (!amount || !amount.greaterThan(0)) return { amount: null, error: 'أدخل مبلغاً أكبر من صفر' }
  if (!amount.mod('0.5').isZero()) return { amount: null, error: 'المبلغ يجب أن يكون بمضاعفات 0.50' }
  if (payment.method === 'owner_check' && !payment.checkNumber.trim()) return { amount: null, error: 'رقم الشيك مطلوب' }
  if (payment.method === 'owner_check' && !payment.dueDate) return { amount: null, error: 'تاريخ الاستحقاق مطلوب' }
  return { amount, error: null }
}

export function supplierPaymentsTotal(payments: SupplierPaymentDraft[], checks: TransferableCheck[]) {
  const rows = payments.map((payment) => calculateSupplierPayment(payment, checks))
  if (rows.some((row) => row.amount === null)) return null
  return rows.reduce((sum, row) => sum.plus(row.amount!), new PaymentDecimal(0))
}

export function serializeSupplierPayments(payments: SupplierPaymentDraft[]) {
  return payments.map((payment) => payment.method === 'transferred_customer_check'
    ? { method: payment.method, checkId: payment.checkId }
    : {
        method: payment.method,
        amount: parsePaymentDecimal(payment.amount, 2)?.toFixed() ?? payment.amount,
        ...(payment.method === 'bank' ? { reference: payment.reference.trim() || null } : {}),
        ...(payment.method === 'owner_check'
          ? { checkNumber: payment.checkNumber.trim(), dueDate: payment.dueDate }
          : {}),
      })
}
