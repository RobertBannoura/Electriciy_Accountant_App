import { query } from '../db/pool.js'
import { currentBusinessDate } from '../checks/check-reminders.js'
import { isValidBusinessDate } from '../checks/check-input.js'
import { normalizeOptionalText, parseId } from '../products/product-input.js'

export function parsePaymentPromise(body) {
  if (typeof body?.date !== 'string' || !isValidBusinessDate(body.date)) return { error: 'اختر تاريخاً صالحاً لوعد الدفع' }
  const note = normalizeOptionalText(body.note, 500)
  if (body.note != null && body.note !== '' && (typeof body.note !== 'string' || (body.note.trim() && note === null))) {
    return { error: 'الملاحظة يجب ألا تتجاوز 500 حرف' }
  }
  return { value: { date: body.date, note } }
}

export function parsePromiseVersion(value) {
  return parseId(value)
}

export async function getCustomerReminders({ dbQuery = query, today = currentBusinessDate() } = {}) {
  const result = await dbQuery(`
    SELECT customers.id::TEXT AS id, customers.name, customers.phone,
      balances.balance_ils::TEXT AS balance_ils,
      customers.debt_limit_ils::TEXT AS debt_limit_ils,
      customers.payment_promise_date::TEXT AS payment_promise_date,
      customers.payment_promise_note,
      customers.payment_promise_version::TEXT AS payment_promise_version,
      COALESCE(balances.balance_ils > 0 AND balances.balance_ils >= customers.debt_limit_ils, FALSE) AS limit_reached,
      COALESCE(customers.payment_promise_date <= $1::DATE, FALSE) AS promise_due,
      (customers.payment_promise_date <= $1::DATE OR
        (customers.payment_promise_date IS NULL AND balances.balance_ils > 0
          AND balances.balance_ils >= customers.debt_limit_ils)) IS TRUE AS needs_notification
    FROM customers
    INNER JOIN customer_balances AS balances ON balances.customer_id = customers.id
    WHERE customers.is_active = TRUE AND (
      customers.payment_promise_date IS NOT NULL OR
      (balances.balance_ils > 0 AND balances.balance_ils >= customers.debt_limit_ils)
    )
    ORDER BY customers.payment_promise_date ASC NULLS LAST, customers.name, customers.id
  `, [today])
  return { customers: result.rows, business_date: today }
}
