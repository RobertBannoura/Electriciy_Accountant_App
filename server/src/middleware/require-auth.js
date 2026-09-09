import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { hashSessionToken, readBearerToken } from '../auth/session-token.js'

export function createRequireAuth({ dbQuery = query } = {}) {
  return async function requireAuthentication(request, _response, next) {
    const token = readBearerToken(request.get('authorization'))
    const tokenHash = token ? hashSessionToken(token) : null

    if (!tokenHash) {
      throw new AppError('يجب تسجيل الدخول أولاً', 401, 'AUTHENTICATION_REQUIRED')
    }

    const result = await dbQuery(
      `
        SELECT
          sessions.id::TEXT AS session_id,
          users.id::TEXT AS user_id,
          users.username,
          users.display_name,
          users.role
        FROM auth_sessions AS sessions
        INNER JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = $1
          AND sessions.expires_at > NOW()
          AND users.is_active = TRUE
          AND users.role = 'admin'
      `,
      [tokenHash],
    )

    if (result.rowCount === 0) {
      throw new AppError(
        'انتهت جلسة الدخول. يرجى تسجيل الدخول مرة أخرى',
        401,
        'INVALID_SESSION',
      )
    }

    const authenticated = result.rows[0]
    request.auth = Object.freeze({
      sessionId: authenticated.session_id,
      user: Object.freeze({
        id: authenticated.user_id,
        username: authenticated.username,
        displayName: authenticated.display_name,
        role: authenticated.role,
      }),
    })

    next()
  }
}

export const requireAuth = createRequireAuth()
