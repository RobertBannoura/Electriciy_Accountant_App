import Decimal from 'decimal.js'
import { AppError } from '../errors/app-error.js'

const PaymentDecimal = Decimal.clone({ precision: 100 })

export async function prepareSupplierPayments(client, { payments, storeId }) {
  const checkIds = payments
    .filter((payment) => payment.method === 'transferred_customer_check')
    .map((payment) => payment.checkId)
    .sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1)

  let checks = new Map()
  if (checkIds.length > 0) {
    const result = await client.query(
      `
        SELECT id::TEXT AS id, check_number, amount::TEXT AS amount
        FROM checks
        WHERE store_id = $1::BIGINT
          AND id = ANY($2::BIGINT[])
          AND customer_id IS NOT NULL
          AND direction = 'inflow'
          AND status = 'pending'
          AND supplier_id IS NULL
          AND transferred_at IS NULL
        ORDER BY id
        FOR UPDATE
      `,
      [storeId, checkIds],
    )
    if (result.rowCount !== checkIds.length) {
      throw new AppError(
        'أحد شيكات العملاء غير موجود أو لم يعد متاحاً للتحويل',
        409,
        'CUSTOMER_CHECK_NOT_TRANSFERABLE',
      )
    }
    checks = new Map(result.rows.map((row) => [row.id, row]))
  }

  let total = new PaymentDecimal(0)
  const prepared = payments.map((payment) => {
    const amount = payment.method === 'transferred_customer_check'
      ? checks.get(payment.checkId).amount
      : payment.amount
    total = total.plus(amount)
    return { ...payment, amount }
  })
  return { payments: prepared, total: total.toFixed() }
}

export async function writeSupplierPayments(
  client,
  { payments, storeId, supplier, purchaseId = null, occurredAt, notes, userId },
) {
  const saved = []
  for (const payment of payments) {
    let result
    if (payment.method === 'cash' || payment.method === 'bank') {
      result = await writeCashOrBank(client, {
        payment, storeId, supplier, purchaseId, occurredAt, notes, userId,
      })
    } else if (payment.method === 'owner_check') {
      result = await writeOwnerCheck(client, {
        payment, storeId, supplier, purchaseId, occurredAt, notes, userId,
      })
    } else {
      result = await transferCustomerCheck(client, {
        payment, storeId, supplier, purchaseId, occurredAt, userId,
      })
    }
    saved.push(result)
  }
  return saved
}

async function writeCashOrBank(
  client,
  { payment, storeId, supplier, purchaseId, occurredAt, notes, userId },
) {
  const method = payment.method === 'bank' ? 'bank_card' : 'cash'
  const context = purchaseId ? `دفعة فاتورة شراء للمورد ${supplier.name}` : `دفعة للمورد ${supplier.name}`
  const result = await client.query(
    `
      INSERT INTO payments (
        store_id, customer_id, supplier_id, sale_id, purchase_id, direction,
        original_amount, currency_code, exchange_rate, converted_ils_amount,
        payment_method, reference, paid_at, notes, created_by_user_id
      ) VALUES (
        $1::BIGINT, NULL, $2::BIGINT, NULL, $3::BIGINT, 'outflow',
        $4::NUMERIC, 'ILS', NULL, $4::NUMERIC,
        $5, $6, $7::TIMESTAMPTZ, $8, $9::BIGINT
      )
      RETURNING id::TEXT AS id, payment_method AS method,
        original_amount::TEXT AS amount, converted_ils_amount::TEXT AS converted_ils_amount
    `,
    [storeId, supplier.id, purchaseId, payment.amount, method, payment.reference, occurredAt, notes ?? context, userId],
  )
  const saved = result.rows[0]
  const sourceType = purchaseId ? 'purchase_payment' : 'supplier_payment'
  if (payment.method === 'cash') {
    await client.query(
      `
        INSERT INTO financial_movements (
          store_id, direction, amount, currency_code, occurred_at,
          source_type, source_id, description, created_by_user_id
        ) VALUES ($1::BIGINT, 'outflow', $2::NUMERIC, 'ILS', $3::TIMESTAMPTZ,
          $4, $5::BIGINT, $6, $7::BIGINT)
      `,
      [storeId, payment.amount, occurredAt, sourceType, saved.id, `نقد — ${context}`, userId],
    )
  } else {
    await client.query(
      `
        INSERT INTO bank_movements (
          store_id, direction, amount_ils, occurred_at,
          source_type, source_id, description, created_by_user_id
        ) VALUES ($1::BIGINT, 'outflow', $2::NUMERIC, $3::TIMESTAMPTZ,
          $4, $5::BIGINT, $6, $7::BIGINT)
      `,
      [storeId, payment.amount, occurredAt, sourceType, saved.id, `بنك — ${context}`, userId],
    )
  }
  await insertSupplierDebit(client, {
    storeId, supplierId: supplier.id, amount: payment.amount,
    sourceType, sourceId: saved.id, occurredAt, notes: notes ?? context, userId,
  })
  return saved
}

