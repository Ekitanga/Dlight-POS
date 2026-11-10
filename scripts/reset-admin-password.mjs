import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config()

const email = String(process.env.DLIGHT_ADMIN_EMAIL || '').trim().toLowerCase()
const password = String(process.env.DLIGHT_NEW_ADMIN_PASSWORD || '')

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
if (!email) throw new Error('DLIGHT_ADMIN_EMAIL is required')
if (password.length < 8) throw new Error('The new password must be at least 8 characters')

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  const passwordHash = await bcrypt.hash(password, 12)
  const result = await pool.query(
    `UPDATE users SET password_hash = $1, updated_at = NOW()
     WHERE LOWER(email) = $2 AND is_active = true
     RETURNING id, email, role`,
    [passwordHash, email]
  )
  if (!result.rows[0]) throw new Error('Active admin or owner account not found')
  // End every existing sign-in for this account (table exists from the auth sessions release onward).
  const sessionsTable = await pool.query("SELECT to_regclass('public.user_sessions') IS NOT NULL AS exists")
  if (sessionsTable.rows[0].exists) {
    await pool.query(
      "UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL",
      [result.rows[0].id]
    )
  }
  console.log(`Password reset completed for ${result.rows[0].email} (${result.rows[0].role})`)
} finally {
  await pool.end()
}
