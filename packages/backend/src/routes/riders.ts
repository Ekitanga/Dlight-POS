import { Router } from 'express'
import { query, transaction } from '../db'
import { logAudit } from '../utils/audit'

const router = Router()

async function recalculateRiderBalance(client: any, riderId: string) {
  await client.query(
    `UPDATE riders r SET balance =
      COALESCE((SELECT SUM(re.amount) FROM rider_earnings re WHERE re.rider_id = r.id AND re.status <> 'reversed'), 0)
      - COALESCE((SELECT SUM(rp.amount) FROM rider_payments rp WHERE rp.rider_id = r.id), 0),
      updated_at = NOW()
     WHERE r.id = $1`,
    [riderId]
  )
}

router.get('/', async (req, res) => {
  try {
    const { search } = req.query
    
    let sql = 'SELECT * FROM riders WHERE is_active = true'
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
    const { name, phone, national_id, notes } = req.body
    const result = await query(
      'INSERT INTO riders (name, phone, national_id, notes) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, phone, national_id, notes]
    )
    res.status(201).json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, phone, national_id, notes } = req.body
    const result = await query(
      'UPDATE riders SET name = $1, phone = $2, national_id = $3, notes = $4, updated_at = NOW() WHERE id = $5 RETURNING *',
      [name, phone, national_id, notes, id]
    )
    res.json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    await query('UPDATE riders SET is_active = false WHERE id = $1', [id])
    res.status(204).send()
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/:id/settlements', async (req, res) => {
  try {
    const { id } = req.params
    const { settled_amount, period_start, period_end, total_deliveries, payment_method, reference } = req.body

    const settlement = await transaction(async (client) => {
      const settledAmount = Number(settled_amount || 0)
      if (!Number.isFinite(settledAmount) || settledAmount < 0) {
        throw Object.assign(new Error('Invalid settlement amount'), { statusCode: 400 })
      }

      const result = await client.query(
        'INSERT INTO rider_settlements (rider_id, period_start, period_end, total_deliveries, total_earned, settled_amount, balance, status, settled_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, (SELECT balance FROM riders WHERE id = $1) - $6, $7, NOW(), $8) RETURNING *',
        [id, period_start, period_end, total_deliveries || 0, settledAmount, settledAmount, settledAmount > 0 ? 'paid' : 'pending', req.user?.userId]
      )

      if (settledAmount > 0) {
        await client.query(
          'INSERT INTO rider_payments (rider_id, amount, payment_method, reference, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, settledAmount, payment_method || 'cash', reference || null, 'Settlement payment', req.user?.userId]
        )
        await recalculateRiderBalance(client, id)
      }
      await logAudit({
        req,
        client,
        action: 'rider_settlement_recorded',
        entityType: 'rider',
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

router.get('/:id/earnings', async (req, res) => {
  try {
    const { id } = req.params
    const result = await query(
      'SELECT * FROM rider_earnings WHERE rider_id = $1 ORDER BY created_at DESC',
      [id]
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/:id/earnings', async (req, res) => {
  try {
    const { id } = req.params
    const { delivery_id, order_id, amount, notes } = req.body

    const earning = await transaction(async (client) => {
      const earningAmount = Number(amount || 0)
      if (!Number.isFinite(earningAmount) || earningAmount <= 0) {
        throw Object.assign(new Error('Earning amount must be greater than zero'), { statusCode: 400 })
      }

      const riderResult = await client.query('SELECT id FROM riders WHERE id = $1 AND is_active = true FOR UPDATE', [id])
      if (riderResult.rows.length === 0) {
        throw Object.assign(new Error('Rider not found'), { statusCode: 404 })
      }

      if (delivery_id) {
        const existing = await client.query(
          "SELECT id FROM rider_earnings WHERE rider_id = $1 AND delivery_id = $2 AND status != 'reversed'",
          [id, delivery_id]
        )
        if (existing.rows.length > 0) {
          throw Object.assign(new Error('Rider earning already exists for this delivery'), { statusCode: 400 })
        }
      }

      const result = await client.query(
        'INSERT INTO rider_earnings (rider_id, delivery_id, order_id, amount, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [id, delivery_id || null, order_id || null, earningAmount, notes || null, req.user?.userId]
      )

      await recalculateRiderBalance(client, id)
      await logAudit({
        req,
        client,
        action: 'rider_earning_created',
        entityType: 'rider',
        entityId: id,
        newValues: result.rows[0],
        metadata: { amount: earningAmount, delivery_id: delivery_id || null, order_id: order_id || null }
      })
      return result.rows[0]
    })

    res.status(201).json(earning)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.post('/:id/payments', async (req, res) => {
  try {
    const { id } = req.params
    const { amount, payment_method, reference, notes } = req.body

    const payment = await transaction(async (client) => {
      const paymentAmount = Number(amount || 0)
      if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
        throw Object.assign(new Error('Payment amount must be greater than zero'), { statusCode: 400 })
      }

      const riderResult = await client.query('SELECT * FROM riders WHERE id = $1 FOR UPDATE', [id])
      if (riderResult.rows.length === 0) {
        throw Object.assign(new Error('Rider not found'), { statusCode: 404 })
      }

      const result = await client.query(
        'INSERT INTO rider_payments (rider_id, amount, payment_method, reference, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [id, paymentAmount, payment_method || 'cash', reference || null, notes || null, req.user?.userId]
      )

      await recalculateRiderBalance(client, id)
      await logAudit({
        req,
        client,
        action: 'rider_payment_recorded',
        entityType: 'rider',
        entityId: id,
        newValues: result.rows[0],
        metadata: { amount: paymentAmount, payment_method: payment_method || 'cash', reference: reference || null }
      })
      return result.rows[0]
    })

    res.status(201).json(payment)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.post('/:id/earnings/:earningId/reverse', async (req, res) => {
  try {
    const { id, earningId } = req.params
    const { notes } = req.body

    const reversed = await transaction(async (client) => {
      const earningResult = await client.query(
        "SELECT * FROM rider_earnings WHERE id = $1 AND rider_id = $2 AND status = 'payable' FOR UPDATE",
        [earningId, id]
      )
      const earning = earningResult.rows[0]
      if (!earning) {
        throw Object.assign(new Error('Payable earning not found'), { statusCode: 404 })
      }

      const result = await client.query(
        'UPDATE rider_earnings SET status = $1, notes = COALESCE($2, notes) WHERE id = $3 RETURNING *',
        ['reversed', notes || null, earningId]
      )
      await recalculateRiderBalance(client, id)
      await logAudit({
        req,
        client,
        action: 'rider_earning_reversed',
        entityType: 'rider',
        entityId: id,
        oldValues: earning,
        newValues: result.rows[0],
        metadata: { earning_id: earningId, amount: earning.amount }
      })
      return result.rows[0]
    })

    res.json(reversed)
  } catch (err) {
    const statusCode = (err as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.get('/:id/ledger', async (req, res) => {
  try {
    const { id } = req.params
    const result = await query(
      `SELECT 'earning' as entry_type, id, amount, created_at, notes FROM rider_earnings WHERE rider_id = $1
       UNION ALL
       SELECT 'payment' as entry_type, id, -amount as amount, created_at, notes FROM rider_payments WHERE rider_id = $1
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
      'SELECT * FROM rider_settlements WHERE rider_id = $1 ORDER BY created_at DESC',
      [id]
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as riderRoutes }
