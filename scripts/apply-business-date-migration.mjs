import dotenv from 'dotenv'
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not configured in .env')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
})

try {
  const sql = await fs.readFile(path.resolve(process.cwd(), 'database/business_dates_migration.sql'), 'utf8')
  await pool.query(sql)
  console.log('Applied database/business_dates_migration.sql')
} catch (error) {
  console.error('Business date migration failed:', error.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
