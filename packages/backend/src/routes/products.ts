import { Router } from 'express'
import { createHash } from 'node:crypto'
import { query, transaction } from '../db'
import { auditMiddleware } from '../middleware/audit'
import { paginatedResponse, paginationFromQuery } from '../utils/pagination'

const router = Router()

const numberValue = (value: unknown, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const generatedSku = (category: string, name: string) => {
  const prefix = category.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || 'ITEM'
  const digest = createHash('sha1').update(name.trim().toLowerCase()).digest('hex').slice(0, 8).toUpperCase()
  return `${prefix}-${digest}`
}

const uniqueGeneratedSku = async (
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> },
  category: string,
  name: string
) => {
  const base = generatedSku(category, name)
  for (let suffix = 1; suffix <= 9999; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`
    const existing = await client.query('SELECT 1 FROM products WHERE sku = $1 LIMIT 1', [candidate])
    if (!existing.rows[0]) return candidate
  }
  throw new Error('Unable to generate a unique SKU')
}

router.get('/categories', async (_req, res) => {
  try {
    const result = await query(`
      SELECT c.id, c.name, c.description, COUNT(p.id)::int AS product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.deleted_at IS NULL
      GROUP BY c.id
      ORDER BY c.name
    `)
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/categories', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim()
    if (!name) return res.status(400).json({ error: { message: 'Category name is required' } })
    const existing = await query('SELECT * FROM categories WHERE LOWER(name) = LOWER($1)', [name])
    if (existing.rows[0]) return res.status(400).json({ error: { message: 'Category already exists' } })
    const result = await query(
      'INSERT INTO categories (name, description) VALUES ($1, $2) RETURNING *',
      [name, req.body.description || null]
    )
    res.status(201).json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/categories/:id', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim()
    if (!name) return res.status(400).json({ error: { message: 'Category name is required' } })
    const duplicate = await query('SELECT id FROM categories WHERE LOWER(name) = LOWER($1) AND id != $2', [name, req.params.id])
    if (duplicate.rows[0]) return res.status(400).json({ error: { message: 'Category already exists' } })
    const result = await query(
      'UPDATE categories SET name = $1, description = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [name, req.body.description || null, req.params.id]
    )
    if (!result.rows[0]) return res.status(404).json({ error: { message: 'Category not found' } })
    res.json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.delete('/categories/:id', async (req, res) => {
  try {
    const products = await query('SELECT COUNT(*)::int AS count FROM products WHERE category_id = $1 AND deleted_at IS NULL', [req.params.id])
    if (products.rows[0].count > 0) {
      return res.status(400).json({ error: { message: 'Move products out of this category before deleting it' } })
    }
    await query('DELETE FROM categories WHERE id = $1', [req.params.id])
    res.status(204).send()
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/import', async (req, res) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : []
    const duplicateMode = req.body.duplicate_mode === 'update' ? 'update' : 'skip'
    const defaultCategory = String(req.body.default_category || '').trim()
    const replaceCategory = req.body.replace_category === true
    if (rows.length === 0) return res.status(400).json({ error: { message: 'No product rows supplied' } })
    if (rows.length > 2000) return res.status(400).json({ error: { message: 'Import is limited to 2,000 products at a time' } })
    if (replaceCategory && !defaultCategory) {
      return res.status(400).json({ error: { message: 'A default category is required to replace a catalogue' } })
    }

    const summary = await transaction(async client => {
      let created = 0
      let updated = 0
      let skipped = 0
      let archived = 0
      const importedProductIds: string[] = []
      const errors: Array<{ row: number; message: string }> = []

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]
        const name = String(row.name || '').trim()
        const suppliedSku = String(row.sku || '').trim() || null
        const sellingPriceText = String(row.selling_price ?? '').trim()
        const sellingPrice = numberValue(sellingPriceText, NaN)
        if (!name || !sellingPriceText || !Number.isFinite(sellingPrice) || sellingPrice < 0) {
          errors.push({ row: index + 2, message: 'Name and a valid selling_price are required' })
          continue
        }

        let categoryId: string | null = null
        const categoryName = String(row.category || defaultCategory).split(',')[0].split('>').pop()?.trim() || ''
        if (categoryName) {
          const category = await client.query('SELECT id FROM categories WHERE LOWER(name) = LOWER($1)', [categoryName])
          if (category.rows[0]) {
            categoryId = category.rows[0].id
          } else {
            const createdCategory = await client.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [categoryName])
            categoryId = createdCategory.rows[0].id
          }
        }

        const fulfillmentText = String(row.is_dropship || '').trim().toLowerCase()
        const hasFulfillmentPreference = fulfillmentText !== ''
        const dropship = ['true', 'yes', '1', 'supplier'].includes(fulfillmentText)
        const existing = await client.query(
          `SELECT id, sku, is_dropship, deleted_at FROM products
           WHERE (($1::text IS NOT NULL AND sku = $1) OR LOWER(name) = LOWER($2))
           ORDER BY CASE WHEN $1::text IS NOT NULL AND sku = $1 THEN 0 ELSE 1 END
           LIMIT 1`,
          [suppliedSku, name]
        )
        if (existing.rows[0] && duplicateMode === 'skip' && !existing.rows[0].deleted_at) {
          importedProductIds.push(existing.rows[0].id)
          skipped += 1
          continue
        }
        const sku = suppliedSku || existing.rows[0]?.sku || generatedSku(categoryName, name)
        const preferredSupplier = hasFulfillmentPreference ? dropship : Boolean(existing.rows[0]?.is_dropship)

        let productId: string
        if (existing.rows[0]) {
          const result = await client.query(
            `UPDATE products SET name = $1, sku = $2, barcode = COALESCE($3, barcode),
              category_id = COALESCE($4, category_id), cost_price = $5,
              selling_price = $6, reorder_level = $7, is_dropship = $8,
              deleted_at = NULL, is_active = TRUE, updated_at = NOW()
             WHERE id = $9 RETURNING id`,
            [
              name, sku, String(row.barcode || '').trim() || null, categoryId,
              numberValue(row.cost_price), sellingPrice, Math.max(0, Math.trunc(numberValue(row.reorder_level))),
              preferredSupplier, existing.rows[0].id
            ]
          )
          productId = result.rows[0].id
          updated += 1
        } else {
          const result = await client.query(
            `INSERT INTO products (name, sku, barcode, category_id, cost_price, selling_price, reorder_level, is_dropship)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              name, sku, String(row.barcode || '').trim() || null, categoryId,
              numberValue(row.cost_price), sellingPrice, Math.max(0, Math.trunc(numberValue(row.reorder_level))), preferredSupplier
            ]
          )
          productId = result.rows[0].id
          created += 1
        }
        importedProductIds.push(productId)

        const hasStockQuantity = String(row.stock_quantity ?? '').trim() !== ''
        if (!existing.rows[0] || hasStockQuantity) {
          const stockQuantity = Math.max(0, Math.trunc(numberValue(row.stock_quantity)))
          const currentInventory = await client.query('SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE', [productId])
          const previousQuantity = numberValue(currentInventory.rows[0]?.quantity)
          const inventory = await client.query(
            'UPDATE inventory SET quantity = $1, last_updated = NOW() WHERE product_id = $2 RETURNING id',
            [stockQuantity, productId]
          )
          if (!inventory.rows[0]) {
            await client.query('INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)', [productId, stockQuantity])
          }
          const movementQuantity = stockQuantity - previousQuantity
          if (movementQuantity !== 0) {
            await client.query(
              `INSERT INTO inventory_movements
                (product_id, type, quantity, reference_type, notes, created_by)
               VALUES ($1, 'adjustment', $2, 'product_import', $3, $4)`,
              [productId, movementQuantity, 'Stock quantity set by product import', req.user?.userId]
            )
          }
        }
      }

      if (replaceCategory && errors.length === 0) {
        const category = await client.query('SELECT id FROM categories WHERE LOWER(name) = LOWER($1)', [defaultCategory])
        if (category.rows[0]) {
          const result = await client.query(
            `UPDATE products
             SET deleted_at = NOW(), is_active = FALSE, updated_at = NOW()
             WHERE category_id = $1
               AND deleted_at IS NULL
               AND NOT (id = ANY($2::uuid[]))`,
            [category.rows[0].id, importedProductIds]
          )
          archived = result.rowCount || 0
        }
      }
      return { created, updated, skipped, archived, errors, processed: rows.length }
    })
    res.json(summary)
  } catch (error: any) {
    const message = error?.code === '23505' ? 'The import contains a duplicate SKU' : 'Product import failed'
    res.status(400).json({ error: { message } })
  }
})

