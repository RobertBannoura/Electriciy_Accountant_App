import Decimal from 'decimal.js'
import { writeAuditEntry } from '../audit/write-audit-entry.js'
import { pool } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { claimFinancialOperation } from '../financial/financial-operation.js'
import { prepareSupplierPayments, writeSupplierPayments } from './supplier-payment-writer.js'

const PaymentDecimal = Decimal.clone({ precision: 100 })

export async function createSupplierPayment({ databasePool = pool, supplierId, input, storeId, userId, operation }) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    await claimFinancialOperation(client, { userId, operation })
    const storeResult = await client.query(
      'SELECT id FROM stores WHERE id = $1::BIGINT AND is_active = TRUE FOR SHARE',
      [storeId],
    )
    if (storeResult.rowCount === 0) throw new AppError('المتجر غير موجود أو غير فعال', 404, 'STORE_NOT_FOUND')

    const prepared = await prepareSupplierPayments(client, { payments: input.payments, storeId })

    const supplierResult = await client.query(
      'SELECT id::TEXT AS id, name FROM suppliers WHERE id = $1::BIGINT AND is_active = TRUE FOR UPDATE',
      [supplierId],
    )
    if (supplierResult.rowCount === 0) throw new AppError('المورد غير موجود أو غير فعال', 404, 'SUPPLIER_NOT_FOUND')
    const supplier = supplierResult.rows[0]

    const balanceResult = await client.query(
      'SELECT balance_ils::TEXT AS balance_ils FROM supplier_balances WHERE supplier_id = $1::BIGINT',
      [supplierId],
    )
    const balanceBefore = new PaymentDecimal(balanceResult.rows[0]?.balance_ils ?? 0)
    const total = new PaymentDecimal(prepared.total)
    if (total.greaterThan(balanceBefore)) {
      throw new AppError(
        balanceBefore.greaterThan(0)
          ? `مجموع الدفعات أكبر من دين المورد البالغ ₪${balanceBefore.toFixed()}`
          : 'لا يوجد دين مستحق لهذا المورد',
        409,
        'SUPPLIER_PAYMENT_EXCEEDS_DEBT',
      )
    }
    const occurredAt = new Date().toISOString()
    const savedPayments = await writeSupplierPayments(client, {
      payments: prepared.payments, storeId, supplier, occurredAt,
      notes: input.notes, userId,
    })
    const balanceAfter = balanceBefore.minus(total)
    for (const payment of savedPayments) {
      await writeAuditEntry(client, {
        storeId,
        userId,
        action: 'payment',
        entityType: payment.method?.includes('check') ? 'check' : 'payment',
        entityId: payment.id,
        newValues: {
          supplierId: supplier.id,
          method: payment.method,
          amountIls: payment.converted_ils_amount ?? payment.amount,
          balanceAfterIls: balanceAfter.toFixed(),
        },
      })
      if (payment.method === 'transferred_customer_check') {
        await writeAuditEntry(client, {
          storeId,
          userId,
          action: 'check_transfer',
          entityType: 'check',
          entityId: payment.id,
          newValues: { supplierId: supplier.id },
        })
      }
    }
    await client.query('COMMIT')
    return {
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      store_id: storeId,
      total_ils: total.toFixed(),
      balance_before_ils: balanceBefore.toFixed(),
      balance_after_ils: balanceAfter.toFixed(),
      payments: savedPayments,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
