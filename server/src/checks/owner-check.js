import { pool } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'

export async function issueOwnerCheck({
  databasePool = pool,
  input,
  storeId,
  userId,
}) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')

    const supplierResult = await client.query(
      `
        SELECT id::TEXT AS id, name
        FROM suppliers
        WHERE id = $1::BIGINT AND is_active = TRUE
        FOR SHARE
      `,
      [input.supplierId],
    )
    if (supplierResult.rowCount === 0) {
      throw new AppError('المورد غير موجود أو غير فعال', 404, 'SUPPLIER_NOT_FOUND')
    }
    const supplier = supplierResult.rows[0]

    const checkResult = await client.query(
      `
        INSERT INTO checks (
          store_id, customer_id, supplier_id, check_number, bank_name,
          direction, status, amount, currency_code, due_date, notes,
          created_by_user_id, is_owner_issued
        ) VALUES (
          $1::BIGINT, NULL, $2::BIGINT, $3, NULL,
          'outflow', 'pending', $4::NUMERIC, 'ILS', $5::DATE, $6,
          $7::BIGINT, TRUE
        )
        RETURNING
          id::TEXT AS id,
          supplier_id::TEXT AS supplier_id,
          check_number,
          amount::TEXT AS amount,
          currency_code,
          due_date::TEXT AS due_date,
          status,
          notes,
          is_owner_issued,
          created_at
      `,
      [
        storeId,
        supplier.id,
        input.checkNumber,
        input.amount,
        input.dueDate,
        input.notes,
        userId,
      ],
    )
    const check = checkResult.rows[0]

    await client.query(
      `
        INSERT INTO supplier_ledger (
          store_id, supplier_id, direction, amount_ils, occurred_at,
          source_type, source_id, notes, created_by_user_id
        ) VALUES (
          $1::BIGINT, $2::BIGINT, 'debit', $3::NUMERIC, NOW(),
          'owner_check', $4::BIGINT, $5, $6::BIGINT
        )
      `,
      [
        storeId,
        supplier.id,
        check.amount,
        check.id,
        `إصدار شيك المنشأة رقم ${check.check_number} للمورد ${supplier.name}`,
        userId,
      ],
    )

    await client.query('COMMIT')
    return { ...check, supplier_name: supplier.name, customer_id: null, customer_name: null }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
