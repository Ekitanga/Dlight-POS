import { Router } from 'express'
import { query, transaction } from '../db/index.js'
import { paginatedResponse, paginationFromQuery } from '../utils/pagination.js'
import { logAudit } from '../utils/audit.js'
import { evaluateAndEarnOrderItem, reverseCommission } from '../services/commission.js'
import { syncSpeedafTracking } from '../services/speedafTracking.js'

const router = Router()
const DEFAULT_TRACKING_URL_TEMPLATE = 'https://parcelsapp.com/en/tracking/{tracking_number}'

// These are deliberately order-workflow stages, not delivery table states.  A
// courier delivery can be physically delivered while it is still awaiting COD
// remittance, so filtering or displaying `delivery_status` alone is misleading.
const workflowStages = new Set([
  'pending',
  'confirmed',
  'in_transit',
  'pending_payment',
  'completed',
  'returned',
  'cancelled'
])

function workflowCondition(stage: string): string | null {
  switch (stage) {
    case 'pending':
      return "o.status = 'pending'"
    case 'confirmed':
      return "o.status IN ('confirmed', 'packed')"
    case 'in_transit':
      return "o.status IN ('in_transit', 'dispatched')"
    case 'pending_payment':
      return "o.delivery_type = 'courier' AND o.courier_payment_type = 'cod' AND o.status = 'delivered'"
    case 'completed':
      return "((o.status = 'delivered' AND NOT (o.delivery_type = 'courier' AND o.courier_payment_type = 'cod')) OR o.status = 'collected_paid')"
    case 'returned':
      return "o.status = 'returned'"
    case 'cancelled':
      return "o.status = 'cancelled'"
    default:
      return null
  }
}

// Keep this CASE in lockstep with workflowCondition.  The API exposes this
// canonical value so every client uses the order workflow rather than trying to
// infer it from delivery fields (especially for COD orders).
const workflowStatusSql = `CASE
  WHEN o.status = 'pending' THEN 'pending'
  WHEN o.status IN ('confirmed', 'packed') THEN 'confirmed'
  WHEN o.status IN ('in_transit', 'dispatched') THEN 'in_transit'
  WHEN o.delivery_type = 'courier' AND o.courier_payment_type = 'cod' AND o.status = 'delivered' THEN 'pending_payment'
  WHEN (o.status = 'delivered' AND NOT (o.delivery_type = 'courier' AND o.courier_payment_type = 'cod')) OR o.status = 'collected_paid' THEN 'completed'
  WHEN o.status = 'returned' THEN 'returned'
  WHEN o.status = 'cancelled' THEN 'cancelled'
  ELSE o.status::text
END`

function trackingUrl(template: string | null | undefined, trackingNumber: string | null | undefined) {
  const cleanedTrackingNumber = String(trackingNumber || '').trim()
  if (!cleanedTrackingNumber) return null

  const safeTrackingNumber = encodeURIComponent(cleanedTrackingNumber)
  const urlTemplate = String(template || DEFAULT_TRACKING_URL_TEMPLATE).trim() || DEFAULT_TRACKING_URL_TEMPLATE

  if (urlTemplate.includes('{tracking_number}')) {
    return urlTemplate.replace(/\{tracking_number\}/g, safeTrackingNumber)
  }

  return `${urlTemplate.replace(/\/$/, '')}/${safeTrackingNumber}`
}

function withTrackingUrl<T extends { courier_tracking_number?: string | null }>(row: T) {
  return {
    ...row,
    tracking_url: trackingUrl(null, row.courier_tracking_number)
  }
}

const speedafBatchSelect = `
  SELECT b.*, creator.full_name AS created_by_name, approver.full_name AS approved_by_name,
    reverter.full_name AS reverted_by_name,
    COALESCE(json_agg(json_build_object(
      'order_id', a.order_id,
      'order_number', o.order_number,
      'tracking_number', d.courier_tracking_number,
      'customer_name', customer.name,
      'salesperson_name', salesperson.full_name,
      'gross_amount', a.gross_amount,
      'commission_amount', COALESCE(order_commission.amount, 0)
    ) ORDER BY o.order_number) FILTER (WHERE a.id IS NOT NULL), '[]') AS allocations
  FROM speedaf_remittance_batches b
  LEFT JOIN users creator ON creator.id = b.created_by
  LEFT JOIN users approver ON approver.id = b.approved_by
  LEFT JOIN users reverter ON reverter.id = b.reverted_by
  LEFT JOIN speedaf_remittance_allocations a ON a.batch_id = b.id
  LEFT JOIN orders o ON o.id = a.order_id
  LEFT JOIN deliveries d ON d.order_id = o.id
  LEFT JOIN customers customer ON customer.id = o.customer_id
  LEFT JOIN users salesperson ON salesperson.id = o.created_by
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(CASE
      WHEN transaction_type = 'earned' THEN amount
      WHEN transaction_type = 'reversal' THEN -amount
      ELSE 0
    END), 0) AS amount
    FROM commission_transactions
    WHERE order_id = o.id
  ) order_commission ON TRUE
  GROUP BY b.id, creator.full_name, approver.full_name, reverter.full_name
  ORDER BY b.created_at DESC
  LIMIT 200`

