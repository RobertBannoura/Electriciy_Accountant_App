import Decimal from 'decimal.js'
import {
  createPaymentMoneySnapshot,
  MoneyValidationError,
} from '../money/money.js'
import {
  normalizeDecimal,
  normalizeOptionalText,
  normalizeRequiredText,
} from '../products/product-input.js'

const PaymentDecimal = Decimal.clone({
  precision: 100,
  rounding: Decimal.ROUND_HALF_UP,
})

const PAYMENT_METHODS = new Set(['cash', 'bank_card', 'check'])
const MAXIMUM_PAYMENTS = 50

export function parseSalePayments(value) {
  if (value === undefined || value === null) return { value: [] }
  if (!Array.isArray(value)) return { error: 'تفاصيل الدفع غير صالحة' }
  if (value.length > MAXIMUM_PAYMENTS) {
    return { error: `لا يمكن أن تتجاوز الفاتورة ${MAXIMUM_PAYMENTS} سطر دفع` }
  }

  const payments = []
  for (const row of value) {
    const method = PAYMENT_METHODS.has(row?.method) ? row.method : null
    if (!method) return { error: 'طريقة الدفع غير صالحة' }
    if (
      method !== 'cash'
      && row?.currency !== undefined
      && row.currency !== null
      && row.currency !== 'ILS'
    ) {
      return { error: 'دفعات البطاقة والبنك والشيك تُسجل بالشيكل فقط' }
    }

    const currency = method === 'cash' ? row?.currency : 'ILS'
    const originalAmount = normalizeDecimal(row?.amount ?? row?.originalAmount, {
      scale: method === 'cash' && currency !== 'ILS' ? 6 : 2,
    })
    if (originalAmount === undefined || new PaymentDecimal(originalAmount).lessThanOrEqualTo(0)) {
      return { error: 'مبلغ كل سطر دفع يجب أن يكون أكبر من صفر' }
    }

    let exchangeRate = null
    if (method === 'cash' && currency !== 'ILS') {
      exchangeRate = normalizeDecimal(row?.exchangeRate, { scale: 12 })
      if (exchangeRate === undefined || new PaymentDecimal(exchangeRate).lessThanOrEqualTo(0)) {
        return { error: 'الدفع بالدولار أو الدينار يحتاج سعر صرف يدوي أكبر من صفر' }
      }
    } else if (row?.exchangeRate !== undefined && row.exchangeRate !== null && row.exchangeRate !== '') {
      return { error: 'سعر الصرف يستخدم فقط مع النقد بالدولار أو الدينار' }
    }

    let snapshot
    try {
      snapshot = createPaymentMoneySnapshot({
        currency,
        originalAmount,
        exchangeRate,
      })
    } catch (error) {
      if (!(error instanceof MoneyValidationError)) throw error
      if (error.code === 'UNSUPPORTED_CURRENCY') {
        return { error: 'عملة النقد يجب أن تكون شيكلاً أو دولاراً أو ديناراً' }
      }
      if (error.code === 'INVALID_ILS_STEP') {
        return { error: 'مبلغ الدفع بالشيكل يجب أن يكون بمضاعفات 0.50' }
      }
      return { error: 'بيانات مبلغ الدفع أو سعر الصرف غير صالحة' }
    }

    const reference = normalizeOptionalText(row?.reference, 200)
    if (row?.reference !== undefined && row.reference !== null && row.reference !== '' && reference === null) {
      return { error: 'مرجع دفعة البنك يتجاوز 200 حرف' }
    }

    if (method === 'check') {
      const checkNumber = normalizeRequiredText(row?.checkNumber, 100)
      const bankName = normalizeOptionalText(row?.bankName, 150)
      const notes = normalizeOptionalText(row?.notes, 2000)
      const isGiro = row?.isGiro === true
      const originalOwnerName = normalizeRequiredText(row?.originalOwnerName, 150)
      const originalOwnerPhone = normalizeRequiredText(row?.originalOwnerPhone, 50)
      if (!checkNumber) return { error: 'رقم الشيك مطلوب وبحد أقصى 100 حرف' }
      if (row?.isGiro !== undefined && typeof row.isGiro !== 'boolean') {
        return { error: 'نوع الشيك غير صالح' }
      }
      if (row?.bankName !== undefined && row.bankName !== null && row.bankName !== '' && bankName === null) {
        return { error: 'اسم بنك الشيك يتجاوز 150 حرفاً' }
      }
      if (row?.notes !== undefined && row.notes !== null && row.notes !== '' && notes === null) {
        return { error: 'ملاحظات الشيك تتجاوز 2000 حرف' }
      }
      if (!isValidDate(row?.dueDate)) {
        return { error: 'تاريخ استحقاق الشيك غير صالح ويجب أن يكون بصيغة YYYY-MM-DD' }
      }
      if (isGiro && !originalOwnerName) {
        return { error: 'اسم صاحب الشيك الأصلي مطلوب وبحد أقصى 150 حرفاً' }
      }
      if (isGiro && !originalOwnerPhone) {
        return { error: 'رقم هاتف صاحب الشيك الأصلي مطلوب وبحد أقصى 50 حرفاً' }
      }
      if (!isGiro && (row?.originalOwnerName || row?.originalOwnerPhone)) {
        return { error: 'بيانات صاحب الشيك الأصلي تستخدم مع شيك جيرو فقط' }
      }
      payments.push({
        method,
        ...snapshot,
        checkNumber,
        bankName,
        dueDate: row.dueDate,
        notes,
        isGiro,
        originalOwnerName: isGiro ? originalOwnerName : null,
        originalOwnerPhone: isGiro ? originalOwnerPhone : null,
      })
      continue
    }

    payments.push({ method, ...snapshot, reference })
  }

  return { value: payments }
}

export function calculateSalePaymentBreakdown(payments, saleTotal, customerId) {
  const total = new PaymentDecimal(saleTotal)
  const paidTotal = payments.reduce(
    (sum, payment) => sum.plus(payment.convertedIlsAmount),
    new PaymentDecimal(0),
  )

  if (paidTotal.greaterThan(total)) {
    return { error: 'مجموع الدفعات أكبر من إجمالي الفاتورة' }
  }

  if (!customerId && payments.some((payment) => payment.method === 'check')) {
    return { error: 'يجب اختيار عميل عند تسجيل شيك' }
  }

  const remainingDue = total.minus(paidTotal)
  if (remainingDue.greaterThan(0) && !customerId) {
    return { error: 'يجب اختيار عميل عند وجود مبلغ متبقٍ على الفاتورة' }
  }

  return {
    value: {
      payments,
      paidTotal: paidTotal.toFixed(),
      remainingDue: remainingDue.toFixed(),
    },
  }
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
