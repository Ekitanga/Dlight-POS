import bcrypt from 'bcryptjs'
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config()

const email = String(process.env.DLIGHT_ADMIN_EMAIL || '').trim().toLowerCase()
const password = String(process.env.DLIGHT_NEW_ADMIN_PASSWORD || '')

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
if (!email) throw new Error('DLIGHT_ADMIN_EMAIL is required')
if (password.length < 14) throw new Error('The new password must be at least 14 characters')

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  const passwordHash = await bcrypt.hash(password, 12)
  const result = await pool.query(
    `UPDATE users SET password_hash = $1, updated_at = NOW()
     WHERE LOWER(email) = $2 AND role IN ('admin', 'owner') AND is_active = true
     RETURNING email, role`,
    [passwordHash, email]
  )
  if (!result.rows[0]) throw new Error('Active admin or owner account not found')
  console.log(`Password reset completed for ${result.rows[0].email} (${result.rows[0].role})`)
} finally {
  await pool.end()
}
