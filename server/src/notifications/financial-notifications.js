import { currentBusinessDate } from '../checks/check-reminders.js'
import { query } from '../db/pool.js'
import { notifyAdminAfterCommit, formatIlsAmount, getPushConfiguration } from './push-service.js'

export async function notifySaleCreated({ sale, storeId }) {
  if (!getPushConfiguration().configured) {
    return { skipped: 'not_configured', successes: 0, failures: 0 }
  }
  const storeResult = await query(
    'SELECT name FROM stores WHERE id = $1::BIGINT',
    [storeId],
  ).catch(() => ({ rows: [] }))
  const storeName = storeResult.rows[0]?.name ?? 'المحل'
  return notifyAdminAfterCommit({
    category: 'sale_created', sourceType: 'sale', sourceId: sale.id,
    businessDate: sale.business_date, title: 'بيع جديد', url: '/reports?section=sales',
    body: `بيع جديد بقيمة ${formatIlsAmount(sale.total)} - ${storeName}`,
  })
}

export function notifyCustomerPaymentCreated({ payment }) {
  return notifyAdminAfterCommit({
    category: 'customer_payment', sourceType: 'customer_payment',
    sourceId: payment.payments[0]?.id ?? payment.customer_id,
    businessDate: currentBusinessDate(), title: 'دفعة عميل جديدة',
    url: `/customers/${payment.customer_id}`,
    body: `تم تسجيل دفعة من ${payment.customer_name} بقيمة ${formatIlsAmount(payment.total_ils)}`,
  })
}

export function notifyPurchaseCreated({ purchase }) {
  return notifyAdminAfterCommit({
    category: 'purchase_created', sourceType: 'purchase', sourceId: purchase.id,
    businessDate: purchase.business_date, title: 'شراء جديد', url: '/purchases',
    body: `شراء من المورد ${purchase.supplier_name} بقيمة ${formatIlsAmount(purchase.total)}`,
  })
}

export function notifySupplierPaymentCreated({ payment }) {
  return notifyAdminAfterCommit({
    category: 'supplier_payment', sourceType: 'supplier_payment',
    sourceId: payment.payments[0]?.id ?? payment.supplier_id,
    businessDate: currentBusinessDate(), title: 'دفعة مورد جديدة',
    url: `/suppliers/${payment.supplier_id}`,
    body: `تم تسجيل دفعة للمورد ${payment.supplier_name} بقيمة ${formatIlsAmount(payment.total_ils)}`,
  })
}

export function notifyCheckBounced({ check }) {
  const partyName = check.customer_name ?? check.supplier_name ?? 'غير محدد'
  return notifyAdminAfterCommit({
    category: 'check_bounced', sourceType: 'check', sourceId: check.id,
    businessDate: currentBusinessDate(), title: 'تنبيه شيك مرتجع', url: '/checks',
    body: `تنبيه: شيك مرتجع ل${partyName} بقيمة ${formatIlsAmount(check.amount)}`,
  })
}
