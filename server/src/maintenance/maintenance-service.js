import { pool } from '../db/pool.js'
import { writeAuditEntry } from '../audit/write-audit-entry.js'
import { AppError } from '../errors/app-error.js'
import { claimFinancialOperation } from '../financial/financial-operation.js'
import {
  insertCustomerLedgerMovement,
  insertIncomingPayment,
} from '../payments/payment-writer.js'
import { calculateSalePaymentBreakdown } from '../sales/sale-payment-input.js'

export async function createMaintenance({ databasePool = pool, input, storeId, userId, operation }) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    await claimFinancialOperation(client, { userId, operation })
    await requireStore(client, storeId)
    const customer = await requireCustomer(client, input.customerId)
    const paymentBreakdown = calculateSalePaymentBreakdown(
      input.payments,
      input.amount,
      input.customerId,
    )
    if (paymentBreakdown.error) {
      throw new AppError(paymentBreakdown.error, 400, 'INVALID_MAINTENANCE_PAYMENTS')
    }

    const result = await client.query(
      `
        INSERT INTO maintenance_records (
          store_id, customer_id, item_description, maintenance_details,
          amount_ils, business_date, paid_total_ils, remaining_due_ils,
          notes, created_by_user_id
        ) VALUES (
          $1::BIGINT, $2::BIGINT, $3, $4, $5::NUMERIC, $6::DATE,
          $7::NUMERIC, $8::NUMERIC, $9, $10::BIGINT
        )
        RETURNING
          id::TEXT AS id, store_id::TEXT AS store_id,
          customer_id::TEXT AS customer_id, item_description,
          maintenance_details, amount_ils::TEXT AS amount_ils,
          business_date::TEXT AS business_date,
          paid_total_ils::TEXT AS paid_total_ils,
          remaining_due_ils::TEXT AS remaining_due_ils,
          notes, created_at
      `,
      [
        storeId,
        input.customerId,
        input.itemDescription,
        input.maintenanceDetails,
        input.amount,
        input.businessDate,
        paymentBreakdown.value.paidTotal,
        paymentBreakdown.value.remainingDue,
        input.notes,
        userId,
      ],
    )
    const maintenance = result.rows[0]

    if (input.customerId) {
      await insertCustomerLedgerMovement(client, {
        storeId,
        customerId: input.customerId,
        direction: 'debit',
        amountIls: input.amount,
        sourceType: 'maintenance',
        sourceId: maintenance.id,
        notes: `صيانة — ${input.itemDescription}`,
        userId,
      })
    }

    const savedPayments = []
    for (const payment of paymentBreakdown.value.payments) {
      const savedPayment = await insertIncomingPayment(client, {
        payment,
        storeId,
        customerId: input.customerId,
        maintenanceId: maintenance.id,
        contextLabel: `دفعة صيانة — ${input.itemDescription}`,
        movementSourceType: 'maintenance_payment',
        userId,
      })
      savedPayments.push(savedPayment)

      if (input.customerId) {
        await insertCustomerLedgerMovement(client, {
          storeId,
          customerId: input.customerId,
          direction: 'credit',
          amountIls: payment.convertedIlsAmount,
          sourceType: payment.method === 'check' ? 'maintenance_check' : 'maintenance_payment',
          sourceId: savedPayment.id,
          notes: `دفعة صيانة — ${input.itemDescription}`,
          userId,
        })
      }
    }

    await writeAuditEntry(client, {
      storeId,
      userId,
      action: 'maintenance',
      entityType: 'maintenance',
      entityId: maintenance.id,
      newValues: {
        customerId: input.customerId,
        itemDescription: input.itemDescription,
        amountIls: input.amount,
        paidTotalIls: paymentBreakdown.value.paidTotal,
        remainingDueIls: paymentBreakdown.value.remainingDue,
      },
    })
    for (const payment of savedPayments) {
      await writeAuditEntry(client, {
        storeId,
        userId,
        action: 'payment',
        entityType: payment.method === 'check' ? 'check' : 'payment',
        entityId: payment.id,
        newValues: {
          maintenanceId: maintenance.id,
          method: payment.method,
          amountIls: payment.converted_ils_amount,
        },
      })
    }
    await client.query('COMMIT')
    return { ...maintenance, customer_name: customer?.name ?? null, reversed_at: null, payments: savedPayments }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function reverseMaintenance({
  databasePool = pool,
  maintenanceId,
  reason,
  storeId,
  userId,
  operation,
}) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    await claimFinancialOperation(client, { userId, operation })
    await requireStore(client, storeId)
    const originalResult = await client.query(
      `
        SELECT
          maintenance_records.id::TEXT AS id,
          maintenance_records.customer_id::TEXT AS customer_id,
          maintenance_records.item_description,
          maintenance_records.amount_ils::TEXT AS amount_ils,
          maintenance_records.paid_total_ils::TEXT AS paid_total_ils,
          maintenance_records.remaining_due_ils::TEXT AS remaining_due_ils
        FROM maintenance_records
        WHERE maintenance_records.id = $1::BIGINT
          AND maintenance_records.store_id = $2::BIGINT
        FOR UPDATE
      `,
      [maintenanceId, storeId],
    )
    if (originalResult.rowCount === 0) {
      throw new AppError('سجل الصيانة غير موجود في هذا المتجر', 404, 'MAINTENANCE_NOT_FOUND')
    }
    const original = originalResult.rows[0]
    await lockExistingCustomer(client, original.customer_id)

    const reversalResult = await client.query(
      `
        INSERT INTO maintenance_reversals (
          maintenance_id, store_id, reason, created_by_user_id
        ) VALUES ($1::BIGINT, $2::BIGINT, $3, $4::BIGINT)
        RETURNING id::TEXT AS id, maintenance_id::TEXT AS maintenance_id,
                  store_id::TEXT AS store_id, reason, created_at
      `,
      [maintenanceId, storeId, reason, userId],
    )
    const reversal = reversalResult.rows[0]

    if (original.customer_id) {
      await insertCustomerLedgerMovement(client, {
        storeId,
        customerId: original.customer_id,
        direction: 'credit',
        amountIls: original.amount_ils,
        sourceType: 'maintenance_reversal',
        sourceId: reversal.id,
        notes: `عكس صيانة — ${original.item_description}`,
        userId,
      })
    }

    const originalPayments = await client.query(
      `
        SELECT id::TEXT AS id, customer_id::TEXT AS customer_id,
               original_amount::TEXT AS original_amount, currency_code,
               exchange_rate::TEXT AS exchange_rate,
               converted_ils_amount::TEXT AS converted_ils_amount,
               payment_method, reference
        FROM payments
        WHERE maintenance_id = $1::BIGINT AND store_id = $2::BIGINT
        ORDER BY id
      `,
      [maintenanceId, storeId],
    )
    for (const payment of originalPayments.rows) {
      const reversedPaymentId = await reverseCashOrBankPayment(client, {
        payment,
        reversalId: reversal.id,
        storeId,
        userId,
        itemDescription: original.item_description,
      })
      if (original.customer_id) {
        await insertCustomerLedgerMovement(client, {
          storeId,
          customerId: original.customer_id,
          direction: 'debit',
          amountIls: payment.converted_ils_amount,
          sourceType: 'maintenance_reversal_payment',
          sourceId: reversedPaymentId,
          notes: `عكس دفعة صيانة — ${original.item_description}`,
          userId,
        })
      }
    }

    const originalChecks = await client.query(
      `
        SELECT id::TEXT AS id, customer_id::TEXT AS customer_id,
               check_number, bank_name, amount::TEXT AS amount,
               due_date::TEXT AS due_date, status,
               supplier_id::TEXT AS supplier_id,
               transferred_at::TEXT AS transferred_at, is_giro,
               original_owner_name, original_owner_phone
        FROM checks
        WHERE maintenance_id = $1::BIGINT AND store_id = $2::BIGINT
        ORDER BY id
      `,
      [maintenanceId, storeId],
    )
    if (originalChecks.rows.some((check) => check.transferred_at && check.status !== 'bounced')) {
      throw new AppError(
        'لا يمكن عكس الصيانة ما دام أحد شيكاتها محولاً إلى مورد ولم يُعكس ارتجاعه',
        409,
        'MAINTENANCE_CHECK_TRANSFER_ACTIVE',
      )
    }
    for (const check of originalChecks.rows) {
      // A bounced check already has an append-only customer debit (and, when
      // transferred, a supplier credit). Reversing that payment a second time
      // would recreate debt after the maintenance charge is removed.
      if (check.status === 'bounced') continue

      const reversedCheckId = await reverseCheck(client, {
        check,
        reversalId: reversal.id,
        storeId,
        userId,
        itemDescription: original.item_description,
      })
      if (original.customer_id) {
        await insertCustomerLedgerMovement(client, {
          storeId,
          customerId: original.customer_id,
          direction: 'debit',
          amountIls: check.amount,
          sourceType: 'maintenance_reversal_check',
          sourceId: reversedCheckId,
          notes: `عكس شيك صيانة — ${original.item_description}`,
          userId,
        })
      }
      if (check.status === 'pending') {
        await client.query(
          `UPDATE checks
           SET status = 'reversed', reminder_snoozed_until = NULL
           WHERE id = $1::BIGINT AND status = 'pending'`,
          [check.id],
        )
      }
    }

    await writeAuditEntry(client, {
      storeId,
      userId,
      action: 'maintenance_reversal',
      entityType: 'maintenance',
      entityId: maintenanceId,
      oldValues: original,
      newValues: { reversalId: reversal.id, reason },
    })
    await client.query('COMMIT')
    return reversal
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error?.code === '23505' && error?.constraint === 'maintenance_reversals_maintenance_id_key') {
      throw new AppError('تم عكس سجل الصيانة مسبقاً', 409, 'MAINTENANCE_ALREADY_REVERSED')
    }
    throw error
  } finally {
    client.release()
  }
}

