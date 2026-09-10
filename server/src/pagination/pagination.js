import { AppError } from '../errors/app-error.js'

const POSITIVE_INTEGER = /^[1-9]\d*$/

export function parsePagination(query, { defaultLimit = 50, maxLimit = 100 } = {}) {
  const pageText = query.page === undefined ? '1' : String(query.page)
  const limitText = query.limit === undefined ? String(defaultLimit) : String(query.limit)
  if (!POSITIVE_INTEGER.test(pageText) || !POSITIVE_INTEGER.test(limitText)) {
    throw new AppError('معاملات ترقيم الصفحات غير صالحة', 400, 'INVALID_PAGINATION')
  }
  const page = Number(pageText)
  const limit = Number(limitText)
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit) || limit > maxLimit) {
    throw new AppError(`حجم الصفحة يجب ألا يتجاوز ${maxLimit}`, 400, 'INVALID_PAGINATION')
  }
  const offset = (page - 1) * limit
  if (!Number.isSafeInteger(offset) || offset > 1_000_000) {
    throw new AppError('رقم الصفحة كبير جداً', 400, 'INVALID_PAGINATION')
  }
  return { page, limit, offset, fetchLimit: limit + 1 }
}

export function paginatedResult(rows, pagination) {
  const hasMore = rows.length > pagination.limit
  return {
    rows: hasMore ? rows.slice(0, pagination.limit) : rows,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      hasMore,
      nextPage: hasMore ? pagination.page + 1 : null,
    },
  }
}
