import { Router } from 'express'
import { bounceCheck, clearCheck } from '../checks/check-lifecycle.js'
import { currentBusinessDate, getCheckReminders } from '../checks/check-reminders.js'
import { parseOwnerCheckInput, parseReminderSettingsInput } from '../checks/check-input.js'
import { issueOwnerCheck } from '../checks/owner-check.js'
import { parseCheckTransferInput } from '../checks/check-transfer-input.js'
import { transferCheckToSupplier } from '../checks/transfer-check.js'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { requireStore } from '../middleware/require-store.js'
import { normalizeOptionalText, parseId } from '../products/product-input.js'
import { notifyCheckBounced } from '../notifications/financial-notifications.js'

const CUSTOMER_CHECK_STATUSES = new Set(['pending', 'cleared', 'bounced'])

export const checksRouter = Router()

checksRouter.use(requireStore)

checksRouter.get('/', async (request, response) => {
  const requestedStatus = normalizeOptionalText(request.query.status, 20)
  if (request.query.status && !CUSTOMER_CHECK_STATUSES.has(requestedStatus)) {
    throw new AppError('حالة الشيك غير صالحة', 400, 'INVALID_CHECK_STATUS')
  }

  const search = normalizeOptionalText(request.query.search, 150)
  if (request.query.search && !search) {
    throw new AppError('نص البحث غير صالح', 400, 'INVALID_CHECK_SEARCH')
  }

  const result = await query(
    `
      SELECT
        checks.id::TEXT AS id,
        checks.check_number,
        checks.amount::TEXT AS amount,
        checks.currency_code,
        checks.due_date::TEXT AS due_date,
        checks.status,
        checks.notes,
        checks.is_giro,
        checks.original_owner_name,
        checks.original_owner_phone,
        checks.is_owner_issued,
        checks.bounced_reminder_stopped_at,
        checks.supplier_id::TEXT AS supplier_id,
        checks.transferred_at::TEXT AS transferred_at,
        suppliers.name AS supplier_name,
        checks.sale_id::TEXT AS sale_id,
        checks.purchase_id::TEXT AS purchase_id,
        checks.maintenance_id::TEXT AS maintenance_id,
        checks.created_at,
        customers.id::TEXT AS customer_id,
        customers.name AS customer_name
      FROM checks
      LEFT JOIN customers ON customers.id = checks.customer_id
      LEFT JOIN suppliers ON suppliers.id = checks.supplier_id
      WHERE checks.store_id = $1::BIGINT
        AND (
          (checks.direction = 'inflow' AND checks.customer_id IS NOT NULL)
          OR checks.is_owner_issued = TRUE
        )
        AND ($2::TEXT IS NULL OR checks.status = $2)
        AND (
          $3::TEXT IS NULL
          OR POSITION(LOWER($3) IN LOWER(checks.check_number)) > 0
          OR POSITION(LOWER($3) IN LOWER(COALESCE(customers.name, ''))) > 0
          OR POSITION(LOWER($3) IN LOWER(COALESCE(suppliers.name, ''))) > 0
          OR POSITION(LOWER($3) IN LOWER(COALESCE(checks.original_owner_name, ''))) > 0
          OR POSITION(LOWER($3) IN LOWER(COALESCE(checks.original_owner_phone, ''))) > 0
        )
      ORDER BY checks.due_date, checks.id
      LIMIT 500
    `,
    [request.storeId, requestedStatus, search],
  )

  response.json({ checks: result.rows })
})

checksRouter.get('/reminders', async (request, response) => {
  const reminders = await getCheckReminders({ storeId: request.storeId })
  response.json({ reminders })
})

checksRouter.get('/reminder-settings', async (request, response) => {
  const result = await query(
    `
      SELECT value
      FROM system_settings
      WHERE store_id = $1::BIGINT AND key = 'check_follow_up_business_days'
    `,
    [request.storeId],
  )
  const value = Number(result.rows[0]?.value ?? 3)
  response.json({ businessDays: Number.isInteger(value) ? value : 3 })
})

