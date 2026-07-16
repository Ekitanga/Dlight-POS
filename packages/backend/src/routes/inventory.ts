import { Router } from 'express'
import { query, transaction } from '../db/index.js'
import { auditMiddleware } from '../middleware/audit.js'
import { authMiddleware } from '../middleware/auth.js'
import { paginatedResponse, paginationFromQuery } from '../utils/pagination.js'

const router = Router()

router.use(authMiddleware)

function toNumber(value: unknown): number {
  const numberValue = Number(value || 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

router.post('/adjust', auditMiddleware('inventory', 'inventory_adjusted'), async (req, res) => {
  try {
    const { product_id, type, quantity, notes } = req.body
    const created_by = req.user?.userId

    const adjusted = await transaction(async (client) => {
      const adjustmentQuantity = toNumber(quantity)
      if (!product_id || adjustmentQuantity < 1) {
        throw Object.assign(new Error('Product and positive quantity are required'), { statusCode: 400 })
      }

      const inventoryResult = await client.query('SELECT * FROM inventory WHERE product_id = $1 FOR UPDATE', [product_id])
      let inventory = inventoryResult.rows[0]
      if (!inventory && type === 'stock_in') {
        const createdInventory = await client.query(
          'INSERT INTO inventory (product_id, quantity) VALUES ($1, 0) RETURNING *',
          [product_id]
        )
        inventory = createdInventory.rows[0]
      }

      if (!inventory) {
        throw Object.assign(new Error('Missing inventory record'), { statusCode: 400 })
      }

      const onHand = toNumber(inventory.quantity)
      const reserved = toNumber(inventory.reserved_quantity)
      const available = onHand - reserved

      await client.query(
        'INSERT INTO inventory_movements (product_id, type, quantity, reference_type, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [product_id, type, adjustmentQuantity, 'adjustment', notes, created_by]
      )

      switch (type) {
        case 'stock_in':
          await client.query('UPDATE inventory SET quantity = quantity + $1, last_updated = NOW() WHERE product_id = $2', [adjustmentQuantity, product_id])
          break
        case 'stock_out':
          if (available < adjustmentQuantity) {
            throw Object.assign(new Error('Insufficient available stock'), { statusCode: 400 })
          }
          await client.query('UPDATE inventory SET quantity = quantity - $1, last_updated = NOW() WHERE product_id = $2', [adjustmentQuantity, product_id])
          break
        case 'damaged':
          if (available < adjustmentQuantity) {
            throw Object.assign(new Error('Insufficient available stock'), { statusCode: 400 })
          }
          await client.query('UPDATE inventory SET damaged_quantity = damaged_quantity + $1, quantity = quantity - $1, last_updated = NOW() WHERE product_id = $2', [adjustmentQuantity, product_id])
          break
        case 'lost':
          if (available < adjustmentQuantity) {
            throw Object.assign(new Error('Insufficient available stock'), { statusCode: 400 })
          }
          await client.query('UPDATE inventory SET lost_quantity = lost_quantity + $1, quantity = quantity - $1, last_updated = NOW() WHERE product_id = $2', [adjustmentQuantity, product_id])
          break
        case 'reserved':
          if (available < adjustmentQuantity) {
            throw Object.assign(new Error('Insufficient available stock'), { statusCode: 400 })
          }
          await client.query('UPDATE inventory SET reserved_quantity = reserved_quantity + $1, last_updated = NOW() WHERE product_id = $2', [adjustmentQuantity, product_id])
          break
        case 'reservation_release':
          if (reserved < adjustmentQuantity) {
            throw Object.assign(new Error('Insufficient reserved stock'), { statusCode: 400 })
          }
          await client.query('UPDATE inventory SET reserved_quantity = reserved_quantity - $1, last_updated = NOW() WHERE product_id = $2', [adjustmentQuantity, product_id])
          break
        case 'return_sellable':
          await client.query('UPDATE inventory SET returned_quantity = returned_quantity + $1, quantity = quantity + $1, last_updated = NOW() WHERE product_id = $2', [adjustmentQuantity, product_id])
          break
        case 'return_damaged':
          await client.query('UPDATE inventory SET returned_quantity = returned_quantity + $1, damaged_quantity = damaged_quantity + $1, last_updated = NOW() WHERE product_id = $2', [adjustmentQuantity, product_id])
          break
        default:
          throw Object.assign(new Error('Invalid adjustment type'), { statusCode: 400 })
      }

      const result = await client.query(
        'SELECT * FROM inventory WHERE product_id = $1',
        [product_id]
      )

      await client.query(
        'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values) VALUES ($1, $2, $3, $4, $5)',
        [created_by, 'inventory_adjusted', 'inventory', product_id, JSON.stringify({ type, quantity: adjustmentQuantity, notes })]
      )

      return result.rows[0]
    })

    res.status(201).json(adjusted)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.get('/', async (req, res) => {
  try {
    const { search, low_stock } = req.query
    const params: any[] = []
    let sql = `
      SELECT
        COALESCE(i.id, p.id) as id,
        p.id as product_id,
        p.name as product_name,
        p.sku,
        COALESCE(i.quantity, 0) as quantity,
        COALESCE(i.reserved_quantity, 0) as reserved_quantity,
        COALESCE(i.damaged_quantity, 0) as damaged_quantity,
        COALESCE(i.lost_quantity, 0) as lost_quantity,
        COALESCE(i.returned_quantity, 0) as returned_quantity,
        (COALESCE(i.quantity, 0) - COALESCE(i.reserved_quantity, 0)) as available_stock,
        p.reorder_level,
        p.cost_price,
        p.selling_price
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.deleted_at IS NULL
    `

    if (search) {
      sql += ' AND (p.name ILIKE $1 OR p.sku ILIKE $1)'
      params.push(`%${search}%`)
    }
    if (low_stock === 'true') {
      sql += ' AND (COALESCE(i.quantity, 0) - COALESCE(i.reserved_quantity, 0)) <= p.reorder_level'
    }

    const pagination = paginationFromQuery(req.query)
    let total = 0
    if (pagination) {
      const countResult = await query(`SELECT COUNT(*)::int AS total FROM (${sql}) inventory_list`, params)
      total = countResult.rows[0].total
      params.push(pagination.pageSize, pagination.offset)
      sql += ` ORDER BY p.name, p.selling_price, p.sku LIMIT $${params.length - 1} OFFSET $${params.length}`
    } else {
      sql += ' ORDER BY p.name, p.selling_price, p.sku'
    }
    const result = await query(sql, params)
    res.json(pagination ? paginatedResponse(result.rows, total, pagination) : result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as inventoryRoutes }