function mapPaymentRecord(row: any, source = 'batch') {
  return {
    ...row,
    source,
    payment_number: row.payment_number || row.batch_number,
    allocations: (Array.isArray(row.allocations) ? row.allocations : []).map((allocation: any) => ({
      ...allocation,
      tracking_url: trackingUrl(null, allocation.tracking_number)
    }))
  }
}

async function getSpeedafBatches() {
  const result = await query(speedafBatchSelect)
  return result.rows.map(row => mapPaymentRecord(row))
}

async function recordSpeedafBatch(client: any, batchId: string, recordedBy: string, req?: any) {
  const batchResult = await client.query(
    'SELECT * FROM speedaf_remittance_batches WHERE id = $1 FOR UPDATE',
    [batchId]
  )
  const batch = batchResult.rows[0]
  if (!batch) throw Object.assign(new Error('Speedaf payment batch not found'), { statusCode: 404 })
  if (batch.status !== 'pending_approval') {
    throw Object.assign(new Error(`This Speedaf payment batch is already ${String(batch.status).replace('_', ' ')}`), { statusCode: 409 })
  }

  const allocations = (await client.query(
    `SELECT a.*, o.order_number, o.status AS order_status, o.payment_status, o.paid_amount, o.total_amount,
            o.courier_payment_type, cc.status AS cod_status, cc.cod_amount, cc.remitted_amount,
            cr.name AS courier_name
     FROM speedaf_remittance_allocations a
     JOIN orders o ON o.id = a.order_id
     JOIN cod_collections cc ON cc.id = a.cod_collection_id
     JOIN deliveries d ON d.order_id = o.id
     LEFT JOIN couriers cr ON cr.id = d.courier_id
     WHERE a.batch_id = $1 AND a.active
     ORDER BY o.order_number
     FOR UPDATE OF o, cc, d`,
    [batchId]
  )).rows
  if (!allocations.length) throw Object.assign(new Error('The batch has no active order allocations'), { statusCode: 409 })

  let completedOrders = 0
  let commissionsCreated = 0
  for (const allocation of allocations) {
    const outstanding = Math.max(0, Number(allocation.cod_amount) - Number(allocation.remitted_amount))
    if (Math.abs(outstanding - Number(allocation.gross_amount)) > 0.005 ||
      !['delivered_awaiting_remittance', 'partially_remitted', 'disputed'].includes(allocation.cod_status) ||
      allocation.order_status !== 'delivered' ||
      allocation.courier_payment_type !== 'cod' ||
      !String(allocation.courier_name || '').toLowerCase().includes('speedaf')) {
      throw Object.assign(new Error(`Order ${allocation.order_number} changed after this batch was prepared. Review the batch again.`), { statusCode: 409 })
    }

    const internalReference = `${batch.batch_number}:${allocation.order_number}`
    await client.query(
      `INSERT INTO cod_remittances
        (cod_collection_id, order_id, amount, payment_method, reference, received_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::date + TIME '12:00', $7)`,
      [allocation.cod_collection_id, allocation.order_id, allocation.gross_amount, batch.payment_method,
        internalReference, batch.payment_date, recordedBy]
    )
    await client.query(
      `INSERT INTO order_payments (order_id, amount, payment_method, payment_date, reference, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [allocation.order_id, allocation.gross_amount, batch.payment_method, batch.payment_date, internalReference, recordedBy]
    )

    const newRemittedAmount = Number(allocation.remitted_amount) + Number(allocation.gross_amount)
    await client.query(
      `UPDATE cod_collections SET remitted_amount = $1, status = 'remitted', remitted_at = $2::date + TIME '12:00',
         closed_at = $2::date + TIME '12:00', closed_by = $3 WHERE id = $4`,
      [newRemittedAmount, batch.payment_date, recordedBy, allocation.cod_collection_id]
    )
    const paymentTotal = Number((await client.query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM order_payments WHERE order_id = $1',
      [allocation.order_id]
    )).rows[0].total)
    const paid = paymentTotal >= Number(allocation.total_amount)
    if (!paid) {
      throw Object.assign(new Error(`Order ${allocation.order_number} would still be underpaid after this allocation`), { statusCode: 409 })
    }
    await client.query(
      `UPDATE orders SET paid_amount = $1, payment_status = 'paid', status = 'collected_paid',
         commission_completion_by = $2, commission_completion_at = $3::date + TIME '12:00', updated_at = NOW()
       WHERE id = $4`,
      [paymentTotal, recordedBy, batch.payment_date, allocation.order_id]
    )
    await client.query("UPDATE deliveries SET delivery_status = 'collected_paid' WHERE order_id = $1", [allocation.order_id])

    const items = await client.query('SELECT id FROM order_items WHERE order_id = $1 ORDER BY id', [allocation.order_id])
    for (const item of items.rows) {
      const commission = await evaluateAndEarnOrderItem(
        allocation.order_id,
        item.id,
        recordedBy,
        client,
        'speedaf_remittance_batch',
        batch.id
      )
      if (commission.earned) commissionsCreated += 1
    }
    completedOrders += 1
    await logAudit({
      req,
      client,
      userId: recordedBy,
      action: 'cod_remittance_recorded',
      entityType: 'order',
      entityId: allocation.order_id,
      oldValues: { status: allocation.order_status, cod_status: allocation.cod_status, remitted_amount: allocation.remitted_amount },
      newValues: { status: 'collected_paid', cod_status: 'remitted', remitted_amount: newRemittedAmount },
      metadata: { batch_id: batch.id, batch_number: batch.batch_number, gross_allocation: allocation.gross_amount }
    })
  }

  let feeExpenseId = null
  if (Number(batch.fee_amount) > 0) {
    feeExpenseId = (await client.query(
      `INSERT INTO expenses
        (category, description, amount, frequency, expense_date, payment_method, reference_notes,
         status, approved_by, approved_at, created_by)
       VALUES ('Courier Transaction Fees', $1, $2, 'one_off', $3, $4, $5, 'approved', $6, NOW(), $7)
       RETURNING id`,
      [`Speedaf remittance fee for ${batch.batch_number}`, batch.fee_amount, batch.payment_date,
        batch.payment_method, batch.external_reference || batch.batch_number, recordedBy, batch.created_by]
    )).rows[0].id
  }
  const approved = (await client.query(
    `UPDATE speedaf_remittance_batches
     SET status = 'approved', approved_by = $2, approved_at = NOW(), fee_expense_id = $3, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [batch.id, recordedBy, feeExpenseId]
  )).rows[0]
  await logAudit({
    req,
    client,
    userId: recordedBy,
    action: 'speedaf_remittance_batch_recorded',
    entityType: 'speedaf_remittance_batch',
    entityId: batch.id,
    oldValues: { status: batch.status },
    newValues: { status: 'approved', gross_amount: batch.gross_amount, net_amount: batch.net_amount, fee_amount: batch.fee_amount },
    metadata: { batch_number: batch.batch_number, completed_orders: completedOrders, commissions_created: commissionsCreated }
  })
  return { ...approved, completed_orders: completedOrders, commissions_created: commissionsCreated }
}

