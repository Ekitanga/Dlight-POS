import { Router } from 'express'
import { query, transaction } from '../db/index.js'
import { paginatedResponse, paginationFromQuery } from '../utils/pagination.js'
import { logAudit } from '../utils/audit.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const { search, date_from, date_to, status, cod_outstanding } = req.query
    const params: any[] = []
    const conditions: string[] = []
    if (search) {
      conditions.push(`(o.order_number ILIKE $${params.length + 1} OR c.name ILIKE $${params.length + 1})`)
      params.push(`%${search}%`)
    }
    if (date_from) {
      conditions.push(`d.created_at::date >= $${params.length + 1}`)
      params.push(date_from)
    }
    if (date_to) {
      conditions.push(`d.created_at::date <= $${params.length + 1}`)
      params.push(date_to)
    }
    if (status) {
      conditions.push(`d.delivery_status = $${params.length + 1}`)
      params.push(status)
    }
    if (cod_outstanding === 'true') {
      conditions.push("o.courier_payment_type='cod' AND COALESCE(cc.cod_amount-cc.remitted_amount,0)>0")
    }
    let sql = `SELECT d.*, o.order_number, o.status AS order_status, o.payment_status,
        o.courier_payment_type, c.name AS customer_name, r.name AS rider_name,
        cr.name AS courier_name, cc.status AS cod_status, cc.cod_amount,
        cc.remitted_amount, (cc.cod_amount - cc.remitted_amount) AS cod_outstanding
       FROM deliveries d
       JOIN orders o ON d.order_id = o.id
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN riders r ON d.rider_id = r.id
       LEFT JOIN couriers cr ON d.courier_id = cr.id
       LEFT JOIN cod_collections cc ON d.order_id = cc.order_id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}`
    const pagination = paginationFromQuery(req.query)
    let total = 0
    if (pagination) {
      const countResult = await query(`SELECT COUNT(*)::int AS total FROM (${sql}) deliveries_list`, params)
      total = countResult.rows[0].total
      params.push(pagination.pageSize, pagination.offset)
      sql += ` ORDER BY d.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`
    } else {
      sql += ' ORDER BY d.created_at DESC LIMIT 200'
    }
    const result = await query(sql, params)
    res.json(pagination ? paginatedResponse(result.rows, total, pagination) : result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/orders/:orderId/delivery', (_req, res) => {
  res.status(409).json({ error: { message: 'Create and assign delivery through the order workflow' } })
})

router.put('/:deliveryId/status', (_req, res) => {
  res.status(409).json({ error: { message: 'Update delivery status through the order workflow' } })
})

router.put('/orders/:orderId/delivery/status', (_req, res) => {
  res.status(409).json({ error: { message: 'Update delivery status through the order workflow' } })
})

router.post('/orders/:orderId/cod', async (req, res) => {
  try {
    const { orderId } = req.params
    const { amount, reference, payment_method } = req.body
    const result = await transaction(async client => {
      const remittedAmount = Number(amount || 0)
      if (!Number.isFinite(remittedAmount) || remittedAmount <= 0) {
        throw Object.assign(new Error('COD amount must be greater than zero'), { statusCode: 400 })
      }
      if (!String(reference || '').trim()) {
        throw Object.assign(new Error('Speedaf remittance reference is required'), { statusCode: 400 })
      }
      const method = payment_method === 'bank' ? 'bank_transfer' : payment_method || 'mpesa'
      if (!['mpesa', 'bank_transfer'].includes(method)) {
        throw Object.assign(new Error('COD remittance method must be M-PESA or Bank'), { statusCode: 400 })
      }

      const orderResult = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
      const order = orderResult.rows[0]
      if (!order) throw Object.assign(new Error('Order not found'), { statusCode: 404 })

      const codResult = await client.query('SELECT * FROM cod_collections WHERE order_id = $1 FOR UPDATE', [orderId])
      const cod = codResult.rows[0]
      if (!cod) throw Object.assign(new Error('COD record not found'), { statusCode: 404 })
      if (!['delivered_awaiting_remittance', 'partially_remitted', 'disputed'].includes(cod.status)) {
        throw Object.assign(new Error('COD remittance can only be recorded after customer delivery'), { statusCode: 400 })
      }

      const outstanding = Math.max(0, Number(cod.cod_amount) - Number(cod.remitted_amount))
      if (remittedAmount > outstanding) {
        throw Object.assign(new Error(`Amount exceeds outstanding COD balance of KES ${Math.round(outstanding).toLocaleString('en-KE')}`), { statusCode: 400 })
      }

      await client.query(
        `INSERT INTO cod_remittances
          (cod_collection_id, order_id, amount, payment_method, reference, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [cod.id, orderId, remittedAmount, method, String(reference).trim(), req.user?.userId]
      )
      await client.query(
        `INSERT INTO order_payments (order_id, amount, payment_method, reference, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, remittedAmount, method, String(reference).trim(), req.user?.userId]
      )

      const newRemittedAmount = Number(cod.remitted_amount) + remittedAmount
      const fullyRemitted = newRemittedAmount >= Number(cod.cod_amount)
      const codStatus = fullyRemitted ? 'remitted' : 'partially_remitted'
      await client.query(
        `UPDATE cod_collections SET remitted_amount = $1, status = $2, remitted_at = NOW(),
          closed_at = CASE WHEN $3 THEN NOW() ELSE closed_at END WHERE id = $4`,
        [newRemittedAmount, codStatus, fullyRemitted, cod.id]
      )

      const paymentTotal = await client.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM order_payments WHERE order_id = $1',
        [orderId]
      )
      const paidAmount = Number(paymentTotal.rows[0].total)
      const paymentStatus = paidAmount >= Number(order.total_amount) ? 'paid' : 'partially_paid'
      await client.query(
        `UPDATE orders SET paid_amount = $1, payment_status = $2,
          status = CASE WHEN $3 THEN 'collected_paid' ELSE status END, updated_at = NOW()
         WHERE id = $4`,
        [paidAmount, paymentStatus, fullyRemitted, orderId]
      )
      if (fullyRemitted) {
        await client.query("UPDATE deliveries SET delivery_status = 'collected_paid' WHERE order_id = $1", [orderId])
      }
      await logAudit({
        req,
        client,
        action: 'cod_remittance_recorded',
        entityType: 'order',
        entityId: orderId,
        oldValues: { cod_status: cod.status, remitted_amount: cod.remitted_amount, payment_status: order.payment_status, paid_amount: order.paid_amount },
        newValues: { amount: remittedAmount, reference: String(reference).trim(), payment_method: method, cod_status: codStatus, paid_amount: paidAmount, payment_status: paymentStatus },
        metadata: {
          order_number: order.order_number,
          courier_payment_type: order.courier_payment_type,
          fully_remitted: fullyRemitted
        }
      })
      return { paid_amount: paidAmount, payment_status: paymentStatus, cod_status: codStatus }
    })
    res.status(201).json(result)
  } catch (error) {
    const status = (error as any).statusCode || ((error as any).code === '23505' ? 409 : 500)
    const message = (error as any).code === '23505'
      ? 'This COD remittance reference has already been recorded'
      : status === 500 ? 'Database error' : (error as Error).message
    res.status(status).json({ error: { message } })
  }
})

