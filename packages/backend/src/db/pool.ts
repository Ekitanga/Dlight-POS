import { Pool } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

let pool: Pool | null = null

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  })
  
  pool.on('error', (_err) => {
    console.error('Database connection error:', _err)
  })
} catch (error) {
  console.error('Database configuration error')
  if (process.env.NODE_ENV === 'production') throw error
}

export { pool }
