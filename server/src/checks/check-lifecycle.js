import { pool } from '../db/pool.js'
import { writeAuditEntry } from '../audit/write-audit-entry.js'
import { AppError } from '../errors/app-error.js'
import { claimFinancialOperation } from '../financial/financial-operation.js'

export async function clearCheck({ databasePool = pool, checkId, storeId, userId = null, operation }) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    await claimFinancialOperation(client, { userId, operation })
    const check = await lockOperationalCheck(client, checkId, storeId)

    if (check.status === 'bounced') {
      throw new AppError('لا يمكن تحصيل شيك مسجل كمرتجع', 409, 'BOUNCED_CHECK_CANNOT_CLEAR')
    }
    if (check.status === 'pending') {
      await client.query(
        `
          UPDATE checks
          SET status = 'cleared', cleared_at = NOW(), reminder_snoozed_until = NULL
          WHERE id = $1::BIGINT
        `,
        [check.id],
      )
      await writeAuditEntry(client, {
        storeId,
        userId,
        action: 'check_status_change',
        entityType: 'check',
        entityId: check.id,
        oldValues: { status: 'pending' },
        newValues: { status: 'cleared' },
      })
    }

    await client.query('COMMIT')
    return { ...check, status: 'cleared' }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function bounceCheck({
  databasePool = pool,
  checkId,
  storeId,
  userId,
  operation,
}) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    await claimFinancialOperation(client, { userId, operation })
    const check = await lockOperationalCheck(client, checkId, storeId)

    if (check.status === 'cleared') {
      throw new AppError('لا يمكن إرجاع شيك تم تحصيله', 409, 'CLEARED_CHECK_CANNOT_BOUNCE')
    }

    if (check.customer_id) {
      await client.query(
        `
          INSERT INTO customer_ledger (
            store_id, customer_id, direction, amount_ils, occurred_at,
            source_type, source_id, notes, created_by_user_id
          ) VALUES (
            $1::BIGINT, $2::BIGINT, 'debit', $3::NUMERIC, NOW(),
            'check_bounce', $4::BIGINT, $5, $6::BIGINT
          )
          ON CONFLICT (source_id) WHERE source_type = 'check_bounce' DO NOTHING
        `,
        [
          storeId,
          check.customer_id,
          check.amount,
          check.id,
          `عكس دفعة الشيك المرتجع رقم ${check.check_number}`,
          userId,
        ],
      )
    }

    if (check.customer_id && check.supplier_id && check.transferred_at) {
      await client.query(
        `
          INSERT INTO supplier_ledger (
            store_id, supplier_id, direction, amount_ils, occurred_at,
            source_type, source_id, notes, created_by_user_id
          ) VALUES (
            $1::BIGINT, $2::BIGINT, 'credit', $3::NUMERIC, NOW(),
            'check_transfer_bounce', $4::BIGINT, $5, $6::BIGINT
          )
          ON CONFLICT (source_id) WHERE source_type = 'check_transfer_bounce' DO NOTHING
        `,
        [
          storeId,
          check.supplier_id,
          check.amount,
          check.id,
          `عكس تحويل الشيك المرتجع رقم ${check.check_number} إلى المورد`,
          userId,
        ],
      )
    }

    if (check.is_owner_issued) {
      await client.query(
        `
          INSERT INTO supplier_ledger (
            store_id, supplier_id, direction, amount_ils, occurred_at,
            source_type, source_id, notes, created_by_user_id
          ) VALUES (
            $1::BIGINT, $2::BIGINT, 'credit', $3::NUMERIC, NOW(),
            'owner_check_bounce', $4::BIGINT, $5, $6::BIGINT
          )
          ON CONFLICT (source_id) WHERE source_type = 'owner_check_bounce' DO NOTHING
        `,
        [
          storeId,
          check.supplier_id,
          check.amount,
          check.id,
          `عكس شيك المنشأة المرتجع رقم ${check.check_number}`,
          userId,
        ],
      )
    }

    await client.query(
      `
        UPDATE checks
        SET
          status = 'bounced',
          bounced_at = COALESCE(bounced_at, NOW()),
          reminder_snoozed_until = NULL
        WHERE id = $1::BIGINT
      `,
      [check.id],
    )

    if (check.status === 'pending') {
      await writeAuditEntry(client, {
        storeId,
        userId,
        action: 'check_status_change',
        entityType: 'check',
        entityId: check.id,
        oldValues: { status: 'pending' },
        newValues: { status: 'bounced' },
      })
      await writeAuditEntry(client, {
        storeId,
        userId,
        action: 'bounced_reversal',
        entityType: 'check',
        entityId: check.id,
        newValues: {
          customerReversal: Boolean(check.customer_id),
          supplierTransferReversal: Boolean(check.customer_id && check.supplier_id && check.transferred_at),
          ownerSupplierReversal: Boolean(check.is_owner_issued),
          amountIls: check.amount,
        },
      })
    }

    await client.query('COMMIT')
    return { ...check, status: 'bounced' }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function lockOperationalCheck(client, checkId, storeId) {
  const result = await client.query(
    `
      SELECT
        checks.id::TEXT AS id,
        checks.customer_id::TEXT AS customer_id,
        checks.supplier_id::TEXT AS supplier_id,
        checks.check_number,
        checks.amount::TEXT AS amount,
        checks.status,
        checks.transferred_at::TEXT AS transferred_at,
        checks.is_owner_issued,
        customers.name AS customer_name,
        suppliers.name AS supplier_name
      FROM checks
      LEFT JOIN customers ON customers.id = checks.customer_id
      LEFT JOIN suppliers ON suppliers.id = checks.supplier_id
      WHERE checks.id = $1::BIGINT
        AND checks.store_id = $2::BIGINT
        AND (
          (checks.customer_id IS NOT NULL AND checks.direction = 'inflow')
          OR checks.is_owner_issued = TRUE
        )
      FOR UPDATE OF checks
    `,
    [checkId, storeId],
  )
  if (result.rowCount === 0) {
    throw new AppError('الشيك غير موجود في هذا المتجر', 404, 'CHECK_NOT_FOUND')
  }
  return result.rows[0]
}