async function writeOwnerCheck(client, { payment, storeId, supplier, purchaseId, occurredAt, notes, userId }) {
  const result = await client.query(
    `
      INSERT INTO checks (
        store_id, customer_id, supplier_id, sale_id, purchase_id,
        check_number, bank_name, direction, status, amount, currency_code,
        due_date, notes, created_by_user_id, is_owner_issued
      ) VALUES (
        $1::BIGINT, NULL, $2::BIGINT, NULL, $3::BIGINT,
        $4, NULL, 'outflow', 'pending', $5::NUMERIC, 'ILS',
        $6::DATE, $7, $8::BIGINT, TRUE
      )
      RETURNING id::TEXT AS id, 'owner_check'::TEXT AS method,
        amount::TEXT AS amount, check_number, due_date::TEXT AS due_date, status
    `,
    [storeId, supplier.id, purchaseId, payment.checkNumber, payment.amount, payment.dueDate, payment.notes ?? notes, userId],
  )
  const saved = result.rows[0]
  await insertSupplierDebit(client, {
    storeId, supplierId: supplier.id, amount: payment.amount,
    sourceType: 'owner_check', sourceId: saved.id, occurredAt,
    notes: notes ?? `إصدار شيك المنشأة رقم ${payment.checkNumber} للمورد ${supplier.name}`, userId,
  })
  return saved
}

async function transferCustomerCheck(
  client,
  { payment, storeId, supplier, purchaseId, occurredAt, userId },
) {
  const result = await client.query(
    `
      UPDATE checks
      SET supplier_id = $1::BIGINT,
          transferred_at = $2::TIMESTAMPTZ::DATE,
          purchase_id = $3::BIGINT
      WHERE id = $4::BIGINT
      RETURNING id::TEXT AS id, 'transferred_customer_check'::TEXT AS method,
        amount::TEXT AS amount, check_number, due_date::TEXT AS due_date, status
    `,
    [supplier.id, occurredAt, purchaseId, payment.checkId],
  )
  const saved = result.rows[0]
  await insertSupplierDebit(client, {
    storeId, supplierId: supplier.id, amount: payment.amount,
    sourceType: 'check_transfer', sourceId: saved.id, occurredAt,
    notes: `تحويل شيك العميل رقم ${saved.check_number} إلى المورد ${supplier.name}`, userId,
  })
  return saved
}

export async function insertSupplierCredit(
  client,
  { storeId, supplierId, amount, sourceId, occurredAt, notes, userId },
) {
  await client.query(
    `
      INSERT INTO supplier_ledger (
        store_id, supplier_id, direction, amount_ils, occurred_at,
        source_type, source_id, notes, created_by_user_id
      ) VALUES ($1::BIGINT, $2::BIGINT, 'credit', $3::NUMERIC, $4::TIMESTAMPTZ,
        'purchase', $5::BIGINT, $6, $7::BIGINT)
    `,
    [storeId, supplierId, amount, occurredAt, sourceId, notes, userId],
  )
}

async function insertSupplierDebit(
  client,
  { storeId, supplierId, amount, sourceType, sourceId, occurredAt, notes, userId },
) {
  await client.query(
    `
      INSERT INTO supplier_ledger (
        store_id, supplier_id, direction, amount_ils, occurred_at,
        source_type, source_id, notes, created_by_user_id
      ) VALUES ($1::BIGINT, $2::BIGINT, 'debit', $3::NUMERIC, $6::TIMESTAMPTZ,
        $4, $5::BIGINT, $7, $8::BIGINT)
    `,
    [storeId, supplierId, amount, sourceType, sourceId, occurredAt, notes, userId],
  )
}
