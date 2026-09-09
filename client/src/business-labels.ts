const statusLabels: Record<string, string> = {
  recorded: 'مسجّلة',
  draft: 'مسودة',
  pending: 'قيد الانتظار',
  paid: 'مدفوعة',
  partially_paid: 'مدفوعة جزئياً',
  completed: 'مكتملة',
  cancelled: 'ملغاة',
  canceled: 'ملغاة',
  void: 'ملغاة',
  reversed: 'معكوس',
  issued: 'صادر',
  cleared: 'مصروف',
}

const customerCheckStatusLabels: Record<string, string> = {
  pending: 'قيد التحصيل',
  cleared: 'تم تحصيله',
  bounced: 'مرتجع',
}

const paymentMethodLabels: Record<string, string> = {
  cash: 'نقداً',
  card: 'بطاقة',
  bank_card: 'بطاقة / بنك',
  bank_transfer: 'تحويل بنكي',
  check: 'شيك',
}

const movementSourceLabels: Record<string, string> = {
  opening: 'رصيد افتتاحي',
  sale: 'بيع',
  purchase: 'شراء',
  payment: 'دفعة',
  check: 'شيك',
  adjustment: 'تسوية',
  reversal: 'عكس حركة',
  maintenance: 'صيانة',
  maintenance_payment: 'دفعة صيانة',
  maintenance_check: 'شيك صيانة',
  maintenance_reversal: 'عكس صيانة',
  maintenance_reversal_payment: 'عكس دفعة صيانة',
  maintenance_reversal_check: 'عكس شيك صيانة',
  check_transfer: 'تحويل شيك لمورد',
}

export function statusLabel(value: string) {
  return statusLabels[value] ?? `حالة غير معرّفة (${value})`
}

export function customerCheckStatusLabel(value: string) {
  return customerCheckStatusLabels[value] ?? `حالة شيك غير معرّفة (${value})`
}

export function paymentMethodLabel(value: string | null) {
  if (!value) return 'دفعة'
  return paymentMethodLabels[value] ?? `طريقة غير معرّفة (${value})`
}

export function movementSourceLabel(value: string) {
  return movementSourceLabels[value] ?? `حركة (${value})`
}
