import { hashPassword } from './password.js'
import {
  isValidLoginPassword,
  isValidProvisionedPassword,
  normalizeUsername,
} from './credentials.js'

export async function provisionAdmin(
  client,
  {
    username,
    password,
    displayName = 'المدير',
    allowLocalDevelopmentPassword = false,
  },
) {
  const normalizedUsername = normalizeUsername(username)
  const normalizedDisplayName =
    typeof displayName === 'string' ? displayName.trim() : ''

  if (!normalizedUsername) {
    throw new Error('ADMIN_USERNAME must contain between 1 and 64 characters.')
  }

  const passwordIsAllowed = isValidProvisionedPassword(password)
    || (allowLocalDevelopmentPassword && isValidLoginPassword(password))

  if (!passwordIsAllowed) {
    throw new Error('ADMIN_PASSWORD must contain at least 15 characters.')
  }

  if (normalizedDisplayName.length === 0 || normalizedDisplayName.length > 100) {
    throw new Error('ADMIN_DISPLAY_NAME must contain between 1 and 100 characters.')
  }

  const passwordHash = await hashPassword(password)
  const existingResult = await client.query(
    'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
    [normalizedUsername],
  )

  if (existingResult.rowCount > 0) {
    const result = await client.query(
      `
        UPDATE users
        SET username = $1,
            password_hash = $2,
            display_name = $3,
            role = 'admin',
            is_active = TRUE
        WHERE id = $4
        RETURNING id::TEXT AS id, username, display_name, role
      `,
      [
        normalizedUsername,
        passwordHash,
        normalizedDisplayName,
        existingResult.rows[0].id,
      ],
    )

    await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [
      existingResult.rows[0].id,
    ])

    return result.rows[0]
  }

  const result = await client.query(
    `
      INSERT INTO users (username, password_hash, display_name, role)
      VALUES ($1, $2, $3, 'admin')
      RETURNING id::TEXT AS id, username, display_name, role
    `,
    [normalizedUsername, passwordHash, normalizedDisplayName],
  )

  return result.rows[0]
}
