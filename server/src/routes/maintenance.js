import { Router } from 'express'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import {
  isValidMaintenanceDate,
  parseMaintenanceInput,
  parseMaintenanceReversalInput,
} from '../maintenance/maintenance-input.js'
import {
  createMaintenance,
  reverseMaintenance,
} from '../maintenance/maintenance-service.js'
import { requireStore } from '../middleware/require-store.js'
import { normalizeOptionalText, parseId } from '../products/product-input.js'
import { paginatedResult, parsePagination } from '../pagination/pagination.js'
import {
  financialOperation,
  requireFinancialRequestId,
} from '../financial/financial-operation.js'

export const maintenanceRouter = Router()

maintenanceRouter.use(requireStore)

maintenanceRouter.get('/', async (request, response) => {
  const pagination = parsePagination(request.query)
  const search = normalizeOptionalText(request.query.search, 200)
  if (request.query.search && !search) {
    throw new AppError('نص البحث غير صالح', 400, 'INVALID_MAINTENANCE_SEARCH')
  }
  const date = request.query.date || null
  if (date && !isValidMaintenanceDate(date)) {
    throw new AppError('تاريخ البحث غير صالح', 400, 'INVALID_MAINTENANCE_DATE')
  }

  const result = await query(
    `
      SELECT
        maintenance_records.id::TEXT AS id,
        maintenance_records.store_id::TEXT AS store_id,
        maintenance_records.customer_id::TEXT AS customer_id,
        customers.name AS customer_name,
        maintenance_records.item_description,
        maintenance_records.maintenance_details,
        maintenance_records.amount_ils::TEXT AS amount_ils,
        maintenance_records.business_date::TEXT AS business_date,
        maintenance_records.paid_total_ils::TEXT AS paid_total_ils,
        maintenance_records.remaining_due_ils::TEXT AS remaining_due_ils,
        maintenance_records.notes,
        maintenance_records.created_at,
        maintenance_reversals.id::TEXT AS reversal_id,
        maintenance_reversals.reason AS reversal_reason,
        maintenance_reversals.created_at AS reversed_at
      FROM maintenance_records
      LEFT JOIN customers ON customers.id = maintenance_records.customer_id
      LEFT JOIN maintenance_reversals
        ON maintenance_reversals.maintenance_id = maintenance_records.id
      WHERE maintenance_records.store_id = $1::BIGINT
        AND (
          $2::TEXT IS NULL
          OR LOWER(maintenance_records.item_description) LIKE '%' || LOWER($2) || '%'
          OR LOWER(customers.name) LIKE '%' || LOWER($2) || '%'
        )
        AND ($3::DATE IS NULL OR maintenance_records.business_date = $3::DATE)
      ORDER BY maintenance_records.business_date DESC, maintenance_records.id DESC
      LIMIT $4::INTEGER OFFSET $5::INTEGER
    `,
    [request.storeId, search, date, pagination.fetchLimit, pagination.offset],
  )
  const page = paginatedResult(result.rows, pagination)
  response.json({ maintenance: page.rows, pagination: page.pagination })
})

maintenanceRouter.post('/', requireFinancialRequestId, async (request, response) => {
  const parsed = parseMaintenanceInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_MAINTENANCE')
  }
  const maintenance = await createMaintenance({
    input: parsed.value,
    storeId: request.storeId,
    userId: request.auth.user.id,
    operation: financialOperation(request, 'maintenance:create', {
      storeId: request.storeId,
      input: parsed.value,
    }),
  })
  response.status(201).json({ maintenance })
})

maintenanceRouter.post('/:maintenanceId/reversal', requireFinancialRequestId, async (request, response) => {
  const maintenanceId = parseId(request.params.maintenanceId)
  if (!maintenanceId) {
    throw new AppError('معرّف الصيانة غير صالح', 400, 'INVALID_MAINTENANCE_ID')
  }
  const parsed = parseMaintenanceReversalInput(request.body)
  if (parsed.error) {
    throw new AppError(parsed.error, 400, 'INVALID_MAINTENANCE_REVERSAL')
  }
  const reversal = await reverseMaintenance({
    maintenanceId,
    reason: parsed.value.reason,
    storeId: request.storeId,
    userId: request.auth.user.id,
    operation: financialOperation(request, 'maintenance:reverse', {
      storeId: request.storeId,
      maintenanceId,
      reason: parsed.value.reason,
    }),
  })
  response.status(201).json({ reversal })
})
