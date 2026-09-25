import Decimal from 'decimal.js'
import { pool } from '../db/pool.js'
import { writeAuditEntry } from '../audit/write-audit-entry.js'
import { AppError } from '../errors/app-error.js'
import { claimFinancialOperation } from '../financial/financial-operation.js'
import { formatMoneyDisplay } from '../money/money.js'

const CheckDecimal = Decimal.clone({ precision: 100 })

export async function transferCheckToSupplier({
  databasePool = pool,
  checkId,
  supplierId,
  transferDate,
  storeId,
  userId,
  operation,
}) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    await claimFinancialOperation(client, { userId, operation })

    const checkResult = await client.query(
      `
        SELECT
          checks.id::TEXT AS id,
          checks.customer_id::TEXT AS customer_id,
          checks.check_number,
          checks.amount::TEXT AS amount,
          checks.status,
          checks.supplier_id::TEXT AS supplier_id,
          checks.transferred_at::TEXT AS transferred_at
        FROM checks
        WHERE checks.id = $1::BIGINT
          AND checks.store_id = $2::BIGINT
          AND checks.customer_id IS NOT NULL
          AND checks.direction = 'inflow'
        FOR UPDATE
      `,
      [checkId, storeId],
    )
    if (checkResult.rowCount === 0) {
      throw new AppError('الشيك غير موجود ضمن شيكات العملاء في هذا المتجر', 404, 'CHECK_NOT_FOUND')
    }

    const check = checkResult.rows[0]
    if (check.supplier_id || check.transferred_at) {
      throw new AppError('تم تحويل هذا الشيك إلى مورد مسبقاً', 409, 'CHECK_ALREADY_TRANSFERRED')
    }
    if (check.status !== 'pending') {
      throw new AppError('يمكن تحويل الشيك الموجود قيد التحصيل فقط', 409, 'CHECK_NOT_ON_HAND')
    }

    const supplierResult = await client.query(
      `
        SELECT id::TEXT AS id, name
        FROM suppliers
        WHERE id = $1::BIGINT AND is_active = TRUE
        FOR UPDATE
      `,
      [supplierId],
    )
    if (supplierResult.rowCount === 0) {
      throw new AppError('المورد غير موجود أو غير فعال', 404, 'SUPPLIER_NOT_FOUND')
    }
    const supplier = supplierResult.rows[0]
    const balanceResult = await client.query(
      'SELECT balance_ils::TEXT AS balance_ils FROM supplier_balances WHERE supplier_id = $1::BIGINT',
      [supplier.id],
    )
    const balance = new CheckDecimal(balanceResult.rows[0]?.balance_ils ?? '0')
    if (new CheckDecimal(check.amount).greaterThan(balance)) {
      throw new AppError(
        balance.greaterThan(0)
          ? `قيمة الشيك أكبر من دين المورد البالغ ₪${formatMoneyDisplay(balance)}`
          : 'لا يوجد دين مستحق لهذا المورد',
        409,
        'SUPPLIER_PAYMENT_EXCEEDS_DEBT',
      )
    }

    const updatedResult = await client.query(
      `
        UPDATE checks
        SET supplier_id = $1::BIGINT, transferred_at = $2::DATE
        WHERE id = $3::BIGINT
        RETURNING
          id::TEXT AS id,
          customer_id::TEXT AS customer_id,
          supplier_id::TEXT AS supplier_id,
          check_number,
          amount::TEXT AS amount,
          due_date::TEXT AS due_date,
          status,
          transferred_at::TEXT AS transferred_at,
          is_giro,
          original_owner_name,
          original_owner_phone
      `,
      [supplier.id, transferDate, check.id],
    )

    await client.query(
      `
        INSERT INTO supplier_ledger (
          store_id, supplier_id, direction, amount_ils, occurred_at,
          source_type, source_id, notes, created_by_user_id
        ) VALUES (
          $1::BIGINT, $2::BIGINT, 'debit', $3::NUMERIC, $4::DATE,
          'check_transfer', $5::BIGINT, $6, $7::BIGINT
        )
      `,
      [
        storeId,
        supplier.id,
        check.amount,
        transferDate,
        check.id,
        `تحويل شيك العميل رقم ${check.check_number} إلى المورد ${supplier.name}`,
        userId,
      ],
    )

    await writeAuditEntry(client, {
      storeId,
      userId,
      action: 'check_transfer',
      entityType: 'check',
      entityId: check.id,
      oldValues: { supplierId: null, transferredAt: null },
      newValues: { supplierId: supplier.id, transferredAt: transferDate },
    })
    await client.query('COMMIT')
    return { ...updatedResult.rows[0], supplier_name: supplier.name }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