router.get('/', async (req, res) => {
  try {
    const { search, category, brand } = req.query
    let sql = `SELECT p.*, c.name as category_name, b.name as brand_name,
        COALESCE(i.quantity, 0) AS stock_quantity,
        COALESCE(i.quantity - i.reserved_quantity, 0) AS available_stock
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN brands b ON p.brand_id = b.id
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.deleted_at IS NULL`
    const params: any[] = []
    if (search) {
      sql += ` AND (p.name ILIKE $${params.length + 1} OR p.sku ILIKE $${params.length + 1} OR p.barcode ILIKE $${params.length + 1})`
      params.push(`%${search}%`)
    }
    if (category) {
      sql += ` AND p.category_id = $${params.length + 1}`
      params.push(category)
    }
    if (brand) {
      sql += ` AND p.brand_id = $${params.length + 1}`
      params.push(brand)
    }
    const pagination = paginationFromQuery(req.query)
    let total = 0
    if (pagination) {
      const countResult = await query(`SELECT COUNT(*)::int AS total FROM (${sql}) products_list`, params)
      total = countResult.rows[0].total
      params.push(pagination.pageSize, pagination.offset)
      sql += ` ORDER BY p.name LIMIT $${params.length - 1} OFFSET $${params.length}`
    } else {
      sql += ' ORDER BY p.name LIMIT 500'
    }
    const result = await query(sql, params)
    res.json(pagination ? paginatedResponse(result.rows, total, pagination) : result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/:id', async (req, res) => {
  const result = await query(
    `SELECT p.*, c.name as category_name, b.name as brand_name
     FROM products p LEFT JOIN categories c ON p.category_id = c.id
     LEFT JOIN brands b ON p.brand_id = b.id WHERE p.id = $1`,
    [req.params.id]
  )
  res.json(result.rows[0])
})

router.post('/', auditMiddleware('product', 'product_created'), async (req, res) => {
  try {
    const {
      name, sku, barcode, category_id, brand_id, cost_price, selling_price,
      reorder_level, images, is_dropship
    } = req.body
    const product = await transaction(async client => {
      const category = category_id
        ? await client.query('SELECT name FROM categories WHERE id = $1', [category_id])
        : { rows: [] }
      const finalSku = String(sku || '').trim()
        || await uniqueGeneratedSku(client, category.rows[0]?.name || 'Item', String(name || 'Product'))
      const result = await client.query(
        `INSERT INTO products (name, sku, barcode, category_id, brand_id, cost_price, selling_price, reorder_level, images, is_dropship)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          name, finalSku, barcode || null, category_id || null, brand_id || null,
          numberValue(cost_price), numberValue(selling_price), numberValue(reorder_level), images || null, Boolean(is_dropship)
        ]
      )
      await client.query('INSERT INTO inventory (product_id, quantity) VALUES ($1, 0)', [result.rows[0].id])
      return result.rows[0]
    })
    res.status(201).json(product)
  } catch (error: any) {
    res.status(error?.code === '23505' ? 400 : 500).json({ error: { message: error?.code === '23505' ? 'SKU already exists' : 'Database error' } })
  }
})

router.put('/:id', auditMiddleware('product', 'product_updated'), async (req, res) => {
  try {
    const product = await transaction(async client => {
      const current = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [req.params.id])
      if (!current.rows[0]) throw Object.assign(new Error('Product not found'), { statusCode: 404 })
      const isDropship = Boolean(req.body.is_dropship)
      const result = await client.query(
        `UPDATE products SET name = $1, sku = $2, barcode = $3, category_id = $4,
          brand_id = $5, cost_price = $6, selling_price = $7, reorder_level = $8,
          images = $9, is_dropship = $10, updated_at = NOW()
         WHERE id = $11 RETURNING *`,
        [
          req.body.name, req.body.sku || null, req.body.barcode || null, req.body.category_id || null,
          req.body.brand_id || null, numberValue(req.body.cost_price), numberValue(req.body.selling_price),
          numberValue(req.body.reorder_level), req.body.images || null, isDropship, req.params.id
        ]
      )
      await client.query(
        'INSERT INTO inventory (product_id, quantity) VALUES ($1, 0) ON CONFLICT (product_id) DO NOTHING',
        [req.params.id]
      )
      return result.rows[0]
    })
    res.json(product)
  } catch (error: any) {
    const status = error.statusCode || (error?.code === '23505' ? 400 : 500)
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : error.message || 'SKU already exists' } })
  }
})

router.delete('/:id', auditMiddleware('product', 'product_deleted'), async (req, res) => {
  await query('UPDATE products SET deleted_at = NOW(), is_active = false WHERE id = $1', [req.params.id])
  res.status(204).send()
})

export { router as productRoutes }
