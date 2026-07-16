import { Router } from 'express'
import { query, transaction } from '../db/index.js'
import { normalizeKenyanPhone } from '../utils/phone.js'
import { paginatedResponse, paginationFromQuery } from '../utils/pagination.js'
import { logAudit } from '../utils/audit.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const { search } = req.query
    
    let sql = 'SELECT * FROM customers WHERE 1=1'
    const params: any[] = []
    const conditions: string[] = []

    if (search) {
      conditions.push('name ILIKE $1 OR phone ILIKE $1')
      params.push(`%${search}%`)
    }

    if (conditions.length > 0) {
      sql += ' AND ' + conditions.join(' AND ')
    }

    const pagination = paginationFromQuery(req.query)
    let total = 0
    if (pagination) {
      const countResult = await query(`SELECT COUNT(*)::int AS total FROM (${sql}) customers_list`, params)
      total = countResult.rows[0].total
      params.push(pagination.pageSize, pagination.offset)
      sql += ` ORDER BY name LIMIT $${params.length - 1} OFFSET $${params.length}`
    } else {
      sql += ' ORDER BY name'
    }

    const result = await query(sql, params)
    res.json(pagination ? paginatedResponse(result.rows, total, pagination) : result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/', async (req, res) => {
  try {
    const { name, phone, email, address, credit_limit } = req.body
    if (!name?.trim()) return res.status(400).json({ error: { message: 'Customer name is required' } })
    const normalizedPhone = normalizeKenyanPhone(phone)
    const result = await query(
      'INSERT INTO customers (name, phone, normalized_phone, email, address, credit_limit) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, phone, normalizedPhone, email, address, credit_limit]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    if ((err as any).code === '23505') {
      return res.status(409).json({ error: { message: 'A customer with this phone number already exists' } })
    }
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, phone, email, address, credit_limit } = req.body
    const normalizedPhone = normalizeKenyanPhone(phone)
    const result = await query(
      'UPDATE customers SET name = $1, phone = $2, normalized_phone = $3, email = $4, address = $5, credit_limit = $6, updated_at = NOW() WHERE id = $7 RETURNING *',
      [name, phone, normalizedPhone, email, address, credit_limit, id]
    )
    res.json(result.rows[0])
  } catch (err) {
    if ((err as any).code === '23505') {
      return res.status(409).json({ error: { message: 'A customer with this phone number already exists' } })
    }
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    await query('DELETE FROM customers WHERE id = $1', [id])
    res.status(204).send()
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/:id/payments', async (req, res) => {
  try {
    const { id } = req.params
    const { amount, order_id, payment_method, reference } = req.body

    const result = await transaction(async (client) => {
      const paymentAmount = Number(amount || 0)
      if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
        throw Object.assign(new Error('Payment amount must be greater than zero'), { statusCode: 400 })
      }

      const customerResult = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [id])
      const customer = customerResult.rows[0]
      if (!customer) {
        throw Object.assign(new Error('Customer not found'), { statusCode: 404 })
      }

      const appliedAmount = Math.min(paymentAmount, Number(customer.balance || 0))
      if (appliedAmount <= 0) {
        throw Object.assign(new Error('This customer has no outstanding credit balance'), { statusCode: 409 })
      }

      await client.query(
        'INSERT INTO customer_credits (customer_id, order_id, amount, type, created_by) VALUES ($1, $2, $3, $4, $5)',
        [id, order_id || null, -appliedAmount, 'payment', req.user?.userId]
      )

      await client.query(
        'UPDATE customers SET balance = GREATEST(balance - $1, 0), updated_at = NOW() WHERE id = $2',
        [appliedAmount, id]
      )

      if (order_id) {
        const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [order_id])
        const order = orderResult.rows[0]
        if (order) {
          const newPaidAmount = Number(order.paid_amount || 0) + appliedAmount
          const totalAmount = Number(order.total_amount || 0)
          const paymentStatus = newPaidAmount >= totalAmount ? 'paid' : 'partially_paid'

          await client.query(
            'INSERT INTO order_payments (order_id, amount, payment_method, reference, created_by) VALUES ($1, $2, $3, $4, $5)',
            [order_id, appliedAmount, payment_method || 'cash', reference || null, req.user?.userId]
          )

          await client.query(
            'UPDATE orders SET paid_amount = $1, payment_status = $2, updated_at = NOW() WHERE id = $3',
            [newPaidAmount, paymentStatus, order_id]
          )
        }
      }

      await logAudit({
        req,
        client,
        action: 'customer_credit_payment_recorded',
        entityType: 'customer',
        entityId: id,
        newValues: { amount: appliedAmount, order_id: order_id || null, reference: reference || null },
        metadata: { amount: appliedAmount, payment_method: payment_method || 'cash' }
      })

      return { success: true, applied_amount: appliedAmount }
    })

    res.status(201).json(result)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.get('/:id/credit-history', async (req, res) => {
  try {
    const { id } = req.params
    const result = await query(
      'SELECT * FROM customer_credits WHERE customer_id = $1 ORDER BY created_at DESC',
      [id]
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/:id/ledger', async (req, res) => {
  try {
    const { id } = req.params
    const result = await query(
      `SELECT cc.*, o.order_number
       FROM customer_credits cc
       LEFT JOIN orders o ON cc.order_id = o.id
       WHERE cc.customer_id = $1
       ORDER BY cc.created_at DESC`,
      [id]
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as customerRoutes }
