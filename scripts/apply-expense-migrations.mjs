import dotenv from 'dotenv'
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const { Pool } = pg

const migrationFiles = [
  'database/expense_categories_migration.sql',
  'database/expense_workflow_migration.sql'
]

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not configured in .env')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
})

try {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const file of migrationFiles) {
      const sql = await fs.readFile(path.resolve(process.cwd(), file), 'utf8')
      await client.query(sql)
      console.log(`Applied ${file}`)
    }
    await client.query('COMMIT')
    console.log('Expense migrations applied successfully')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
} catch (error) {
  console.error('Expense migration failed:', error.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
