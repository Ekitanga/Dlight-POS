import { Router } from 'express'
import { query, transaction } from '../db'
import { auditMiddleware } from '../middleware/audit'
import { logAudit } from '../utils/audit'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'

const router = Router()
const execFileAsync = promisify(execFile)
const backupDirectory = path.resolve(process.cwd(), 'database', 'backups')
const defaultExpenseCategories = ['Rent', 'Salaries', 'Electricity', 'Internet', 'Packaging', 'Fuel', 'Miscellaneous']

const cleanupTables = [
  'approvals',
  'orders',
  'order_items',
  'order_payments',
  'deliveries',
  'cod_collections',
  'cod_remittances',
  'customer_credits',
  'supplier_payables',
  'supplier_payments',
  'supplier_returns',
  'supplier_settlements',
  'rider_earnings',
  'rider_payments',
  'rider_settlements',
  'order_refunds',
  'daily_reconciliations',
  'expenses',
  'inventory_movements',
  'customers',
  'products',
  'reservations',
  'categories',
  'brands',
  'suppliers',
  'supplier_products',
  'riders',
  'couriers',
  'inventory',
  'audit_logs'
]

const testTransactionTables = [
  'approvals',
  'orders',
  'order_items',
  'order_payments',
  'deliveries',
  'cod_collections',
  'cod_remittances',
  'customer_credits',
  'supplier_payables',
  'supplier_payments',
  'supplier_returns',
  'supplier_settlements',
  'rider_earnings',
  'rider_payments',
  'rider_settlements',
  'order_refunds',
  'daily_reconciliations',
  'expenses',
  'inventory_movements',
  'reservations',
  'audit_logs'
]

