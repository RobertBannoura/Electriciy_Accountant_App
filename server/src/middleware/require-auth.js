import { query } from '../db/pool.js'
import { AppError } from '../errors/app-error.js'
import { hashSessionToken, readBearerToken } from '../auth/session-token.js'
import { logSecurityEvent, securityRequestContext } from '../security/security-log.js'

const renewalWindowMs = 7 * 24 * 60 * 60 * 1000
const activityWindowMs = 20 * 60 * 1000

export function createRequireAuth({ dbQuery = query } = {}) {
  return async function requireAuthentication(request, response, next) {
    const authorizationHeader = request.get('authorization')
    const token = readBearerToken(authorizationHeader)
    const tokenHash = token ? hashSessionToken(token) : null

    if (!tokenHash) {
      logSecurityEvent('warn', 'authentication_rejected', {
        ...securityRequestContext(request),
        outcome: 'failure',
        reason: authorizationHeader === undefined ? 'missing_authorization' : 'malformed_authorization',
        statusCode: 401,
      })
      throw new AppError('يجب تسجيل الدخول أولاً', 401, 'AUTHENTICATION_REQUIRED')
    }

    const result = await dbQuery(
      `
        SELECT
          sessions.id::TEXT AS session_id,
          sessions.expires_at,
          sessions.last_seen_at,
          sessions.remember_me,
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
      logSecurityEvent('warn', 'session_rejected', {
        ...securityRequestContext(request),
        outcome: 'failure',
        reason: 'revoked_expired_disabled_or_unknown',
        statusCode: 401,
      })
      throw new AppError(
        'انتهت جلسة الدخول. يرجى تسجيل الدخول مرة أخرى',
        401,
        'INVALID_SESSION',
      )
    }

    const authenticated = result.rows[0]
    let expiresAt = authenticated.expires_at
    const now = Date.now()
    const expiresAtMs = new Date(expiresAt).getTime()
    const lastSeenAtMs = new Date(authenticated.last_seen_at).getTime()
    const shouldRenew = authenticated.remember_me === true
      && expiresAtMs - now <= renewalWindowMs
    const shouldRecordActivity = now - lastSeenAtMs >= activityWindowMs

    // The predicates in the UPDATE keep concurrent requests from writing the
    // same activity or extending an already revoked or expired session.
    if (request.path !== '/logout' && (shouldRenew || shouldRecordActivity)) {
      const activity = await dbQuery(
        `UPDATE auth_sessions
         SET expires_at = CASE
               WHEN remember_me AND expires_at <= NOW() + INTERVAL '7 days'
                 THEN NOW() + INTERVAL '30 days'
               ELSE expires_at
             END,
             last_seen_at = NOW()
         WHERE id = $1::BIGINT
           AND expires_at > NOW()
           AND (last_seen_at <= NOW() - INTERVAL '20 minutes'
             OR (remember_me AND expires_at <= NOW() + INTERVAL '7 days'))
         RETURNING expires_at`,
        [authenticated.session_id],
      )
      if (activity.rowCount > 0) expiresAt = activity.rows[0].expires_at
    }

    if (expiresAt) response.set('X-Session-Expires-At', new Date(expiresAt).toISOString())
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