router.get('/', async (req, res) => {
  try {
    const { search, date_from, date_to, status, workflow_stage, cod_outstanding } = req.query
    const params: any[] = []
    const conditions: string[] = []
    if (search) {
      conditions.push(`(
        o.order_number ILIKE $${params.length + 1}
        OR c.name ILIKE $${params.length + 1}
        OR COALESCE(o.delivery_address, '') ILIKE $${params.length + 1}
        OR COALESCE(c.address, '') ILIKE $${params.length + 1}
        OR COALESCE(d.courier_tracking_number, '') ILIKE $${params.length + 1}
        OR COALESCE(r.name, '') ILIKE $${params.length + 1}
        OR COALESCE(cr.name, '') ILIKE $${params.length + 1}
      )`)
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
    if (workflow_stage !== undefined && String(workflow_stage).trim()) {
      const stage = String(workflow_stage).trim()
      if (!workflowStages.has(stage)) {
        return res.status(400).json({ error: { message: 'Invalid workflow status filter' } })
      }
      conditions.push(workflowCondition(stage)!)
    }
    if (cod_outstanding === 'true') {
      conditions.push("o.courier_payment_type='cod' AND cc.status NOT IN ('remitted','closed','returned','lost') AND COALESCE(cc.cod_amount-cc.remitted_amount,0)>0")
    }
    let sql = `SELECT d.*, o.order_number, o.status AS order_status, ${workflowStatusSql} AS workflow_status, o.payment_status, o.delivery_type,
      o.courier_payment_type, o.delivery_fee_payment_method,
        COALESCE(NULLIF(o.delivery_address, ''), c.address, '') AS delivery_destination,
        c.name AS customer_name, r.name AS rider_name,
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
    const rows = result.rows.map(withTrackingUrl)
    res.json(pagination ? paginatedResponse(rows, total, pagination) : rows)
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

router.get('/tracking/config', (_req, res) => {
  res.json({
    provider: 'ParcelsApp',
    configured: Boolean(String(process.env.PARCELS_API_KEY || '').trim()),
    automatic: String(process.env.SPEEDAF_TRACKING_SYNC_ENABLED || '').toLowerCase() === 'true',
    interval_minutes: Math.max(5, Number(process.env.SPEEDAF_TRACKING_SYNC_INTERVAL_MINUTES || 30))
  })
})

router.post('/tracking/sync', async (req, res) => {
  try {
    const result = await syncSpeedafTracking({ source: 'manual', userId: req.user?.userId })
    res.json(result)
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: { message: error.message || 'Unable to refresh Speedaf tracking' } })
  }
})

router.post('/orders/:orderId/tracking/sync', async (req, res) => {
  try {
    const result = await syncSpeedafTracking({ orderId: req.params.orderId, source: 'manual', userId: req.user?.userId })
    res.json(result)
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: { message: error.message || 'Unable to refresh Speedaf tracking' } })
  }
})

router.get('/orders/:orderId/tracking/events', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, provider, tracking_number, provider_status, message, location, event_at,
              observed_at, triggered_transition
       FROM courier_tracking_events WHERE order_id = $1
       ORDER BY COALESCE(event_at, observed_at) DESC, created_at DESC LIMIT 100`,
      [req.params.orderId]
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Unable to load tracking history' } })
  }
})

router.get('/cod/batches', async (_req, res) => {
  try {
    res.json(await getSpeedafBatches())
  } catch {
    res.status(500).json({ error: { message: 'Unable to load Speedaf payment batches' } })
  }
})

router.get('/cod/payment-history', async (req, res) => {
  if (!['admin', 'owner'].includes(req.user?.role || '')) {
    return res.status(403).json({ error: { message: 'Management access is required' } })
  }
  try {
    const [batches, legacyResult] = await Promise.all([
      getSpeedafBatches(),
      query(
        `SELECT r.id,
                'legacy_single' AS source,
                'SINGLE-' || UPPER(SUBSTR(REPLACE(r.id::text, '-', ''), 1, 8)) AS payment_number,
                r.received_at::date AS payment_date,
                r.payment_method,
                r.amount AS net_amount,
                r.amount AS gross_amount,
                0::numeric AS fee_amount,
                r.reference AS external_reference,
                NULL::text AS notes,
                'approved' AS status,
                creator.full_name AS created_by_name,
                creator.full_name AS approved_by_name,
                r.created_at,
                r.received_at AS approved_at,
                json_build_array(json_build_object(
                  'order_id', o.id,
                  'order_number', o.order_number,
                  'tracking_number', d.courier_tracking_number,
                  'customer_name', customer.name,
                  'salesperson_name', salesperson.full_name,
                  'gross_amount', r.amount,
                  'commission_amount', COALESCE(order_commission.amount, 0)
                )) AS allocations
         FROM cod_remittances r
         JOIN orders o ON o.id = r.order_id
         JOIN deliveries d ON d.order_id = o.id
         JOIN couriers courier ON courier.id = d.courier_id
         LEFT JOIN customers customer ON customer.id = o.customer_id
         LEFT JOIN users creator ON creator.id = r.created_by
         LEFT JOIN users salesperson ON salesperson.id = o.created_by
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(CASE
             WHEN transaction_type = 'earned' THEN amount
             WHEN transaction_type = 'reversal' THEN -amount
             ELSE 0
           END), 0) AS amount
           FROM commission_transactions
           WHERE order_id = o.id
         ) order_commission ON TRUE
         WHERE LOWER(courier.name) LIKE '%speedaf%'
           AND NOT EXISTS (
             SELECT 1 FROM speedaf_remittance_batches batch
             WHERE r.reference LIKE batch.batch_number || ':%'
           )
         ORDER BY r.received_at DESC
         LIMIT 200`
      )
    ])
    const legacy = legacyResult.rows.map(row => mapPaymentRecord(row, 'legacy_single'))
    const combined = [...batches, ...legacy]
      .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
      .slice(0, 200)
    res.json(combined)
  } catch (error) {
    console.error('Speedaf payment history failed:', error)
    res.status(500).json({ error: { message: 'Unable to load Speedaf payment history' } })
  }
})

router.post('/cod/batches', async (req, res) => {
  try {
    const { order_ids, net_amount, payment_date, payment_method, external_reference, notes } = req.body
    const orderIds = Array.from(new Set(Array.isArray(order_ids) ? order_ids.map(String) : [])).filter(Boolean)
    const netAmount = Number(net_amount)
    const method = payment_method === 'bank' ? 'bank_transfer' : payment_method
    if (!orderIds.length) return res.status(400).json({ error: { message: 'Select at least one Pending Payment order' } })
    if (!Number.isFinite(netAmount) || netAmount <= 0) return res.status(400).json({ error: { message: 'Amount received must be greater than zero' } })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payment_date || ''))) return res.status(400).json({ error: { message: 'Payment date is required' } })
    if (!['mpesa', 'bank_transfer'].includes(method)) return res.status(400).json({ error: { message: 'Select M-PESA or Bank' } })

    const result = await transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('speedaf_remittance_batch_create'))")
      const eligible = (await client.query(
        `SELECT o.id AS order_id, o.order_number, o.status, o.courier_payment_type,
                cc.id AS cod_collection_id, cc.status AS cod_status,
                (cc.cod_amount - cc.remitted_amount) AS outstanding,
                cr.name AS courier_name
         FROM orders o
         JOIN cod_collections cc ON cc.order_id = o.id
         JOIN deliveries d ON d.order_id = o.id
         LEFT JOIN couriers cr ON cr.id = d.courier_id
         WHERE o.id = ANY($1::uuid[])
         FOR UPDATE OF o, cc`,
        [orderIds]
      )).rows
      if (eligible.length !== orderIds.length) throw Object.assign(new Error('One or more selected orders could not be found'), { statusCode: 400 })
      for (const order of eligible) {
        if (order.status !== 'delivered' || order.courier_payment_type !== 'cod' ||
          !String(order.courier_name || '').toLowerCase().includes('speedaf') ||
          !['delivered_awaiting_remittance', 'partially_remitted', 'disputed'].includes(order.cod_status) ||
          Number(order.outstanding) <= 0) {
          throw Object.assign(new Error(`Order ${order.order_number} is no longer awaiting a Speedaf payment`), { statusCode: 409 })
        }
      }
      const grossAmount = eligible.reduce((sum: number, order: any) => sum + Number(order.outstanding), 0)
      if (netAmount > grossAmount) throw Object.assign(new Error('Amount received cannot exceed the selected orders total'), { statusCode: 400 })
      const feeAmount = Math.round((grossAmount - netAmount) * 100) / 100
      if (grossAmount > 0 && feeAmount / grossAmount > 0.1) {
        throw Object.assign(new Error('The selected orders are too high for the amount received. Remove an incorrect order or check the bank amount.'), { statusCode: 400 })
      }
      const created = (await client.query(
        `INSERT INTO speedaf_remittance_batches
          (batch_number, payment_date, payment_method, net_amount, gross_amount, fee_amount,
           external_reference, notes, created_by)
         VALUES ('SPD-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || UPPER(SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 6)),
           $1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8)
         RETURNING *`,
        [payment_date, method, netAmount, grossAmount, feeAmount, String(external_reference || '').trim(),
          String(notes || '').trim(), req.user?.userId]
      )).rows[0]
      for (const order of eligible) {
        await client.query(
          `INSERT INTO speedaf_remittance_allocations
            (batch_id, order_id, cod_collection_id, gross_amount)
           VALUES ($1, $2, $3, $4)`,
          [created.id, order.order_id, order.cod_collection_id, order.outstanding]
        )
      }
      await logAudit({
        req, client, action: 'speedaf_remittance_batch_submitted', entityType: 'speedaf_remittance_batch', entityId: created.id,
        newValues: { batch_number: created.batch_number, net_amount: netAmount, gross_amount: grossAmount, fee_amount: feeAmount },
        metadata: { order_ids: orderIds, order_count: orderIds.length }
      })
      if (!req.user?.userId) throw Object.assign(new Error('Authentication required'), { statusCode: 401 })
      return recordSpeedafBatch(client, created.id, req.user.userId, req)
    })
    res.status(201).json(result)
  } catch (error: any) {
    console.error('Speedaf payment batch creation failed:', error)
    const duplicateOrder = error.code === '23505' && String(error.constraint || '').includes('speedaf_active_batch_order')
    const migrationMissing = ['42P01', '42703'].includes(error.code)
    const developmentMessage = process.env.NODE_ENV !== 'production' ? String(error.message || '') : ''
    res.status(error.statusCode || (duplicateOrder ? 409 : 500)).json({
      error: { message: duplicateOrder
        ? 'One of these orders is already included in another Speedaf payment batch'
        : migrationMissing
          ? 'The Speedaf bulk payment database migration has not been applied'
          : error.statusCode
            ? error.message
            : developmentMessage || 'Unable to create Speedaf payment batch' }
    })
  }
})

