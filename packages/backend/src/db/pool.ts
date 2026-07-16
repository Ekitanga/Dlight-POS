import { Pool } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

let pool: Pool | null = null

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const databaseUrl = new URL(process.env.DATABASE_URL)
  const sslMode = databaseUrl.searchParams.get('sslmode') || process.env.PGSSLMODE
  const databaseSsl = process.env.DATABASE_SSL
  const useSsl =
    databaseSsl === 'true' ||
    (process.env.NODE_ENV === 'production' &&
      databaseSsl !== 'false' &&
      sslMode !== 'disable' &&
      databaseUrl.hostname !== 'db')

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false
  })
  
  pool.on('error', (_err) => {
    console.error('Database connection error:', _err)
  })
} catch (error) {
  console.error('Database configuration error')
  if (process.env.NODE_ENV === 'production') throw error
}

export { pool }