async function requireStore(client, storeId) {
  const result = await client.query(
    'SELECT id FROM stores WHERE id = $1::BIGINT AND is_active = TRUE FOR SHARE',
    [storeId],
  )
  if (result.rowCount === 0) {
    throw new AppError('المتجر غير موجود أو غير فعال', 404, 'STORE_NOT_FOUND')
  }
}

async function requireCustomer(client, customerId) {
  if (!customerId) return null
  const result = await client.query(
    'SELECT id::TEXT AS id, name FROM customers WHERE id = $1::BIGINT AND is_active = TRUE FOR UPDATE',
    [customerId],
  )
  if (result.rowCount === 0) {
    throw new AppError('العميل غير موجود أو غير فعال', 404, 'MAINTENANCE_CUSTOMER_NOT_FOUND')
  }
  return result.rows[0]
}

async function lockExistingCustomer(client, customerId) {
  if (!customerId) return
  const result = await client.query(
    'SELECT id FROM customers WHERE id = $1::BIGINT FOR UPDATE',
    [customerId],
  )
  if (result.rowCount === 0) {
    throw new AppError('العميل المرتبط بسجل الصيانة غير موجود', 409, 'MAINTENANCE_CUSTOMER_MISSING')
  }
}

async function reverseCashOrBankPayment(
  client,
  { payment, reversalId, storeId, userId, itemDescription },
) {
  const result = await client.query(
    `
      INSERT INTO payments (
        store_id, customer_id, supplier_id, sale_id, purchase_id, direction,
        original_amount, currency_code, exchange_rate, converted_ils_amount,
        payment_method, reference, paid_at, notes, created_by_user_id,
        maintenance_id, maintenance_reversal_id
      ) VALUES (
        $1::BIGINT, $2::BIGINT, NULL, NULL, NULL, 'outflow',
        $3::NUMERIC, $4, $5::NUMERIC, $6::NUMERIC,
        $7, $8, NOW(), $9, $10::BIGINT, NULL, $11::BIGINT
      )
      RETURNING id::TEXT AS id
    `,
    [
      storeId, payment.customer_id, payment.original_amount, payment.currency_code,
      payment.exchange_rate, payment.converted_ils_amount, payment.payment_method,
      payment.reference, `عكس دفعة صيانة — ${itemDescription}`, userId, reversalId,
    ],
  )
  const reversedPaymentId = result.rows[0].id
  if (payment.payment_method === 'cash') {
    await client.query(
      `
        INSERT INTO financial_movements (
          store_id, direction, amount, currency_code, occurred_at,
          source_type, source_id, description, created_by_user_id
        ) VALUES (
          $1::BIGINT, 'outflow', $2::NUMERIC, $3, NOW(),
          'maintenance_reversal_payment', $4::BIGINT, $5, $6::BIGINT
        )
      `,
      [storeId, payment.original_amount, payment.currency_code, reversedPaymentId,
        `عكس نقد صيانة — ${itemDescription}`, userId],
    )
  } else {
    await client.query(
      `
        INSERT INTO bank_movements (
          store_id, direction, amount_ils, occurred_at,
          source_type, source_id, description, created_by_user_id
        ) VALUES (
          $1::BIGINT, 'outflow', $2::NUMERIC, NOW(),
          'maintenance_reversal_payment', $3::BIGINT, $4, $5::BIGINT
        )
      `,
      [storeId, payment.converted_ils_amount, reversedPaymentId,
        `عكس دفعة بنك صيانة — ${itemDescription}`, userId],
    )
  }
  return reversedPaymentId
}

async function reverseCheck(
  client,
  { check, reversalId, storeId, userId, itemDescription },
) {
  const result = await client.query(
    `
      INSERT INTO checks (
        store_id, customer_id, supplier_id, sale_id, check_number, bank_name,
        direction, status, amount, currency_code, due_date, notes,
        created_by_user_id, maintenance_id, maintenance_reversal_id,
        is_giro, original_owner_name, original_owner_phone
      ) VALUES (
        $1::BIGINT, $2::BIGINT, NULL, NULL, $3, $4,
        'outflow', 'reversed', $5::NUMERIC, 'ILS', $6::DATE, $7,
        $8::BIGINT, NULL, $9::BIGINT, $10::BOOLEAN, $11, $12
      )
      RETURNING id::TEXT AS id
    `,
    [
      storeId, check.customer_id, check.check_number, check.bank_name,
      check.amount, check.due_date, `عكس شيك صيانة — ${itemDescription}`,
      userId, reversalId, check.is_giro === true,
      check.is_giro === true ? check.original_owner_name : null,
      check.is_giro === true ? check.original_owner_phone : null,
    ],
  )
  return result.rows[0].id
}