router.post('/cod/batches/:batchId/approve', async (req, res) => {
  if (!['admin', 'owner'].includes(req.user?.role || '')) {
    return res.status(403).json({ error: { message: 'Manager approval is required' } })
  }
  try {
    // Kept for payment batches submitted before immediate reconciliation was
    // introduced. New batches are recorded during creation.
    const result = await transaction(client => recordSpeedafBatch(client, req.params.batchId, req.user!.userId, req))
    res.json(result)
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: { message: error.statusCode ? error.message : 'Unable to approve Speedaf payment batch' } })
  }
})

router.post('/cod/batches/:batchId/revert', async (req, res) => {
  if (!['admin', 'owner'].includes(req.user?.role || '')) {
    return res.status(403).json({ error: { message: 'Management access is required' } })
  }
  const reason = String(req.body?.reason || '').trim()
  if (!reason) return res.status(400).json({ error: { message: 'A reason for reverting this payment is required' } })

  try {
    const result = await transaction(async client => {
      const batch = (await client.query(
        'SELECT * FROM speedaf_remittance_batches WHERE id = $1 FOR UPDATE',
        [req.params.batchId]
      )).rows[0]
      if (!batch) throw Object.assign(new Error('Speedaf payment not found'), { statusCode: 404 })
      if (batch.status !== 'approved') {
        throw Object.assign(new Error('Only a recorded Speedaf payment can be reverted'), { statusCode: 409 })
      }

      const allocations = (await client.query(
        `SELECT a.*, o.order_number, o.status AS order_status, o.payment_status, o.paid_amount, o.total_amount,
                cc.status AS cod_status, cc.remitted_amount
         FROM speedaf_remittance_allocations a
         JOIN orders o ON o.id = a.order_id
         JOIN cod_collections cc ON cc.id = a.cod_collection_id
         JOIN deliveries d ON d.order_id = o.id
         WHERE a.batch_id = $1 AND a.active
         ORDER BY o.order_number
         FOR UPDATE OF o, cc, d`,
        [batch.id]
      )).rows
      if (!allocations.length) throw Object.assign(new Error('This payment has no active order allocations'), { statusCode: 409 })

      const closedCommissionPeriod = (await client.query(
        `SELECT 1
         FROM commission_transactions ct
         JOIN commission_period_closures closure
           ON closure.period_start = ct.commission_month AND closure.status = 'closed'
         WHERE ct.order_id = ANY($1::uuid[])
           AND ct.transaction_type = 'earned'
           AND ct.transaction_status <> 'reversed'
         LIMIT 1`,
        [allocations.map((allocation: any) => allocation.order_id)]
      )).rows[0]
      if (closedCommissionPeriod) {
        throw Object.assign(new Error('This payment belongs to a closed commission period and cannot be reopened here. Use a reviewed management adjustment.'), { statusCode: 409 })
      }

      // Validate every allocation first so the transaction cannot partially
      // reopen a multi-order payment.
      for (const allocation of allocations) {
        if (allocation.order_status !== 'collected_paid' || !['remitted', 'closed'].includes(allocation.cod_status)) {
          throw Object.assign(new Error(`Order ${allocation.order_number} has changed and cannot be safely reverted`), { statusCode: 409 })
        }
        if (Number(allocation.remitted_amount) + 0.005 < Number(allocation.gross_amount)) {
          throw Object.assign(new Error(`Order ${allocation.order_number} no longer contains this full remittance`), { statusCode: 409 })
        }
        const internalReference = `${batch.batch_number}:${allocation.order_number}`
        const evidence = (await client.query(
          `SELECT
             (SELECT COUNT(*)::int FROM cod_remittances WHERE order_id = $1 AND reference = $2) AS cod_count,
             (SELECT COUNT(*)::int FROM order_payments WHERE order_id = $1 AND reference = $2) AS payment_count`,
          [allocation.order_id, internalReference]
        )).rows[0]
        if (Number(evidence.cod_count) !== 1 || Number(evidence.payment_count) !== 1) {
          throw Object.assign(new Error(`Payment evidence for order ${allocation.order_number} is incomplete; no changes were made`), { statusCode: 409 })
        }
      }

      let commissionsReversed = 0
      for (const allocation of allocations) {
        const internalReference = `${batch.batch_number}:${allocation.order_number}`
        await client.query('DELETE FROM cod_remittances WHERE order_id = $1 AND reference = $2', [allocation.order_id, internalReference])
        await client.query('DELETE FROM order_payments WHERE order_id = $1 AND reference = $2', [allocation.order_id, internalReference])

        const remainingRemitted = Math.max(0, Number(allocation.remitted_amount) - Number(allocation.gross_amount))
        const previousRemittanceAt = (await client.query(
          'SELECT MAX(received_at) AS received_at FROM cod_remittances WHERE cod_collection_id = $1',
          [allocation.cod_collection_id]
        )).rows[0]?.received_at || null
        await client.query(
          `UPDATE cod_collections
           SET remitted_amount = $1,
               status = CASE WHEN $1::numeric > 0 THEN 'partially_remitted' ELSE 'delivered_awaiting_remittance' END,
               remitted_at = $2, closed_at = NULL, closed_by = NULL
           WHERE id = $3`,
          [remainingRemitted, previousRemittanceAt, allocation.cod_collection_id]
        )

        const paymentTotal = Number((await client.query(
          'SELECT COALESCE(SUM(amount), 0) AS total FROM order_payments WHERE order_id = $1',
          [allocation.order_id]
        )).rows[0].total)
        const paymentStatus = paymentTotal <= 0
          ? 'pending'
          : paymentTotal + 0.005 < Number(allocation.total_amount) ? 'partially_paid' : 'paid'
        await client.query(
          `UPDATE orders
           SET paid_amount = $1, payment_status = $2, status = 'delivered',
               commission_completion_by = NULL, commission_completion_at = NULL,
               commission_verified_by = NULL, commission_verified_at = NULL,
               commission_verification_reason = NULL, updated_at = NOW()
           WHERE id = $3`,
          [paymentTotal, paymentStatus, allocation.order_id]
        )
        await client.query("UPDATE deliveries SET delivery_status = 'delivered' WHERE order_id = $1", [allocation.order_id])

        const earnings = (await client.query(
          `SELECT id, order_item_id, eligible_quantity
           FROM commission_transactions
           WHERE order_id = $1 AND transaction_type = 'earned' AND transaction_status <> 'reversed'
           ORDER BY created_at
           FOR UPDATE`,
          [allocation.order_id]
        )).rows
        for (const earning of earnings) {
          const reversed = await reverseCommission(
            earning.id,
            allocation.order_id,
            earning.order_item_id,
            Number(earning.eligible_quantity),
            `Speedaf payment ${batch.batch_number} reverted: ${reason}`,
            req.user?.userId || null,
            client,
            'speedaf_remittance_batch_revert',
            batch.id
          )
          if (reversed) commissionsReversed += 1
        }

        await logAudit({
          req,
          client,
          action: 'speedaf_payment_reverted_for_order',
          entityType: 'order',
          entityId: allocation.order_id,
          oldValues: { status: allocation.order_status, payment_status: allocation.payment_status, paid_amount: allocation.paid_amount, cod_status: allocation.cod_status, remitted_amount: allocation.remitted_amount },
          newValues: { status: 'delivered', payment_status: paymentStatus, paid_amount: paymentTotal, cod_status: remainingRemitted > 0 ? 'partially_remitted' : 'delivered_awaiting_remittance', remitted_amount: remainingRemitted },
          metadata: { batch_id: batch.id, batch_number: batch.batch_number, reason }
        })
      }

      if (batch.fee_expense_id) {
        await client.query(
          "UPDATE expenses SET status = 'rejected', approved_by = $2, approved_at = NOW() WHERE id = $1",
          [batch.fee_expense_id, req.user?.userId]
        )
      }
      await client.query('UPDATE speedaf_remittance_allocations SET active = FALSE WHERE batch_id = $1', [batch.id])
      const reverted = (await client.query(
        `UPDATE speedaf_remittance_batches
         SET status = 'reverted', reverted_by = $2, reverted_at = NOW(), revert_reason = $3, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [batch.id, req.user?.userId, reason]
      )).rows[0]
      await logAudit({
        req,
        client,
        action: 'speedaf_remittance_batch_reverted',
        entityType: 'speedaf_remittance_batch',
        entityId: batch.id,
        oldValues: { status: batch.status, gross_amount: batch.gross_amount, net_amount: batch.net_amount, fee_amount: batch.fee_amount },
        newValues: { status: 'reverted', reason },
        metadata: { batch_number: batch.batch_number, reopened_orders: allocations.length, commissions_reversed: commissionsReversed }
      })
      return { ...reverted, reopened_orders: allocations.length, commissions_reversed: commissionsReversed }
    })
    res.json(result)
  } catch (error: any) {
    console.error('Speedaf payment revert failed:', error)
    const migrationMissing = ['42P01', '42703'].includes(error.code)
    res.status(error.statusCode || (migrationMissing ? 409 : 500)).json({
      error: { message: migrationMissing
        ? 'The Speedaf immediate-reconciliation database migration has not been applied'
        : error.statusCode ? error.message : 'Unable to revert Speedaf payment' }
    })
  }
})

router.post('/cod/batches/:batchId/reject', async (req, res) => {
  if (!['admin', 'owner'].includes(req.user?.role || '')) {
    return res.status(403).json({ error: { message: 'Manager approval is required' } })
  }
  const reason = String(req.body?.reason || '').trim()
  if (!reason) return res.status(400).json({ error: { message: 'Rejection reason is required' } })
  try {
    const result = await transaction(async client => {
      const batch = (await client.query(
        `UPDATE speedaf_remittance_batches SET status = 'rejected', rejected_by = $2, rejected_at = NOW(),
           rejection_reason = $3, updated_at = NOW()
         WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
        [req.params.batchId, req.user?.userId, reason]
      )).rows[0]
      if (!batch) throw Object.assign(new Error('Only a pending batch can be rejected'), { statusCode: 409 })
      await client.query('UPDATE speedaf_remittance_allocations SET active = FALSE WHERE batch_id = $1', [batch.id])
      await logAudit({ req, client, action: 'speedaf_remittance_batch_rejected', entityType: 'speedaf_remittance_batch', entityId: batch.id,
        oldValues: { status: 'pending_approval' }, newValues: { status: 'rejected', reason } })
      return batch
    })
    res.json(result)
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: { message: error.statusCode ? error.message : 'Unable to reject Speedaf payment batch' } })
  }
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
      if (
        req.user?.role !== 'admin' &&
        req.user?.role !== 'owner' &&
        order.created_by &&
        order.created_by === req.user?.userId
      ) {
        throw Object.assign(new Error('A different authorised user must verify courier remittance for an order you created'), { statusCode: 403 })
      }

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
      const finalCompleted = fullyRemitted && paymentStatus === 'paid'
      await client.query(
        `UPDATE orders SET paid_amount = $1, payment_status = $2,
          status = CASE WHEN $3 THEN 'collected_paid' ELSE status END,
          commission_completion_by = CASE WHEN $3 THEN $5 ELSE commission_completion_by END,
          commission_completion_at = CASE WHEN $3 THEN NOW() ELSE commission_completion_at END,
          updated_at = NOW()
         WHERE id = $4`,
        [paidAmount, paymentStatus, finalCompleted, orderId, req.user?.userId || null]
      )
      if (finalCompleted) {
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
          fully_remitted: fullyRemitted,
          order_completed: finalCompleted
        }
      })
      if (finalCompleted) {
        await logAudit({
          req,
          client,
          action: 'order_status_changed',
          entityType: 'order',
          entityId: orderId,
          oldValues: { status: order.status, payment_status: order.payment_status },
          newValues: { status: 'collected_paid', payment_status: paymentStatus },
          metadata: {
            order_number: order.order_number,
            completion_source: 'speedaf_full_remittance',
            remittance_reference: String(reference).trim()
          }
        })
      }
      let commissionsCreated = 0
      if (finalCompleted) {
        const items = await client.query('SELECT id FROM order_items WHERE order_id = $1 ORDER BY id', [orderId])
        for (const item of items.rows) {
          const commission = await evaluateAndEarnOrderItem(orderId, item.id, req.user?.userId || null, client)
          if (commission.earned) commissionsCreated += 1
        }
      }
      return { paid_amount: paidAmount, payment_status: paymentStatus, cod_status: codStatus, commissions_created: commissionsCreated }
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
    res.json(result.rows[0] ? withTrackingUrl(result.rows[0]) : null)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as deliveryRoutes }
