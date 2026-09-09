import { Router } from 'express'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { normalizeRequiredText, parseId } from '../products/product-input.js'

export const categoriesRouter = Router()

categoriesRouter.get('/', async (_request, response) => {
  const result = await query(`
    SELECT id::TEXT AS id, name
    FROM categories
    WHERE is_active = TRUE
    ORDER BY name
  `)

  response.json({ categories: result.rows })
})

categoriesRouter.post('/', async (request, response) => {
  const name = normalizeRequiredText(request.body?.name, 100)
  if (!name) {
    throw new AppError(
      'اسم التصنيف مطلوب وبحد أقصى 100 حرف',
      400,
      'INVALID_CATEGORY_NAME',
    )
  }

  try {
    const result = await query(
      `
        INSERT INTO categories (name)
        VALUES ($1)
        RETURNING id::TEXT AS id, name
      `,
      [name],
    )

    response.status(201).json({ category: result.rows[0] })
  } catch (error) {
    if (error?.code === '23505') {
      throw new AppError('يوجد تصنيف بهذا الاسم', 409, 'CATEGORY_NAME_EXISTS')
    }
    throw error
  }
})

categoriesRouter.patch('/:categoryId', async (request, response) => {
  const categoryId = parseId(request.params.categoryId)
  const name = normalizeRequiredText(request.body?.name, 100)

  if (!categoryId) {
    throw new AppError('معرّف التصنيف غير صالح', 400, 'INVALID_CATEGORY_ID')
  }
  if (!name) {
    throw new AppError(
      'اسم التصنيف مطلوب وبحد أقصى 100 حرف',
      400,
      'INVALID_CATEGORY_NAME',
    )
  }

  try {
    const result = await query(
      `
        UPDATE categories
        SET name = $1
        WHERE id = $2::BIGINT
          AND is_active = TRUE
        RETURNING id::TEXT AS id, name
      `,
      [name, categoryId],
    )

    if (result.rowCount === 0) {
      throw new AppError('التصنيف غير موجود', 404, 'CATEGORY_NOT_FOUND')
    }

    response.json({ category: result.rows[0] })
  } catch (error) {
    if (error?.code === '23505') {
      throw new AppError('يوجد تصنيف بهذا الاسم', 409, 'CATEGORY_NAME_EXISTS')
    }
    throw error
  }
})
