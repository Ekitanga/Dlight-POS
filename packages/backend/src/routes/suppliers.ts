import { Router } from 'express'
import { query, transaction } from '../db'
import { logAudit } from '../utils/audit'

const router = Router()

async function recalculateSupplierBalance(client: any, supplierId: string) {
  await client.query(
    `UPDATE suppliers s SET balance =
      COALESCE((SELECT SUM(sp.amount) FROM supplier_payables sp WHERE sp.supplier_id = s.id), 0)
      - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id = s.id), 0)
      - COALESCE((SELECT SUM(sr.amount) FROM supplier_returns sr WHERE sr.supplier_id = s.id), 0),
      updated_at = NOW()
     WHERE s.id = $1`,
    [supplierId]
  )
}

router.get('/profitability', async (req, res) => {
  try {
    const { date_from, date_to } = req.query
    const params: any[] = []
    const conditions = ["oi.fulfillment_type IN ('supplier', 'hybrid')", "o.status IN ('delivered', 'collected_paid')"]

    if (date_from) {
      conditions.push('COALESCE(o.sale_date, o.created_at::date) >= $' + (params.length + 1))
      params.push(date_from)
    }

    if (date_to) {
      conditions.push('COALESCE(o.sale_date, o.created_at::date) <= $' + (params.length + 1))
      params.push(date_to)
    }

    const result = await query(
      `SELECT 
        s.id as supplier_id,
        s.name as supplier_name,
        COALESCE(SUM(oi.total_price * CASE WHEN oi.quantity > 0 THEN oi.supplier_quantity::numeric / oi.quantity ELSE 0 END), 0) as supplier_revenue,
        COALESCE(SUM(oi.supplier_cost * oi.supplier_quantity), 0) as supplier_cost,
        COALESCE(SUM((oi.total_price * CASE WHEN oi.quantity > 0 THEN oi.supplier_quantity::numeric / oi.quantity ELSE 0 END) - (oi.supplier_cost * oi.supplier_quantity)), 0) as gross_profit,
        COUNT(DISTINCT oi.id) as item_count
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN suppliers s ON oi.supplier_id = s.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY s.id, s.name
      ORDER BY gross_profit DESC`,
      params
    )

    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/', async (req, res) => {
  try {
    const { search } = req.query
    
    let sql = 'SELECT * FROM suppliers WHERE is_active = true'
    const params: any[] = []

    if (search) {
      sql += ' AND (name ILIKE $1 OR phone ILIKE $1)'
      params.push(`%${search}%`)
    }

    sql += ' ORDER BY name'

    const result = await query(sql, params)
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/', async (req, res) => {
  try {
    const { name, contact_person, phone, email, address } = req.body
    const result = await query(
      'INSERT INTO suppliers (name, contact_person, phone, email, address) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, contact_person, phone, email, address]
    )
    res.status(201).json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, contact_person, phone, email, address } = req.body
    const result = await query(
      'UPDATE suppliers SET name = $1, contact_person = $2, phone = $3, email = $4, address = $5, updated_at = NOW() WHERE id = $6 RETURNING *',
      [name, contact_person, phone, email, address, id]
    )
    res.json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    await query('UPDATE suppliers SET is_active = false, deleted_at = NOW() WHERE id = $1', [id])
    res.status(204).send()
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/:id/settlements', async (req, res) => {
  try {
    const { id } = req.params
    const { settled_amount, period_start, period_end, total_products, payment_method, reference } = req.body

    const settlement = await transaction(async (client) => {
      const settledAmount = Number(settled_amount || 0)
      if (!Number.isFinite(settledAmount) || settledAmount < 0) {
        throw Object.assign(new Error('Invalid settlement amount'), { statusCode: 400 })
      }

      const result = await client.query(
        'INSERT INTO supplier_settlements (supplier_id, period_start, period_end, total_products, total_cost, settled_amount, balance, status, settled_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, (SELECT balance FROM suppliers WHERE id = $1) - $6, $7, NOW(), $8) RETURNING *',
        [id, period_start, period_end, total_products || 0, settledAmount, settledAmount, settledAmount > 0 ? 'paid' : 'pending', req.user?.userId]
      )

      if (settledAmount > 0) {
        await client.query(
          'INSERT INTO supplier_payments (supplier_id, amount, payment_method, reference, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, settledAmount, payment_method || 'cash', reference || null, 'Settlement payment', req.user?.userId]
        )
        await recalculateSupplierBalance(client, id)
      }
      await logAudit({
        req,
        client,
        action: 'supplier_settlement_recorded',
        entityType: 'supplier',
        entityId: id,
        newValues: result.rows[0],
        metadata: { amount: settledAmount, payment_method: payment_method || 'cash', reference: reference || null }
      })

      return result.rows[0]
    })

    res.status(201).json(settlement)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.get('/:id/payables', async (req, res) => {
  try {
    const { id } = req.params
    const pendingOnly = req.query.status === 'pending'
    const result = await query(
      `SELECT sp.id, sp.order_id, sp.order_item_id, sp.amount, sp.paid_amount, sp.status,
        GREATEST(sp.amount-sp.paid_amount, 0) AS outstanding_amount,
        sp.description, sp.created_at, o.order_number, COALESCE(o.sale_date, o.created_at::date) AS order_date,
        p.name AS product_name, p.sku, oi.quantity, oi.supplier_quantity, oi.supplier_cost
       FROM supplier_payables sp
       LEFT JOIN orders o ON o.id=sp.order_id
       LEFT JOIN order_items oi ON oi.id=sp.order_item_id
       LEFT JOIN products p ON p.id=oi.product_id
       WHERE sp.supplier_id=$1
         ${pendingOnly ? "AND sp.status IN ('open','partial') AND sp.amount>sp.paid_amount" : ''}
       ORDER BY sp.created_at DESC`,
      [id]
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/:id/payment-history', async (req, res) => {
  try {
    const { id } = req.params
    const result = await query(
      `SELECT p.id, p.amount, p.payment_method, p.reference, p.notes, p.created_at,
        sp.id AS payable_id, o.order_number, pr.name AS product_name, oi.quantity
       FROM supplier_payments p
       LEFT JOIN supplier_payables sp ON sp.id=p.payable_id
       LEFT JOIN orders o ON o.id=sp.order_id
       LEFT JOIN order_items oi ON oi.id=sp.order_item_id
       LEFT JOIN products pr ON pr.id=oi.product_id
       WHERE p.supplier_id=$1
       ORDER BY p.created_at DESC`,
      [id]
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/:id/payments/allocate', async (req, res) => {
  try {
    const { id } = req.params
    const { allocations, payment_method, reference, notes } = req.body

    const result = await transaction(async (client) => {
      if (!Array.isArray(allocations) || allocations.length === 0) {
        throw Object.assign(new Error('Select at least one supplier item'), { statusCode: 400 })
      }

      const requested = new Map<string, number>()
      for (const allocation of allocations) {
        const payableId = String(allocation?.payable_id || '')
        const amount = Number(allocation?.amount || 0)
        if (!payableId || !Number.isFinite(amount) || amount <= 0 || requested.has(payableId)) {
          throw Object.assign(new Error('Each selected item requires one valid payment amount'), { statusCode: 400 })
        }
        requested.set(payableId, amount)
      }

      const supplierResult = await client.query(
        'SELECT id, balance FROM suppliers WHERE id=$1 AND is_active=true FOR UPDATE',
        [id]
      )
      if (supplierResult.rows.length === 0) {
        throw Object.assign(new Error('Supplier not found'), { statusCode: 404 })
      }

      const payableIds = [...requested.keys()]
      const payableResult = await client.query(
        `SELECT sp.*, COALESCE(o.sale_date, o.created_at::date) AS order_date
         FROM supplier_payables sp
         LEFT JOIN orders o ON o.id=sp.order_id
         WHERE sp.supplier_id=$1 AND sp.id=ANY($2::uuid[]) FOR UPDATE OF sp`,
        [id, payableIds]
      )
      if (payableResult.rows.length !== payableIds.length) {
        throw Object.assign(new Error('One or more supplier items could not be found'), { statusCode: 404 })
      }

      let total = 0
      for (const payable of payableResult.rows) {
        const amount = requested.get(payable.id)!
        const outstanding = Number(payable.amount) - Number(payable.paid_amount)
        if (!['open', 'partial'].includes(payable.status) || amount > outstanding + 0.001) {
          throw Object.assign(new Error('Payment exceeds the outstanding amount for an item'), { statusCode: 400 })
        }
        total += amount
      }
      if (total > Number(supplierResult.rows[0].balance) + 0.001) {
        throw Object.assign(new Error('Payment exceeds the supplier balance'), { statusCode: 400 })
      }

      const payments = []
      for (const payable of payableResult.rows) {
        const amount = requested.get(payable.id)!
        const paymentResult = await client.query(
          `INSERT INTO supplier_payments
            (supplier_id, payable_id, amount, payment_method, reference, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [id, payable.id, amount, payment_method || 'cash', reference || null, notes || null, req.user?.userId]
        )
        payments.push(paymentResult.rows[0])
        await client.query(
          `UPDATE supplier_payables SET
             paid_amount=paid_amount+$1,
             status=CASE WHEN paid_amount+$1>=amount THEN 'paid' ELSE 'partial' END
           WHERE id=$2`,
          [amount, payable.id]
        )
      }

      await recalculateSupplierBalance(client, id)
      const dates: Array<string | Date> = payableResult.rows.map((payable: any) => payable.order_date || payable.created_at)
      const periodStart = new Date(Math.min(...dates.map((value: string | Date) => new Date(value).getTime())))
      const periodEnd = new Date(Math.max(...dates.map((value: string | Date) => new Date(value).getTime())))
      const balanceResult = await client.query('SELECT balance FROM suppliers WHERE id=$1', [id])
      const settlementResult = await client.query(
        `INSERT INTO supplier_settlements
          (supplier_id, period_start, period_end, total_products, total_cost, settled_amount,
           balance, status, settled_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$5,$6,'paid',NOW(),$7) RETURNING *`,
        [
          id, periodStart.toISOString().slice(0, 10), periodEnd.toISOString().slice(0, 10),
          payableResult.rows.length, total, balanceResult.rows[0].balance, req.user?.userId
        ]
      )
      await logAudit({
        req,
        client,
        action: 'supplier_items_payment_recorded',
        entityType: 'supplier',
        entityId: id,
        newValues: {
          settlement_id: settlementResult.rows[0].id,
          reference: reference || null,
          total,
          allocations: payments.map(payment => ({ payable_id: payment.payable_id, amount: payment.amount }))
        },
        metadata: {
          amount: total,
          payment_method: payment_method || 'cash',
          item_count: payableResult.rows.length,
          reference: reference || null
        }
      })
      return {
        settlement: settlementResult.rows[0],
        payments,
        balance: Number(balanceResult.rows[0].balance)
      }
    })

    res.status(201).json(result)
  } catch (err) {
    console.error('Supplier item payment allocation error:', err)
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.post('/:id/payables', async (req, res) => {
  try {
    const { id } = req.params
    const { order_id, order_item_id, amount, description } = req.body

    const payable = await transaction(async (client) => {
      const payableAmount = Number(amount || 0)
      if (!Number.isFinite(payableAmount) || payableAmount <= 0) {
        throw Object.assign(new Error('Payable amount must be greater than zero'), { statusCode: 400 })
      }

      const supplierResult = await client.query('SELECT id FROM suppliers WHERE id = $1 AND is_active = true FOR UPDATE', [id])
      if (supplierResult.rows.length === 0) {
        throw Object.assign(new Error('Supplier not found'), { statusCode: 404 })
      }

      const result = await client.query(
        'INSERT INTO supplier_payables (supplier_id, order_id, order_item_id, amount, description, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [id, order_id || null, order_item_id || null, payableAmount, description || null, req.user?.userId]
      )

      await recalculateSupplierBalance(client, id)
      await logAudit({
        req,
        client,
        action: 'supplier_payable_created',
        entityType: 'supplier',
        entityId: id,
        newValues: result.rows[0],
        metadata: { amount: payableAmount, order_id: order_id || null, order_item_id: order_item_id || null }
      })
      return result.rows[0]
    })

    res.status(201).json(payable)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.post('/:id/payments', async (req, res) => {
  try {
    const { id } = req.params
    const { payable_id, amount, payment_method, reference, notes } = req.body

    const payment = await transaction(async (client) => {
      const paymentAmount = Number(amount || 0)
      if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
        throw Object.assign(new Error('Payment amount must be greater than zero'), { statusCode: 400 })
      }

      const supplierResult = await client.query('SELECT * FROM suppliers WHERE id = $1 FOR UPDATE', [id])
      if (supplierResult.rows.length === 0) {
        throw Object.assign(new Error('Supplier not found'), { statusCode: 404 })
      }

      const result = await client.query(
        'INSERT INTO supplier_payments (supplier_id, payable_id, amount, payment_method, reference, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [id, payable_id || null, paymentAmount, payment_method || 'cash', reference || null, notes || null, req.user?.userId]
      )

      if (payable_id) {
        await client.query(
          `UPDATE supplier_payables
           SET paid_amount = LEAST(amount, paid_amount + $1),
               status = CASE
                 WHEN paid_amount + $1 >= amount THEN 'paid'
                 WHEN paid_amount + $1 > 0 THEN 'partial'
                 ELSE status
               END
           WHERE id = $2 AND supplier_id = $3`,
          [paymentAmount, payable_id, id]
        )
      }

      await recalculateSupplierBalance(client, id)
      await logAudit({
        req,
        client,
        action: 'supplier_payment_recorded',
        entityType: 'supplier',
        entityId: id,
        newValues: result.rows[0],
        metadata: { amount: paymentAmount, payable_id: payable_id || null, payment_method: payment_method || 'cash', reference: reference || null }
      })
      return result.rows[0]
    })

    res.status(201).json(payment)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.post('/:id/returns', async (req, res) => {
  try {
    const { id } = req.params
    const { payable_id, order_item_id, amount, reason } = req.body

    const supplierReturn = await transaction(async (client) => {
      const returnAmount = Number(amount || 0)
      if (!Number.isFinite(returnAmount) || returnAmount <= 0) {
        throw Object.assign(new Error('Return amount must be greater than zero'), { statusCode: 400 })
      }

      const result = await client.query(
        'INSERT INTO supplier_returns (supplier_id, payable_id, order_item_id, amount, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [id, payable_id || null, order_item_id || null, returnAmount, reason || null, req.user?.userId]
      )

      if (payable_id) {
        await client.query('UPDATE supplier_payables SET status = $1 WHERE id = $2 AND supplier_id = $3', ['returned', payable_id, id])
      }

      await recalculateSupplierBalance(client, id)
      await logAudit({
        req,
        client,
        action: 'supplier_return_recorded',
        entityType: 'supplier',
        entityId: id,
        newValues: result.rows[0],
        metadata: { amount: returnAmount, payable_id: payable_id || null, order_item_id: order_item_id || null }
      })
      return result.rows[0]
    })

    res.status(201).json(supplierReturn)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.get('/:id/ledger', async (req, res) => {
  try {
    const { id } = req.params
    const result = await query(
      `SELECT 'payable' as entry_type, id, amount, created_at, description as notes FROM supplier_payables WHERE supplier_id = $1
       UNION ALL
       SELECT 'payment' as entry_type, id, -amount as amount, created_at, notes FROM supplier_payments WHERE supplier_id = $1
       UNION ALL
       SELECT 'return' as entry_type, id, -amount as amount, created_at, reason as notes FROM supplier_returns WHERE supplier_id = $1
       ORDER BY created_at DESC`,
      [id]
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/:id/settlements', async (req, res) => {
  try {
    const { id } = req.params
    const result = await query(
      'SELECT * FROM supplier_settlements WHERE supplier_id = $1 ORDER BY created_at DESC',
      [id]
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as supplierRoutes }
