import { currentBusinessDate } from '../checks/check-reminders.js'
import { notifyAdminAfterCommit, getPushConfiguration } from './push-service.js'

export async function notifySaleCreated({ sale }) {
  if (!getPushConfiguration().configured) {
    return { skipped: 'not_configured', successes: 0, failures: 0 }
  }
  return notifyAdminAfterCommit({
    category: 'sale_created', sourceType: 'sale', sourceId: sale.id,
    businessDate: sale.business_date, title: 'بيع جديد', url: '/reports?section=sales',
    body: 'تم تسجيل عملية بيع جديدة. افتح التطبيق لعرض التفاصيل.',
  })
}

export function notifyCustomerPaymentCreated({ payment }) {
  return notifyAdminAfterCommit({
    category: 'customer_payment', sourceType: 'customer_payment',
    sourceId: payment.payments[0]?.id ?? payment.customer_id,
    businessDate: currentBusinessDate(), title: 'دفعة عميل جديدة',
    url: `/customers/${payment.customer_id}`,
    body: 'تم تسجيل دفعة عميل جديدة. افتح التطبيق لعرض التفاصيل.',
  })
}

export function notifyPurchaseCreated({ purchase }) {
  return notifyAdminAfterCommit({
    category: 'purchase_created', sourceType: 'purchase', sourceId: purchase.id,
    businessDate: purchase.business_date, title: 'شراء جديد', url: '/purchases',
    body: 'تم تسجيل عملية شراء جديدة. افتح التطبيق لعرض التفاصيل.',
  })
}

export function notifySupplierPaymentCreated({ payment }) {
  return notifyAdminAfterCommit({
    category: 'supplier_payment', sourceType: 'supplier_payment',
    sourceId: payment.payments[0]?.id ?? payment.supplier_id,
    businessDate: currentBusinessDate(), title: 'دفعة مورد جديدة',
    url: `/suppliers/${payment.supplier_id}`,
    body: 'تم تسجيل دفعة مورد جديدة. افتح التطبيق لعرض التفاصيل.',
  })
}

export function notifyCheckBounced({ check }) {
  return notifyAdminAfterCommit({
    category: 'check_bounced', sourceType: 'check', sourceId: check.id,
    businessDate: currentBusinessDate(), title: 'تنبيه شيك مرتجع', url: '/checks',
    body: 'يوجد شيك مرتجع يحتاج متابعة. افتح التطبيق لعرض التفاصيل.',
  })
}
