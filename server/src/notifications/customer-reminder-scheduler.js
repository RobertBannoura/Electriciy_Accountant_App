import { getCustomerReminders } from '../customers/customer-reminders.js'
import { currentBusinessDate } from '../checks/check-reminders.js'
import { query } from '../db/pool.js'
import { getPushConfiguration, notifyAdminAfterCommit } from './push-service.js'

export async function sendCustomerReminderNotifications({
  dbQuery = query, today = currentBusinessDate(), notify = notifyAdminAfterCommit,
} = {}) {
  if (!getPushConfiguration().configured && notify === notifyAdminAfterCommit) return { sent: 0 }
  const { customers } = await getCustomerReminders({ dbQuery, today })
  const due = customers.filter((customer) => customer.needs_notification)
  for (const customer of due) {
    await notify({
      category: 'customer_reminder', sourceType: `customer_reminder:${today}`, sourceId: customer.id,
      businessDate: today, title: 'تذكير بمتابعة سداد العملاء', url: '/',
      body: 'يوجد وعد دفع مستحق أو عميل بلغ حد الدين. افتح التطبيق لعرض التفاصيل.',
    })
  }
  return { sent: due.length }
}
