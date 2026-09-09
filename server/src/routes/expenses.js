import { Router } from 'express'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { createExpense } from '../expenses/create-expense.js'
import { DEFAULT_EXPENSE_CATEGORIES, parseExpenseInput } from '../expenses/expense-input.js'
import { requireStore } from '../middleware/require-store.js'

export const expensesRouter = Router()
expensesRouter.use(requireStore)

expensesRouter.get('/', async (request, response) => {
  const result = await query(
    `SELECT expenses.id::TEXT AS id, expenses.expense_category AS category,
      expenses.amount::TEXT AS amount, expenses.expense_date::TEXT AS date,
      expenses.payment_method, expenses.notes, stores.name AS store_name
     FROM expenses
     INNER JOIN stores ON stores.id = expenses.store_id
     WHERE expenses.store_id = $1::BIGINT AND expenses.status = 'recorded'
     ORDER BY expenses.expense_date DESC, expenses.id DESC LIMIT 100`,
    [request.storeId],
  )
  response.json({ categories: DEFAULT_EXPENSE_CATEGORIES, expenses: result.rows })
})

expensesRouter.post('/', async (request, response) => {
  const parsed = parseExpenseInput(request.body)
  if (parsed.error) throw new AppError(parsed.error, 400, 'INVALID_EXPENSE')
  const expense = await createExpense({
    input: parsed.value, storeId: request.storeId,
    userId: request.auth.user.id,
  })
  response.status(201).json({ expense })
})
