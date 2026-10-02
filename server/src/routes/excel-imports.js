import { Router } from 'express'
import { AppError } from '../errors/app-error.js'
import { requireStore } from '../middleware/require-store.js'
import { parseId } from '../products/product-input.js'
import {
  commitExcelImport, getExcelImport, listExcelImports, rollbackExcelImport,
  saveExcelReview, stageExcelImport,
} from '../imports/excel-import-service.js'

export const excelImportsRouter = Router()
excelImportsRouter.use(requireStore)

const batchId = (request) => {
  const id = parseId(request.params.batchId)
  if (!id) throw new AppError('Invalid import batch', 400, 'INVALID_IMPORT_BATCH')
  return id
}

excelImportsRouter.get('/', async (request, response) => {
  response.json({ batches: await listExcelImports(request.storeId) })
})

excelImportsRouter.post('/', async (request, response) => {
  const { filename, base64 } = request.body ?? {}
  if (typeof filename !== 'string' || !/\.(?:xlsm|xlsx)$/i.test(filename) || filename.length > 255
    || typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new AppError('Upload a complete .xlsm workbook', 400, 'INVALID_IMPORT_WORKBOOK')
  }
  const buffer = Buffer.from(base64, 'base64')
  if (!buffer.length || buffer.length > 40 * 1024 * 1024 || buffer.toString('base64') !== base64) {
    throw new AppError('Invalid or oversized workbook', 400, 'INVALID_IMPORT_WORKBOOK')
  }
  let saved
  try {
    saved = await stageExcelImport({ buffer, sourceName: filename, storeId: request.storeId, userId: request.auth.user.id })
  } catch (error) {
    if (error instanceof AppError) throw error
    if (/workbook|zip|xml|sheet|central directory|invalid/i.test(String(error.message))) {
      throw new AppError(`Cannot read workbook: ${error.message}`, 400, 'INVALID_IMPORT_WORKBOOK')
    }
    throw error
  }
  response.status(saved.repeated ? 200 : 201).json({ batch: saved })
})

excelImportsRouter.get('/:batchId', async (request, response) => {
  response.json({ batch: await getExcelImport(batchId(request), request.storeId) })
})

excelImportsRouter.patch('/:batchId/review', async (request, response) => {
  const patch = request.body
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AppError('Invalid review', 400, 'INVALID_IMPORT_REVIEW')
  const saved = await saveExcelReview({ id: batchId(request), storeId: request.storeId,
    patch, userId: request.auth.user.id })
  response.json({ review: saved.review, problems: saved.validation.problems })
})

excelImportsRouter.post('/:batchId/commit', async (request, response) => {
  response.json(await commitExcelImport({ id: batchId(request), storeId: request.storeId, userId: request.auth.user.id }))
})

excelImportsRouter.post('/:batchId/rollback', async (request, response) => {
  response.json(await rollbackExcelImport({ id: batchId(request), storeId: request.storeId, userId: request.auth.user.id }))
})