router.get('/cod/ledger', async (_req, res) => {
  try {
    const result = await query(`
      SELECT cc.*, o.order_number, c.name AS customer_name, cr.name AS courier_name,
        (cc.cod_amount - cc.remitted_amount) AS outstanding_amount,
        CASE WHEN cc.delivered_at IS NOT NULL THEN CURRENT_DATE - cc.delivered_at::date END AS age_days
      FROM cod_collections cc
      JOIN orders o ON cc.order_id = o.id
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN couriers cr ON cc.courier_id = cr.id
      ORDER BY cc.created_at DESC
    `)
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/cod/ageing', async (_req, res) => {
  try {
    const result = await query(`
      SELECT CASE
        WHEN delivered_at IS NULL THEN 'not_delivered'
        WHEN CURRENT_DATE - delivered_at::date <= 3 THEN '0_3_days'
        WHEN CURRENT_DATE - delivered_at::date <= 7 THEN '4_7_days'
        WHEN CURRENT_DATE - delivered_at::date <= 14 THEN '8_14_days'
        ELSE '15_plus_days'
      END AS ageing_bucket,
      COUNT(*)::int AS order_count,
      COALESCE(SUM(cod_amount - remitted_amount), 0) AS outstanding_amount
      FROM cod_collections
      WHERE status IN ('delivered_awaiting_remittance', 'partially_remitted', 'disputed')
      GROUP BY ageing_bucket
      ORDER BY ageing_bucket
    `)
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/cod/couriers', async (_req, res) => {
  try {
    const result = await query(`
      SELECT cr.id AS courier_id, cr.name AS courier_name, COUNT(cc.id)::int AS cod_count,
        COALESCE(SUM(cc.cod_amount), 0) AS total_cod,
        COALESCE(SUM(cc.remitted_amount), 0) AS remitted_amount,
        COALESCE(SUM(cc.cod_amount - cc.remitted_amount), 0) AS outstanding_amount
      FROM cod_collections cc
      LEFT JOIN couriers cr ON cc.courier_id = cr.id
      GROUP BY cr.id, cr.name
      ORDER BY outstanding_amount DESC
    `)
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/cod/:codId/status', async (req, res) => {
  try {
    const allowed = ['disputed', 'lost', 'returned']
    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ error: { message: 'Invalid COD exception status' } })
    }
    const result = await query(
      `UPDATE cod_collections SET status = $1, notes = COALESCE($2, notes),
        due_date = COALESCE($3, due_date) WHERE id = $4 RETURNING *`,
      [req.body.status, req.body.notes || null, req.body.due_date || null, req.params.codId]
    )
    if (!result.rows[0]) return res.status(404).json({ error: { message: 'COD record not found' } })
    res.json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/orders/:orderId/delivery', async (req, res) => {
  try {
    const result = await query('SELECT * FROM deliveries WHERE order_id = $1', [req.params.orderId])
    res.json(result.rows[0] || null)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as deliveryRoutes }