async function tableCounts(client: any, tables = cleanupTables) {
  const counts: Record<string, number> = {}
  for (const table of tables) {
    const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`)
    counts[table] = result.rows[0].count
  }
  return counts
}

function totalCount(counts: Record<string, number>) {
  return Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0)
}

function backupFileName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '_')
  return `dlight_pos_${stamp}.dump`
}

function isSafeBackupFileName(fileName: string) {
  return /^dlight_pos_\d{8}_\d{6}Z\.dump$/.test(fileName)
}

function normalizeExpenseCategories(value: unknown) {
  const rawItems = Array.isArray(value) ? value : defaultExpenseCategories
  const seen = new Set<string>()
  const categories: string[] = []

  for (const item of rawItems) {
    const category = String(item || '').trim().replace(/\s+/g, ' ')
    const key = category.toLowerCase()
    if (!category || seen.has(key)) continue
    seen.add(key)
    categories.push(category.slice(0, 100))
  }

  return categories.length ? categories : defaultExpenseCategories
}

async function ensureBackupDirectory() {
  await fs.mkdir(backupDirectory, { recursive: true })
}

async function listBackupFiles() {
  await ensureBackupDirectory()
  const entries = await fs.readdir(backupDirectory, { withFileTypes: true })
  const backups = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.dump')) continue
    const stats = await fs.stat(path.join(backupDirectory, entry.name))
    backups.push({
      file_name: entry.name,
      size_bytes: stats.size,
      created_at: stats.birthtime.toISOString(),
      modified_at: stats.mtime.toISOString()
    })
  }
  return backups.sort((a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime())
}

router.get('/', async (_req, res) => {
  try {
    const result = await query('SELECT * FROM settings ORDER BY id DESC LIMIT 1')
    if (result.rows[0]) {
      res.json(result.rows[0])
    } else {
      const newSettings = {
        company_name: 'Dlight POS',
        currency: 'KES',
        tax_rate: 0,
        expense_categories: defaultExpenseCategories
      }
      const insert = await query(
        'INSERT INTO settings (company_name, currency, tax_rate, expense_categories) VALUES ($1, $2, $3, $4::jsonb) RETURNING *',
        [newSettings.company_name, newSettings.currency, newSettings.tax_rate, JSON.stringify(newSettings.expense_categories)]
      )
      res.json(insert.rows[0])
    }
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/', auditMiddleware('setting', 'settings_updated'), async (req, res) => {
  const {
    company_name, logo_url, company_phone, company_email, company_address, website, kra_pin,
    currency, tax_rate, mpesa_paybill, mpesa_account_number, mpesa_till, bank_details, order_prefix,
    receipt_header, receipt_footer, receipt_paper_width, receipt_show_customer_address,
    receipt_show_payment_details, receipt_show_delivery_details, appearance_mode,
    brand_preset, primary_color, accent_color, sidebar_style, interface_density,
    expense_categories
  } = req.body
  try {
    const normalizedExpenseCategories = normalizeExpenseCategories(expense_categories)
    if (logo_url && (!String(logo_url).startsWith('data:image/') || String(logo_url).length > 1_500_000)) {
      return res.status(400).json({ error: { message: 'Logo must be an image smaller than 1 MB' } })
    }
    const hexColor = /^#[0-9A-F]{6}$/i
    if (!hexColor.test(primary_color || '') || !hexColor.test(accent_color || '')) {
      return res.status(400).json({ error: { message: 'Brand colors must be valid six-digit hex colors' } })
    }
    if (!['light', 'dark', 'system'].includes(appearance_mode)) {
      return res.status(400).json({ error: { message: 'Invalid appearance mode' } })
    }
    if (!['dark', 'light'].includes(sidebar_style) || !['comfortable', 'compact'].includes(interface_density)) {
      return res.status(400).json({ error: { message: 'Invalid appearance preference' } })
    }
    const existing = await query('SELECT id FROM settings ORDER BY id DESC LIMIT 1')
    if (existing.rows[0]) {
      const result = await query(
        `UPDATE settings SET company_name = $1, logo_url = $2, company_phone = $3,
          company_email = $4, company_address = $5, website = $6, kra_pin = $7,
          currency = $8, tax_rate = $9, mpesa_paybill = $10, mpesa_account_number = $11,
          mpesa_till = $12, bank_details = $13, order_prefix = $14, receipt_header = $15,
          receipt_footer = $16, receipt_paper_width = $17,
          receipt_show_customer_address = $18, receipt_show_payment_details = $19,
          receipt_show_delivery_details = $20, appearance_mode = $21, brand_preset = $22,
          primary_color = $23, accent_color = $24, sidebar_style = $25,
          interface_density = $26, expense_categories = $27::jsonb, updated_at = NOW()
         WHERE id = $28 RETURNING *`,
        [
          company_name, logo_url || null, company_phone || null, company_email || null,
          company_address || null, website || null, kra_pin || null, currency || 'KES',
          Number(tax_rate || 0), mpesa_paybill || null, mpesa_account_number || null,
          mpesa_till || null, bank_details || null,
          (order_prefix || 'ORD').toUpperCase(), receipt_header || null, receipt_footer || null,
          receipt_paper_width || '80mm', receipt_show_customer_address ?? true,
          receipt_show_payment_details ?? true, receipt_show_delivery_details ?? true,
          appearance_mode || 'light', brand_preset || 'dlight', primary_color || '#B08D57',
          accent_color || '#D4AF67', sidebar_style || 'dark',
          interface_density || 'comfortable',
          JSON.stringify(normalizedExpenseCategories),
          existing.rows[0].id
        ]
      )
      res.json(result.rows[0])
    } else {
      const result = await query(
        `INSERT INTO settings (
          company_name, logo_url, company_phone, company_email, company_address, website,
          kra_pin, currency, tax_rate, mpesa_paybill, mpesa_account_number, mpesa_till, bank_details, order_prefix,
          receipt_header, receipt_footer, receipt_paper_width, receipt_show_customer_address,
          receipt_show_payment_details, receipt_show_delivery_details, appearance_mode,
          brand_preset, primary_color, accent_color, sidebar_style, interface_density,
          expense_categories
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27::jsonb)
         RETURNING *`,
        [
          company_name, logo_url || null, company_phone || null, company_email || null,
          company_address || null, website || null, kra_pin || null, currency || 'KES',
          Number(tax_rate || 0), mpesa_paybill || null, mpesa_account_number || null,
          mpesa_till || null, bank_details || null,
          (order_prefix || 'ORD').toUpperCase(), receipt_header || null, receipt_footer || null,
          receipt_paper_width || '80mm', receipt_show_customer_address ?? true,
          receipt_show_payment_details ?? true, receipt_show_delivery_details ?? true,
          appearance_mode || 'light', brand_preset || 'dlight', primary_color || '#B08D57',
          accent_color || '#D4AF67', sidebar_style || 'dark',
          interface_density || 'comfortable',
          JSON.stringify(normalizedExpenseCategories)
        ]
      )
      res.json(result.rows[0])
    }
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/backups', async (_req, res) => {
  try {
    res.json(await listBackupFiles())
  } catch (error) {
    console.error('Backup list error:', error)
    res.status(500).json({ error: { message: 'Unable to list backups' } })
  }
})

router.post('/backups', async (req, res) => {
  try {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) {
      return res.status(500).json({ error: { message: 'DATABASE_URL is not configured' } })
    }

    await ensureBackupDirectory()
    const fileName = backupFileName()
    const filePath = path.join(backupDirectory, fileName)
    await execFileAsync('pg_dump', [databaseUrl, '--format=custom', `--file=${filePath}`], { timeout: 120000 })
    await execFileAsync('pg_restore', ['--list', filePath], { timeout: 120000 })
    const stats = await fs.stat(filePath)

    await logAudit({
      req,
      action: 'database_backup_created',
      entityType: 'setting',
      newValues: { file_name: fileName, size_bytes: stats.size },
      metadata: { file_name: fileName, size_bytes: stats.size }
    })

    res.status(201).json({
      file_name: fileName,
      size_bytes: stats.size,
      created_at: stats.birthtime.toISOString(),
      modified_at: stats.mtime.toISOString()
    })
  } catch (error) {
    console.error('Backup create error:', error)
    res.status(500).json({ error: { message: 'Backup failed. Confirm pg_dump and pg_restore are installed and available on PATH.' } })
  }
})

router.get('/backups/:fileName', async (req, res) => {
  try {
    const { fileName } = req.params
    if (!isSafeBackupFileName(fileName)) {
      return res.status(400).json({ error: { message: 'Invalid backup file name' } })
    }
    const filePath = path.join(backupDirectory, fileName)
    await fs.access(filePath)

    await logAudit({
      req,
      action: 'database_backup_downloaded',
      entityType: 'setting',
      newValues: { file_name: fileName },
      metadata: { file_name: fileName }
    })

    res.download(filePath, fileName)
  } catch (error) {
    console.error('Backup download error:', error)
    res.status(404).json({ error: { message: 'Backup file not found' } })
  }
})

router.get('/cleanup/preview', async (req, res) => {
  try {
    const mode = String(req.query.mode || 'transactions')
    if (!['transactions', 'full'].includes(mode)) {
      return res.status(400).json({ error: { message: 'Invalid cleanup mode' } })
    }

    const counts = await transaction(async client => tableCounts(client, mode === 'transactions' ? testTransactionTables : cleanupTables))
    res.json({
      mode,
      confirmation_phrase: mode === 'transactions' ? 'DELETE TEST TRANSACTIONS' : 'FULL BUSINESS RESET',
      counts,
      total_records: totalCount(counts),
      preserves: mode === 'transactions'
        ? ['users', 'roles', 'permissions', 'settings', 'products', 'categories', 'suppliers', 'riders', 'couriers', 'inventory records']
        : ['users', 'roles', 'permissions', 'settings']
    })
  } catch (error) {
    console.error('Cleanup preview error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/cleanup/run', async (req, res) => {
  try {
    const { mode, confirmation } = req.body
    const cleanupMode = String(mode || '')
    const expectedConfirmation = cleanupMode === 'transactions' ? 'DELETE TEST TRANSACTIONS' : cleanupMode === 'full' ? 'FULL BUSINESS RESET' : ''

    if (!expectedConfirmation) {
      return res.status(400).json({ error: { message: 'Invalid cleanup mode' } })
    }
    if (String(confirmation || '').trim() !== expectedConfirmation) {
      return res.status(400).json({ error: { message: `Type ${expectedConfirmation} exactly to continue` } })
    }

    const result = await transaction(async client => {
      const before = await tableCounts(client, cleanupMode === 'transactions' ? testTransactionTables : cleanupTables)

      if (cleanupMode === 'transactions') {
        await client.query(`
          UPDATE inventory i
          SET quantity = i.quantity + restored.qty,
              reserved_quantity = 0,
              last_updated = NOW()
          FROM (
            SELECT product_id, COALESCE(SUM(internal_quantity), 0)::int AS qty
            FROM order_items
            WHERE internal_quantity > 0
            GROUP BY product_id
          ) restored
          WHERE i.product_id = restored.product_id
        `)
        await client.query(`
          UPDATE inventory
          SET reserved_quantity = 0,
              damaged_quantity = GREATEST(damaged_quantity, 0),
              lost_quantity = GREATEST(lost_quantity, 0),
              returned_quantity = 0,
              last_updated = NOW()
        `)

        await client.query(`TRUNCATE TABLE
          approvals,
          cod_remittances,
          cod_collections,
          customer_credits,
          daily_reconciliations,
          deliveries,
          expenses,
          inventory_movements,
          order_refunds,
          order_items,
          order_payments,
          orders,
          reservations,
          rider_earnings,
          rider_payments,
          rider_settlements,
          supplier_payments,
          supplier_returns,
          supplier_settlements,
          supplier_payables,
          audit_logs
        RESTART IDENTITY CASCADE`)

        await client.query('UPDATE customers SET balance = 0, updated_at = NOW()')
        await client.query('UPDATE suppliers SET balance = 0, updated_at = NOW()')
        await client.query('UPDATE riders SET balance = 0, updated_at = NOW()')
      } else {
        await client.query(`TRUNCATE TABLE
          approvals,
          brands,
          categories,
          cod_remittances,
          cod_collections,
          couriers,
          customer_credits,
          customers,
          daily_reconciliations,
          deliveries,
          expenses,
          inventory,
          inventory_movements,
          order_refunds,
          order_items,
          order_payments,
          orders,
          products,
          reservations,
          rider_earnings,
          rider_payments,
          rider_settlements,
          riders,
          supplier_payments,
          supplier_products,
          supplier_returns,
          supplier_settlements,
          supplier_payables,
          suppliers,
          audit_logs
        RESTART IDENTITY CASCADE`)
      }

      await logAudit({
        req,
        client,
        action: cleanupMode === 'transactions' ? 'test_transactions_cleanup_completed' : 'full_business_reset_completed',
        entityType: 'setting',
        newValues: { mode: cleanupMode, counts_before: before },
        metadata: { total_records_deleted: totalCount(before), confirmation: expectedConfirmation }
      })

      const after = await tableCounts(client, cleanupMode === 'transactions' ? testTransactionTables : cleanupTables)
      return { mode: cleanupMode, counts_before: before, counts_after: after, total_records_deleted: totalCount(before) }
    })

    res.json(result)
  } catch (error) {
    console.error('Cleanup run error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as settingsRoutes }
