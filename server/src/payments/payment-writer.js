import Decimal from 'decimal.js'

const LedgerDecimal = Decimal.clone({ precision: 100 })

export async function insertIncomingPayment(
  client,
  {
    payment,
    storeId,
    customerId,
    saleId = null,
    maintenanceId = null,
    maintenanceReversalId = null,
    contextLabel,
    movementSourceType,
    userId,
  },
) {
  if (payment.method === 'check') {
    return insertIncomingCheck(client, {
      payment,
      storeId,
      customerId,
      saleId,
      maintenanceId,
      maintenanceReversalId,
      contextLabel,
      userId,
    })
  }

  const result = await client.query(
    `
      INSERT INTO payments (
        store_id, customer_id, supplier_id, sale_id, purchase_id, direction,
        original_amount, currency_code, exchange_rate, converted_ils_amount,
        payment_method, reference, paid_at, notes, created_by_user_id,
        maintenance_id, maintenance_reversal_id
      ) VALUES (
        $1::BIGINT, $2::BIGINT, NULL, $3::BIGINT, NULL, 'inflow',
        $4::NUMERIC, $5, $6::NUMERIC, $7::NUMERIC,
        $8, $9, NOW(), $10, $11::BIGINT, $12::BIGINT, $13::BIGINT
      )
      RETURNING
        id::TEXT AS id,
        payment_method AS method,
        currency_code AS currency,
        original_amount::TEXT AS original_amount,
        exchange_rate::TEXT AS exchange_rate,
        converted_ils_amount::TEXT AS converted_ils_amount,
        reference
    `,
    [
      storeId,
      customerId,
      saleId,
      payment.originalAmount,
      payment.currency,
      payment.exchangeRate,
      payment.convertedIlsAmount,
      payment.method,
      payment.reference,
      contextLabel,
      userId,
      maintenanceId,
      maintenanceReversalId,
    ],
  )
  const savedPayment = result.rows[0]

  if (payment.method === 'cash') {
    await client.query(
      `
        INSERT INTO financial_movements (
          store_id, direction, amount, currency_code, occurred_at,
          source_type, source_id, description, created_by_user_id
        ) VALUES (
          $1::BIGINT, 'inflow', $2::NUMERIC, $3, NOW(),
          $4, $5::BIGINT, $6, $7::BIGINT
        )
      `,
      [
        storeId,
        payment.originalAmount,
        payment.currency,
        movementSourceType,
        savedPayment.id,
        `نقد — ${contextLabel}`,
        userId,
      ],
    )
  } else {
    await client.query(
      `
        INSERT INTO bank_movements (
          store_id, direction, amount_ils, occurred_at,
          source_type, source_id, description, created_by_user_id
        ) VALUES (
          $1::BIGINT, 'inflow', $2::NUMERIC, NOW(),
          $3, $4::BIGINT, $5, $6::BIGINT
        )
      `,
      [
        storeId,
        payment.convertedIlsAmount,
        movementSourceType,
        savedPayment.id,
        `بطاقة / بنك — ${contextLabel}`,
        userId,
      ],
    )
  }

  return savedPayment
}

export async function insertCustomerLedgerMovement(
  client,
  { storeId, customerId, direction, amountIls, sourceType, sourceId, notes, userId },
) {
  if (new LedgerDecimal(amountIls).isZero()) return

  await client.query(
    `
      INSERT INTO customer_ledger (
        store_id, customer_id, direction, amount_ils, occurred_at,
        source_type, source_id, notes, created_by_user_id
      ) VALUES (
        $1::BIGINT, $2::BIGINT, $3, $4::NUMERIC, NOW(),
        $5, $6::BIGINT, $7, $8::BIGINT
      )
    `,
    [storeId, customerId, direction, amountIls, sourceType, sourceId, notes, userId],
  )
}

async function insertIncomingCheck(
  client,
  {
    payment, storeId, customerId, saleId, maintenanceId,
    maintenanceReversalId, contextLabel, userId,
  },
) {
  const result = await client.query(
    `
      INSERT INTO checks (
        store_id, customer_id, supplier_id, sale_id, check_number, bank_name,
        direction, status, amount, currency_code, due_date, notes,
        created_by_user_id, maintenance_id, maintenance_reversal_id,
        is_giro, original_owner_name, original_owner_phone
      ) VALUES (
        $1::BIGINT, $2::BIGINT, NULL, $3::BIGINT, $4, $5,
        'inflow', 'pending', $6::NUMERIC, 'ILS', $7::DATE, $8,
        $9::BIGINT, $10::BIGINT, $11::BIGINT, $12::BOOLEAN, $13, $14
      )
      RETURNING
        id::TEXT AS id,
        'check'::TEXT AS method,
        currency_code AS currency,
        amount::TEXT AS original_amount,
        NULL::TEXT AS exchange_rate,
        amount::TEXT AS converted_ils_amount,
        check_number,
        bank_name,
        due_date::TEXT AS due_date,
        status,
        is_giro,
        original_owner_name,
        original_owner_phone
    `,
    [
      storeId,
      customerId,
      saleId,
      payment.checkNumber,
      payment.bankName,
      payment.originalAmount,
      payment.dueDate,
      payment.notes ?? contextLabel,
      userId,
      maintenanceId,
      maintenanceReversalId,
      payment.isGiro === true,
      payment.isGiro === true ? payment.originalOwnerName : null,
      payment.isGiro === true ? payment.originalOwnerPhone : null,
    ],
  )
  return result.rows[0]
}
