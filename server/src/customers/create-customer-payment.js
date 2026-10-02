import Decimal from 'decimal.js'
import { writeAuditEntry } from '../audit/write-audit-entry.js'
import { pool } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { claimFinancialOperation } from '../financial/financial-operation.js'
import { formatMoneyDisplay } from '../money/money.js'
import {
  insertCustomerLedgerMovement,
  insertIncomingPayment,
} from '../payments/payment-writer.js'

const PaymentDecimal = Decimal.clone({
  precision: 100,
  rounding: Decimal.ROUND_HALF_UP,
})

export async function createCustomerPayment({
  databasePool = pool,
  customerId,
  input,
  storeId,
  userId,
  operation,
}) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    await claimFinancialOperation(client, { userId, operation })
    const storeResult = await client.query(
      'SELECT id FROM stores WHERE id = $1::BIGINT AND is_active = TRUE FOR SHARE',
      [storeId],
    )
    if (storeResult.rowCount === 0) {
      throw new AppError('المتجر غير موجود أو غير فعال', 404, 'STORE_NOT_FOUND')
    }

    const customerResult = await client.query(
      `
        SELECT id::TEXT AS id, name
        FROM customers
        WHERE id = $1::BIGINT AND is_active = TRUE
        FOR UPDATE
      `,
      [customerId],
    )
    if (customerResult.rowCount === 0) {
      throw new AppError('العميل غير موجود أو غير فعال', 404, 'CUSTOMER_NOT_FOUND')
    }

    const balanceResult = await client.query(
      `
        SELECT balance_ils::TEXT AS balance_ils
        FROM customer_balances
        WHERE customer_id = $1::BIGINT
      `,
      [customerId],
    )
    const balanceBefore = new PaymentDecimal(balanceResult.rows[0]?.balance_ils ?? '0')
    const total = input.payments.reduce(
      (sum, payment) => sum.plus(payment.convertedIlsAmount),
      new PaymentDecimal(0),
    )
    if (total.greaterThan(balanceBefore)) {
      throw new AppError(
        balanceBefore.greaterThan(0)
          ? `مجموع الدفعات أكبر من دين العميل البالغ ₪${formatMoneyDisplay(balanceBefore)}`
          : 'لا يوجد دين مستحق على هذا العميل',
        409,
        'CUSTOMER_PAYMENT_EXCEEDS_DEBT',
      )
    }

    if (input.completePromiseVersion) {
      const promiseResult = await client.query(`
        UPDATE customers SET payment_promise_date = NULL, payment_promise_note = NULL,
          payment_promise_version = payment_promise_version + 1
        WHERE id = $1::BIGINT AND is_active = TRUE
          AND payment_promise_version = $2::BIGINT AND payment_promise_date IS NOT NULL
      `, [customerId, input.completePromiseVersion])
      if (promiseResult.rowCount === 0) {
        throw new AppError('تم تغيير وعد الدفع. حدّث التذكيرات وحاول مرة أخرى.', 409, 'PAYMENT_PROMISE_CHANGED')
      }
    }

    const customer = customerResult.rows[0]
    const savedPayments = []
    for (const payment of input.payments) {
      const savedPayment = await insertIncomingPayment(client, {
        payment,
        storeId,
        customerId,
        contextLabel: `دفعة من العميل ${customer.name}`,
        movementSourceType: 'customer_payment',
        userId,
      })
      savedPayments.push(savedPayment)

      await insertCustomerLedgerMovement(client, {
        storeId,
        customerId,
        direction: 'credit',
        amountIls: payment.convertedIlsAmount,
        sourceType: payment.method === 'check' ? 'check' : 'payment',
        sourceId: savedPayment.id,
        notes: input.notes ?? `دفعة من العميل ${customer.name}`,
        userId,
      })
    }

    const balanceAfter = balanceBefore.minus(total)
    for (const payment of savedPayments) {
      await writeAuditEntry(client, {
        storeId,
        userId,
        action: 'payment',
        entityType: payment.method === 'check' ? 'check' : 'payment',
        entityId: payment.id,
        newValues: {
          customerId: customer.id,
          method: payment.method,
          amountIls: payment.converted_ils_amount,
          balanceAfterIls: balanceAfter.toFixed(),
        },
      })
    }
    await client.query('COMMIT')
    return {
      customer_id: customer.id,
      customer_name: customer.name,
      store_id: storeId,
      total_ils: total.toFixed(),
      balance_before_ils: balanceBefore.toFixed(),
      balance_after_ils: balanceAfter.toFixed(),
      promise_completed: Boolean(input.completePromiseVersion),
      payments: savedPayments,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
