import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { createSessionToken, hashSessionToken } from '../auth/session-token.js'
import { isValidLoginPassword, normalizeUsername } from '../auth/credentials.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { requireAuth } from '../middleware/require-auth.js'

const invalidCredentialsHash = hashPassword('timing-normalization-only')

export function createAuthRouter({
  dbQuery = query,
  authenticate = requireAuth,
} = {}) {
  const router = Router()
  const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
      error: {
        code: 'TOO_MANY_LOGIN_ATTEMPTS',
        message: 'محاولات دخول كثيرة. انتظر قليلاً ثم حاول مرة أخرى',
      },
    },
  })

  router.post('/login', loginRateLimiter, async (request, response) => {
    const username = normalizeUsername(request.body?.username)
    const password = request.body?.password

    if (!username || !isValidLoginPassword(password)) {
      throw new AppError(
        'اسم المستخدم أو كلمة المرور غير صحيحة',
        401,
        'INVALID_CREDENTIALS',
      )
    }

    const userResult = await dbQuery(
      `
        SELECT id, username, password_hash, display_name, role
        FROM users
        WHERE LOWER(username) = LOWER($1)
          AND is_active = TRUE
          AND role = 'admin'
      `,
      [username],
    )
    const user = userResult.rows[0]
    const passwordHash = user?.password_hash ?? (await invalidCredentialsHash)
    const passwordMatches = await verifyPassword(password, passwordHash)

    if (!user || !passwordMatches) {
      throw new AppError(
        'اسم المستخدم أو كلمة المرور غير صحيحة',
        401,
        'INVALID_CREDENTIALS',
      )
    }

    const token = createSessionToken()
    const tokenHash = hashSessionToken(token)

    await dbQuery('DELETE FROM auth_sessions WHERE expires_at <= NOW()')
    const sessionResult = await dbQuery(
      `
        INSERT INTO auth_sessions (user_id, token_hash, expires_at)
        VALUES ($1, $2, NOW() + INTERVAL '12 hours')
        RETURNING expires_at
      `,
      [user.id, tokenHash],
    )

    response.set('Cache-Control', 'no-store')
    response.status(201).json({
      token,
      expiresAt: sessionResult.rows[0].expires_at,
      user: {
        id: String(user.id),
        username: user.username,
        displayName: user.display_name,
        role: user.role,
      },
    })
  })

  router.get('/me', authenticate, (request, response) => {
    response.json({ user: request.auth.user })
  })

  router.post('/logout', authenticate, async (request, response) => {
    await dbQuery('DELETE FROM auth_sessions WHERE id = $1::BIGINT', [
      request.auth.sessionId,
    ])
    response.status(204).end()
  })

  return router
}

export const authRouter = createAuthRouter()
