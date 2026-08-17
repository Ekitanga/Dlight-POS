import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const { Pool } = pg

const args = process.argv.slice(2)
const valueAfter = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const filePath = valueAfter('--file')
const dryRun = args.includes('--dry-run')
const verifyOnly = args.includes('--verify')
const categoryName = valueAfter('--category') || 'Perfumes'

if (!filePath) {
  throw new Error('Usage: node scripts/import-product-catalog.mjs --file <catalog.json> [--category Perfumes] [--dry-run|--verify]')
}
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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false
})

const money = (value, field, rowNumber) => {
  const normalized = typeof value === 'string' ? value.replace(/[^0-9.-]/g, '') : value
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Row ${rowNumber}: ${field} must be a non-negative number`)
  }
  return Number(parsed.toFixed(2))
}

const stock = (value, rowNumber) => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Row ${rowNumber}: stock_quantity must be a non-negative whole number`)
  }
  return parsed
}

const generatedSku = (category, name) => {
  const prefix = category.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || 'ITEM'
  const digest = createHash('sha1').update(name.trim().toLowerCase()).digest('hex').slice(0, 8).toUpperCase()
  return `${prefix}-${digest}`
}

const uniqueGeneratedSku = async (client, category, name) => {
  const base = generatedSku(category, name)
  for (let suffix = 1; suffix <= 9999; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`
    const result = await client.query('SELECT 1 FROM products WHERE sku = $1 LIMIT 1', [candidate])
    if (!result.rows[0]) return candidate
  }
  throw new Error(`Unable to generate a unique SKU for ${name}`)
}

const rawRows = JSON.parse(await readFile(path.resolve(filePath), 'utf8'))
if (!Array.isArray(rawRows) || rawRows.length === 0) throw new Error('Catalog must be a non-empty JSON array')

const rows = rawRows.map((row, index) => {
  const rowNumber = index + 2
  const name = String(row.name || '').trim()
  if (!name) throw new Error(`Row ${rowNumber}: name is required`)
  if (name.length > 255) throw new Error(`Row ${rowNumber}: name exceeds 255 characters`)
  return {
    rowNumber,
    name,
    sellingPrice: money(row.selling_price, 'selling_price', rowNumber),
    costPrice: money(row.cost_price, 'cost_price', rowNumber),
    stockQuantity: stock(row.stock_quantity, rowNumber)
  }
})

const duplicateNames = rows
  .map((row) => row.name.toLocaleLowerCase())
  .filter((name, index, names) => names.indexOf(name) !== index)
if (duplicateNames.length) throw new Error(`Duplicate catalog names: ${[...new Set(duplicateNames)].join(', ')}`)

const sourceFile = path.basename(filePath)

const verify = async (client) => {
  const mismatches = []
  let verifiedStock = 0
  for (const row of rows) {
    const result = await client.query(
      `SELECT p.id, p.sku, p.name, p.cost_price, p.selling_price, p.is_dropship,
              c.name AS category_name, COALESCE(i.quantity, 0)::int AS stock_quantity
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN inventory i ON i.product_id = p.id
       WHERE LOWER(p.name) = LOWER($1) AND p.deleted_at IS NULL`,
      [row.name]
    )
    if (result.rowCount !== 1) {
      mismatches.push({ name: row.name, issue: result.rowCount === 0 ? 'missing' : 'ambiguous-name-match' })
      continue
    }
    const product = result.rows[0]
    const issues = []
    if (String(product.category_name).toLocaleLowerCase() !== categoryName.toLocaleLowerCase()) issues.push('category')
    if (Number(product.cost_price) !== row.costPrice) issues.push('cost_price')
    if (Number(product.selling_price) !== row.sellingPrice) issues.push('selling_price')
    if (Number(product.stock_quantity) !== row.stockQuantity) issues.push('stock_quantity')
    if (!product.sku) issues.push('sku')
    if (issues.length) mismatches.push({ name: row.name, issue: issues.join(',') })
    verifiedStock += Number(product.stock_quantity)
  }
  return { verified: rows.length - mismatches.length, mismatches, verifiedStock }
}

const run = async () => {
  const client = await pool.connect()
  try {
    if (verifyOnly) {
      const result = await verify(client)
      console.log(JSON.stringify({ mode: 'verify', catalogRows: rows.length, ...result }, null, 2))
      if (result.mismatches.length) process.exitCode = 2
      return
    }

    await client.query('BEGIN')
    const actorResult = await client.query(
      `SELECT id FROM users WHERE is_active = true AND role IN ('owner', 'admin')
       ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at LIMIT 1`
    )
    const actorId = actorResult.rows[0]?.id || null

    let categoryResult = await client.query('SELECT id FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1', [categoryName])
    if (!categoryResult.rows[0]) {
      categoryResult = await client.query(
        'INSERT INTO categories (name, description) VALUES ($1, $2) RETURNING id',
        [categoryName, 'Imported product category']
      )
    }
    const categoryId = categoryResult.rows[0].id

    const summary = {
      mode: dryRun ? 'dry-run' : 'import',
      sourceFile,
      catalogRows: rows.length,
      matched: 0,
      created: 0,
      skuGenerated: 0,
      stockChanged: 0,
      stockUnchanged: 0,
      unitsBefore: 0,
      unitsAfter: 0
    }

    for (const row of rows) {
      const matches = await client.query(
        `SELECT p.*, COALESCE(i.quantity, 0)::int AS stock_quantity,
                COALESCE(i.reserved_quantity, 0)::int AS reserved_quantity
         FROM products p
         LEFT JOIN inventory i ON i.product_id = p.id
         WHERE LOWER(p.name) = LOWER($1)
         FOR UPDATE OF p`,
        [row.name]
      )
      if (matches.rowCount > 1) throw new Error(`Ambiguous existing product name: ${row.name}`)

      let product
      let oldValues = null
      if (matches.rows[0]) {
        summary.matched += 1
        const existing = matches.rows[0]
        if (row.stockQuantity < existing.reserved_quantity) {
          throw new Error(
            `${row.name}: CSV stock ${row.stockQuantity} is below reserved stock ${existing.reserved_quantity}`
          )
        }
        oldValues = {
          sku: existing.sku,
          name: existing.name,
          category_id: existing.category_id,
          cost_price: Number(existing.cost_price),
          selling_price: Number(existing.selling_price),
          stock_quantity: existing.stock_quantity,
          is_dropship: existing.is_dropship,
          is_active: existing.is_active,
          deleted_at: existing.deleted_at
        }
        let sku = existing.sku
        if (!sku) {
          sku = await uniqueGeneratedSku(client, categoryName, row.name)
          summary.skuGenerated += 1
        }
        const updated = await client.query(
          `UPDATE products
           SET sku = $1, name = $2, category_id = $3, cost_price = $4, selling_price = $5,
               is_active = true, deleted_at = NULL, updated_at = NOW()
           WHERE id = $6 RETURNING *`,
          [sku, row.name, categoryId, row.costPrice, row.sellingPrice, existing.id]
        )
        product = { ...updated.rows[0], stock_quantity: existing.stock_quantity }
      } else {
        summary.created += 1
        summary.skuGenerated += 1
        const sku = await uniqueGeneratedSku(client, categoryName, row.name)
        const inserted = await client.query(
          `INSERT INTO products
             (sku, name, category_id, cost_price, selling_price, is_active, is_dropship)
           VALUES ($1, $2, $3, $4, $5, true, false)
           RETURNING *`,
          [sku, row.name, categoryId, row.costPrice, row.sellingPrice]
        )
        product = { ...inserted.rows[0], stock_quantity: 0 }
      }

      const inventoryResult = await client.query(
        `INSERT INTO inventory (product_id, quantity)
         VALUES ($1, $2)
         ON CONFLICT (product_id) DO UPDATE
         SET quantity = EXCLUDED.quantity, last_updated = NOW()
         RETURNING quantity`,
        [product.id, row.stockQuantity]
      )
      const beforeQuantity = Number(product.stock_quantity)
      const afterQuantity = Number(inventoryResult.rows[0].quantity)
      summary.unitsBefore += beforeQuantity
      summary.unitsAfter += afterQuantity

      if (beforeQuantity !== afterQuantity) {
        summary.stockChanged += 1
        await client.query(
          `INSERT INTO inventory_movements
             (product_id, type, quantity, before_quantity, after_quantity, reference_type, notes, created_by)
           VALUES ($1, 'adjustment', $2, $3, $4, 'product_import', $5, $6)`,
          [
            product.id,
            afterQuantity - beforeQuantity,
            beforeQuantity,
            afterQuantity,
            `Physical stock replaced from ${sourceFile}`,
            actorId
          ]
        )
      } else {
        summary.stockUnchanged += 1
      }

      const newValues = {
        sku: product.sku,
        name: row.name,
        category_id: categoryId,
        category_name: categoryName,
        cost_price: row.costPrice,
        selling_price: row.sellingPrice,
        stock_quantity: afterQuantity,
        is_dropship: product.is_dropship,
        is_active: true
      }
      await client.query(
        `INSERT INTO audit_logs
           (user_id, action, entity_type, entity_id, old_values, new_values, metadata)
         VALUES ($1, $2, 'product', $3, $4::jsonb, $5::jsonb, $6::jsonb)`,
        [
          actorId,
          oldValues ? 'product_import_updated' : 'product_import_created',
          product.id,
          JSON.stringify(oldValues),
          JSON.stringify(newValues),
          JSON.stringify({ source_file: sourceFile, row_number: row.rowNumber, stock_mode: 'replace' })
        ]
      )
    }

    const verification = await verify(client)
    if (verification.mismatches.length) {
      throw new Error(`Post-import verification failed: ${JSON.stringify(verification.mismatches)}`)
    }

    if (dryRun) await client.query('ROLLBACK')
    else await client.query('COMMIT')
    console.log(JSON.stringify({ ...summary, verified: verification.verified }, null, 2))
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The transaction may already have ended.
    }
    throw error
  } finally {
    client.release()
  }
}

try {
  await run()
} finally {
  await pool.end()
}