checksRouter.put('/reminder-settings', async (request, response) => {
  const parsed = parseReminderSettingsInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_CHECK_REMINDER_SETTINGS')
  }
  await query(
    `
      INSERT INTO system_settings (store_id, key, value)
      VALUES ($1::BIGINT, 'check_follow_up_business_days', to_jsonb($2::INTEGER))
      ON CONFLICT (store_id, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [request.storeId, parsed.value.businessDays],
  )
  response.json({ businessDays: parsed.value.businessDays })
})

checksRouter.post('/owner-issued', async (request, response) => {
  const parsed = parseOwnerCheckInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_OWNER_CHECK')
  }
  const check = await issueOwnerCheck({
    input: parsed.value,
    storeId: request.storeId,
    userId: request.auth.user.id,
  })
  response.status(201).json({ check })
})

checksRouter.post('/:checkId/clear', async (request, response) => {
  const checkId = requireCheckId(request.params.checkId)
  const check = await clearCheck({ checkId, storeId: request.storeId })
  response.json({ check })
})

checksRouter.post('/:checkId/bounce', async (request, response) => {
  const checkId = requireCheckId(request.params.checkId)
  const check = await bounceCheck({
    checkId,
    storeId: request.storeId,
    userId: request.auth.user.id,
  })
  await notifyCheckBounced({ check })
  response.json({ check })
})

checksRouter.post('/:checkId/later', async (request, response) => {
  const checkId = requireCheckId(request.params.checkId)
  const today = new Date(`${currentBusinessDate()}T00:00:00Z`)
  today.setUTCDate(today.getUTCDate() + 1)
  const snoozedUntil = today.toISOString().slice(0, 10)
  const result = await query(
    `
      UPDATE checks
      SET reminder_snoozed_until = $1::DATE
      WHERE id = $2::BIGINT
        AND store_id = $3::BIGINT
        AND status = 'pending'
        AND ((customer_id IS NOT NULL AND direction = 'inflow') OR is_owner_issued = TRUE)
      RETURNING id::TEXT AS id, status, reminder_snoozed_until::TEXT AS reminder_snoozed_until
    `,
    [snoozedUntil, checkId, request.storeId],
  )
  if (result.rowCount === 0) {
    throw new AppError('الشيك غير موجود أو لم يعد قيد التحصيل', 409, 'CHECK_NOT_PENDING')
  }
  response.json({ check: result.rows[0] })
})

checksRouter.post('/:checkId/stop-bounced-reminder', async (request, response) => {
  const checkId = requireCheckId(request.params.checkId)
  const result = await query(
    `
      UPDATE checks
      SET bounced_reminder_stopped_at = COALESCE(bounced_reminder_stopped_at, NOW())
      WHERE id = $1::BIGINT AND store_id = $2::BIGINT AND status = 'bounced'
      RETURNING id::TEXT AS id, status, bounced_reminder_stopped_at
    `,
    [checkId, request.storeId],
  )
  if (result.rowCount === 0) {
    throw new AppError('الشيك غير موجود أو ليس مرتجعاً', 409, 'CHECK_NOT_BOUNCED')
  }
  response.json({ check: result.rows[0] })
})

checksRouter.post('/:checkId/transfer', async (request, response) => {
  const checkId = requireCheckId(request.params.checkId)

  const parsed = parseCheckTransferInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_CHECK_TRANSFER')
  }

  const check = await transferCheckToSupplier({
    checkId,
    supplierId: parsed.value.supplierId,
    transferDate: parsed.value.transferDate,
    storeId: request.storeId,
    userId: request.auth.user.id,
  })

  response.status(201).json({ check })
})

function requireCheckId(value) {
  const checkId = parseId(value)
  if (!checkId) {
    throw new AppError('معرّف الشيك غير صالح', 400, 'INVALID_CHECK_ID')
  }
  return checkId
}
