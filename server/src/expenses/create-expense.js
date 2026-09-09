import { pool } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'

export async function createExpense({ databasePool = pool, input, storeId, userId }) {
  const client = await databasePool.connect()
  try {
    await client.query('BEGIN')
    const storeResult = await client.query(
      'SELECT id FROM stores WHERE id = $1::BIGINT AND is_active = TRUE FOR SHARE',
      [storeId],
    )
    if (storeResult.rowCount === 0) throw new AppError('المتجر غير موجود أو غير فعال', 404, 'STORE_NOT_FOUND')
    const result = await client.query(
      `INSERT INTO expenses (
        store_id, description, expense_category, amount, currency_code,
        expense_date, payment_method, status, notes, created_by_user_id
       ) VALUES ($1::BIGINT, $2, $2, $3::NUMERIC, 'ILS', $4::DATE,
        $5, 'recorded', $6, $7::BIGINT)
       RETURNING id::TEXT AS id, store_id::TEXT AS store_id,
        expense_category AS category, amount::TEXT AS amount,
        expense_date::TEXT AS date, payment_method, notes, created_at`,
      [storeId, input.category, input.amount, input.expenseDate,
        input.paymentMethod, input.notes, userId],
    )
    const expense = result.rows[0]
    if (input.paymentMethod === 'cash') {
      await client.query(
        `INSERT INTO financial_movements (
          store_id, direction, amount, currency_code, occurred_at,
          source_type, source_id, description, created_by_user_id
         ) VALUES ($1::BIGINT, 'outflow', $2::NUMERIC, 'ILS', $3::DATE,
          'expense', $4::BIGINT, $5, $6::BIGINT)`,
        [storeId, input.amount, input.expenseDate, expense.id,
          `مصروف — ${input.category}`, userId],
      )
    } else {
      await client.query(
        `INSERT INTO bank_movements (
          store_id, direction, amount_ils, occurred_at,
          source_type, source_id, description, created_by_user_id
         ) VALUES ($1::BIGINT, 'outflow', $2::NUMERIC, $3::DATE,
          'expense', $4::BIGINT, $5, $6::BIGINT)`,
        [storeId, input.amount, input.expenseDate, expense.id,
          `مصروف — ${input.category}`, userId],
      )
    }
    await client.query('COMMIT')
    return expense
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
