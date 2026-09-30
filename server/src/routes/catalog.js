import { Router } from 'express'
import { readBearerToken, hashSessionToken } from '../auth/session-token.js'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { catalogFilters, listCatalog, sendCatalogImage } from '../products/catalog.js'

export const catalogRouter = Router()
catalogRouter.use(async (request, _response, next) => {
  const token = readBearerToken(request.get('authorization'))
  if (!token) throw new AppError('يجب فتح الكتالوج من حساب المدير', 401, 'AUTHENTICATION_REQUIRED')
  const hash = hashSessionToken(token)
  const session = await query(`SELECT 1 FROM catalog_sessions cs JOIN users u ON u.id = cs.user_id
    WHERE cs.token_hash = $1 AND cs.expires_at > NOW() AND u.is_active AND u.role = 'admin'`, [hash])
  if (!session.rowCount) throw new AppError('انتهت جلسة الكتالوج. اطلب من المدير فتحه مجدداً.', 401, 'INVALID_SESSION')
  request.catalogTokenHash = hash
  next()
})
catalogRouter.get('/', async (request, response) => response.json(await listCatalog(request.query)))
catalogRouter.get('/filters', async (_request, response) => response.json(await catalogFilters()))
catalogRouter.get('/settings', async (_request, response) => {
  const result = await query('SELECT show_sale_prices FROM catalog_settings WHERE id = 1')
  response.json({ showSalePrices: result.rows[0].show_sale_prices })
})
catalogRouter.get('/photos/:photoId/image', async (request, response) => sendCatalogImage(request, response))
catalogRouter.delete('/session', async (request, response) => {
  await query('DELETE FROM catalog_sessions WHERE token_hash = $1', [request.catalogTokenHash])
  response.json({ closed: true })
})
