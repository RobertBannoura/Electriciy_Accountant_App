import { createHash } from 'node:crypto'
import { Router } from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { createSessionToken, hashSessionToken } from '../auth/session-token.js'
import { isValidLoginPassword, normalizeUsername } from '../auth/credentials.js'
import {
  hashPassword,
  passwordHashNeedsUpgrade,
  verifyPassword,
} from '../auth/password.js'
import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { requireAuth } from '../middleware/require-auth.js'
import {
  logSecurityEvent,
  securityFingerprint,
  securityRequestContext,
} from '../security/security-log.js'

const invalidCredentialsHash = hashPassword('timing-normalization-only')
export const LOGIN_ATTEMPT_LIMIT = 45
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
export const STANDARD_SESSION_DURATION = '12 hours'
export const REMEMBERED_SESSION_DURATION = '30 days'

const rateLimitMessage = Object.freeze({
  error: {
    code: 'TOO_MANY_LOGIN_ATTEMPTS',
    message: 'محاولات دخول كثيرة. انتظر قليلاً ثم حاول مرة أخرى',
  },
})

function accountRateLimitKey(request) {
  const username = normalizeUsername(request.body?.username)

  if (!username) {
    return 'invalid-account-identifier'
  }

  return createHash('sha256')
    .update(username.toLowerCase(), 'utf8')
    .digest('hex')
}

function ipRateLimitKey(request) {
  return ipKeyGenerator(request.ip)
}

export function createAuthRouter({
  dbQuery = query,
  authenticate = requireAuth,
  loginAttemptLimit = LOGIN_ATTEMPT_LIMIT,
} = {}) {
  const router = Router()
  const loginIpRateLimiter = rateLimit({
    windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
    limit: loginAttemptLimit,
    identifier: 'login-ip',
    keyGenerator: ipRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: rateLimitMessage,
    handler: (request, response, _next, options) => {
      logSecurityEvent('warn', 'login_rate_limited', {
        ...securityRequestContext(request),
        identifierHash: securityFingerprint(normalizeUsername(request.body?.username)?.toLowerCase()),
        reason: options.identifier,
        statusCode: options.statusCode,
      })
      response.status(options.statusCode).json(rateLimitMessage)
    },
  })
  const loginAccountRateLimiter = rateLimit({
    windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
    limit: loginAttemptLimit,
    identifier: 'login-account',
    keyGenerator: accountRateLimitKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: rateLimitMessage,
    handler: (request, response, _next, options) => {
      logSecurityEvent('warn', 'login_rate_limited', {
        ...securityRequestContext(request),
        identifierHash: securityFingerprint(normalizeUsername(request.body?.username)?.toLowerCase()),
        reason: options.identifier,
        statusCode: options.statusCode,
      })
      response.status(options.statusCode).json(rateLimitMessage)
    },
  })

  router.post('/login', loginIpRateLimiter, loginAccountRateLimiter, async (request, response) => {
    const username = normalizeUsername(request.body?.username)
    const password = request.body?.password
    const rememberMe = request.body?.rememberMe === true

    if (!username || !isValidLoginPassword(password)) {
      logSecurityEvent('warn', 'login_failed', {
        ...securityRequestContext(request),
        identifierHash: securityFingerprint(username?.toLowerCase()),
        outcome: 'failure',
        reason: 'invalid_credentials',
        statusCode: 401,
      })
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
      logSecurityEvent('warn', 'login_failed', {
        ...securityRequestContext(request),
        identifierHash: securityFingerprint(username.toLowerCase()),
        outcome: 'failure',
        reason: 'invalid_credentials',
        statusCode: 401,
      })
      throw new AppError(
        'اسم المستخدم أو كلمة المرور غير صحيحة',
        401,
        'INVALID_CREDENTIALS',
      )
    }

    if (passwordHashNeedsUpgrade(user.password_hash)) {
      const upgradedHash = await hashPassword(password)
      await dbQuery(
        `UPDATE users SET password_hash = $1
         WHERE id = $2::BIGINT AND password_hash = $3`,
        [upgradedHash, user.id, user.password_hash],
      )
    }

    await Promise.all([
      loginIpRateLimiter.resetKey(ipRateLimitKey(request)),
      loginAccountRateLimiter.resetKey(accountRateLimitKey(request)),
    ])

    const token = createSessionToken()
    const tokenHash = hashSessionToken(token)
    const sessionDuration = rememberMe
      ? REMEMBERED_SESSION_DURATION
      : STANDARD_SESSION_DURATION

    await dbQuery('DELETE FROM auth_sessions WHERE expires_at <= NOW()')
    const sessionResult = await dbQuery(
      `
        WITH new_session AS (
          INSERT INTO auth_sessions (user_id, token_hash, expires_at)
          VALUES ($1::BIGINT, $2, NOW() + $6::INTERVAL)
          RETURNING expires_at
        ), audit AS (
          INSERT INTO audit_log (
            actor_user_id, action, entity_type, entity_id,
            new_values, request_id, ip_address
          )
          SELECT $1::BIGINT, 'login', 'user', $1::BIGINT,
            jsonb_build_object('username', $3::TEXT, 'remembered', $7::BOOLEAN), $4, $5::INET
          FROM new_session
          RETURNING 1
        )
        SELECT new_session.expires_at FROM new_session CROSS JOIN audit
      `,
      [
        user.id,
        tokenHash,
        user.username,
        request.requestId ?? null,
        request.ip,
        sessionDuration,
        rememberMe,
      ],
    )

    logSecurityEvent('info', 'login_succeeded', {
      ...securityRequestContext(request),
      outcome: 'success',
      userId: String(user.id),
    })
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
    logSecurityEvent('info', 'logout_succeeded', {
      ...securityRequestContext(request),
      outcome: 'success',
      userId: request.auth.user.id,
    })
    response.status(204).end()
  })

  return router
}

export const authRouter = createAuthRouter()
