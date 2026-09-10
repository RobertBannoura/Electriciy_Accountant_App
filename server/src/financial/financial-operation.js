import { createHash } from 'node:crypto'
import { AppError } from '../errors/app-error.js'

const REQUEST_ID_REQUIRED_MESSAGE = 'معرّف العملية المالية مطلوب'

export function requireFinancialRequestId(request, _response, next) {
  if (!request.requestId) {
    throw new AppError(
      REQUEST_ID_REQUIRED_MESSAGE,
      400,
      'FINANCIAL_REQUEST_ID_REQUIRED',
    )
  }
  next()
}

export function financialOperation(request, scope, payload) {
  return {
    requestId: request.requestId,
    scope,
    requestHash: createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex'),
  }
}

export async function claimFinancialOperation(client, { userId, operation }) {
  if (!operation) return

  const inserted = await client.query(
    `
      INSERT INTO financial_operation_requests (
        actor_user_id, scope, request_id, request_hash
      ) VALUES ($1::BIGINT, $2, $3, $4)
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [userId, operation.scope, operation.requestId, operation.requestHash],
  )
  if (inserted.rowCount === 1) return

  const existing = await client.query(
    `
      SELECT request_hash
      FROM financial_operation_requests
      WHERE actor_user_id IS NOT DISTINCT FROM $1::BIGINT
        AND scope = $2
        AND request_id = $3
    `,
    [userId, operation.scope, operation.requestId],
  )
  if (existing.rows[0]?.request_hash !== operation.requestHash) {
    throw new AppError(
      'لا يمكن إعادة استخدام معرّف العملية المالية لطلب مختلف',
      409,
      'FINANCIAL_REQUEST_ID_REUSED',
    )
  }
  throw new AppError(
    'تم تسجيل هذه العملية المالية مسبقاً ولم تُكرر',
    409,
    'DUPLICATE_FINANCIAL_OPERATION',
  )
}
