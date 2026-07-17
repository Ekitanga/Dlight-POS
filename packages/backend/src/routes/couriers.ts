import { Router } from 'express'
import { query } from '../db/index.js'
import { paginatedResponse, paginationFromQuery, type Pagination } from '../utils/pagination.js'

const router = Router()

const DEFAULT_TRACKING_URL_TEMPLATE = 'https://parcelsapp.com/en/tracking/{tracking_number}'

function defaultPagination(): Pagination {
  return { page: 1, pageSize: 25, offset: 0 }
}

function trackingUrl(template: string | null | undefined, trackingNumber: string | null | undefined) {
  const cleanTrackingNumber = String(trackingNumber || '').trim()
  if (!cleanTrackingNumber) return null
  const cleanTemplate = String(template || DEFAULT_TRACKING_URL_TEMPLATE).trim() || DEFAULT_TRACKING_URL_TEMPLATE
  return cleanTemplate.includes('{tracking_number}')
    ? cleanTemplate.replaceAll('{tracking_number}', encodeURIComponent(cleanTrackingNumber))
    : `${cleanTemplate.replace(/\/$/, '')}/${encodeURIComponent(cleanTrackingNumber)}`
}

function withTrackingUrl<T extends { tracking_url_template?: string | null; courier_tracking_number?: string | null; tracking_number?: string | null }>(row: T) {
  return {
    ...row,
    tracking_url: trackingUrl(row.tracking_url_template, row.courier_tracking_number || row.tracking_number)
  }
}

router.get('/speedaf/orders', async (req, res) => {
  try {
    const {
      search,
      date_from,
      date_to,
      order_status,
      cod_status,
      outstanding
    } = req.query
    const pagination = paginationFromQuery(req.query) || defaultPagination()
    const params: unknown[] = []
    const where = [
      "o.delivery_type = 'courier'",
      "LOWER(c.name) LIKE '%speedaf%'"
    ]

    if (search) {
      params.push(`%${search}%`)
      where.push(`(
        o.order_number ILIKE $${params.length}
        OR COALESCE(cu.name, '') ILIKE $${params.length}
        OR COALESCE(cu.phone, '') ILIKE $${params.length}
        OR COALESCE(NULLIF(o.delivery_address, ''), cu.address, '') ILIKE $${params.length}
        OR COALESCE(o.courier_tracking_number, '') ILIKE $${params.length}
      )`)
    }

    if (date_from) {
      params.push(date_from)
      where.push(`o.sale_date >= $${params.length}::date`)
    }

    if (date_to) {
      params.push(date_to)
      where.push(`o.sale_date <= $${params.length}::date`)
    }

    if (order_status) {
      const status = String(order_status)
      if (status === 'pending_payment') {
        where.push("o.status = 'delivered' AND COALESCE(cc.cod_amount - cc.remitted_amount, 0) > 0")
      } else if (status === 'dispatched_in_transit') {
        where.push("o.status IN ('dispatched', 'in_transit')")
      } else {
        params.push(status)
        where.push(`o.status::text = $${params.length}`)
      }
    }

    if (cod_status) {
      params.push(cod_status)
      where.push(`cc.status = $${params.length}`)
    }

    if (outstanding === 'true') {
      where.push('COALESCE(cc.cod_amount - cc.remitted_amount, 0) > 0')
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const totalResult = await query(
      `SELECT COUNT(*)::int AS count
       FROM orders o
       LEFT JOIN customers cu ON cu.id = o.customer_id
       LEFT JOIN couriers c ON c.id = o.courier_id
       LEFT JOIN cod_collections cc ON cc.order_id = o.id
       ${whereSql}`,
      params
    )

    params.push(pagination.pageSize, pagination.offset)
    const result = await query(
      `SELECT
        o.id AS order_id,
        o.order_number,
        o.status::text AS order_status,
        o.payment_status::text AS payment_status,
        o.total_amount,
        o.subtotal,
        o.sale_date AS business_date,
        o.created_at,
        COALESCE(NULLIF(o.delivery_address, ''), cu.address, '') AS delivery_address,
        o.courier_tracking_number,
        o.courier_payment_type,
        o.delivery_fee_payment_method,
        o.courier_customer_fee,
        o.courier_actual_fee,
        cu.name AS customer_name,
        cu.phone AS customer_phone,
        c.id AS courier_id,
        c.name AS courier_name,
        c.tracking_url_template,
        cc.id AS cod_id,
        cc.status AS cod_status,
        cc.cod_amount,
        cc.remitted_amount,
        COALESCE(cc.cod_amount - cc.remitted_amount, 0) AS cod_outstanding,
        CASE
          WHEN cc.id IS NULL THEN 0
          ELSE GREATEST(0, CURRENT_DATE - COALESCE(cc.due_date, o.sale_date, cc.created_at::date))
        END AS age_days
       FROM orders o
       LEFT JOIN customers cu ON cu.id = o.customer_id
       LEFT JOIN couriers c ON c.id = o.courier_id
       LEFT JOIN cod_collections cc ON cc.order_id = o.id
       ${whereSql}
       ORDER BY o.sale_date DESC, o.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    res.json(paginatedResponse(result.rows.map(withTrackingUrl), Number(totalResult.rows[0]?.count || 0), pagination))
  } catch (error) {
    console.error('Speedaf orders error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/cod/ledger', async (req, res) => {
  try {
    const {
      search,
      date_from,
      date_to,
      courier_id,
      cod_status,
      outstanding
    } = req.query
    const pagination = paginationFromQuery(req.query) || defaultPagination()
    const params: unknown[] = []
    const where = ["o.delivery_type = 'courier'", 'cc.id IS NOT NULL']

    if (search) {
      params.push(`%${search}%`)
      where.push(`(
        o.order_number ILIKE $${params.length}
        OR COALESCE(cu.name, '') ILIKE $${params.length}
        OR COALESCE(cu.phone, '') ILIKE $${params.length}
        OR COALESCE(NULLIF(o.delivery_address, ''), cu.address, '') ILIKE $${params.length}
        OR COALESCE(c.name, '') ILIKE $${params.length}
        OR COALESCE(cc.tracking_number, o.courier_tracking_number, '') ILIKE $${params.length}
      )`)
    }

    if (date_from) {
      params.push(date_from)
      where.push(`o.sale_date >= $${params.length}::date`)
    }

    if (date_to) {
      params.push(date_to)
      where.push(`o.sale_date <= $${params.length}::date`)
    }

    if (courier_id) {
      params.push(courier_id)
      where.push(`c.id = $${params.length}`)
    }

    if (cod_status) {
      params.push(cod_status)
      where.push(`cc.status = $${params.length}`)
    }

    if (outstanding === 'true') {
      where.push('COALESCE(cc.cod_amount - cc.remitted_amount, 0) > 0')
    }

    const whereSql = `WHERE ${where.join(' AND ')}`
    const totalResult = await query(
      `SELECT COUNT(*)::int AS count
       FROM cod_collections cc
       JOIN orders o ON o.id = cc.order_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
       LEFT JOIN couriers c ON c.id = cc.courier_id
       ${whereSql}`,
      params
    )

    params.push(pagination.pageSize, pagination.offset)
    const result = await query(
      `SELECT
        cc.id AS cod_id,
        cc.status AS cod_status,
        cc.cod_amount,
        cc.remitted_amount,
        COALESCE(cc.cod_amount - cc.remitted_amount, 0) AS cod_outstanding,
        cc.tracking_number,
        cc.due_date,
        cc.delivered_at,
        cc.remitted_at,
        o.id AS order_id,
        o.order_number,
        o.status::text AS order_status,
        o.payment_status::text AS payment_status,
        o.total_amount,
        o.sale_date AS business_date,
        COALESCE(NULLIF(o.delivery_address, ''), cu.address, '') AS delivery_address,
        o.courier_tracking_number,
        o.delivery_fee_payment_method,
        o.courier_customer_fee,
        o.courier_actual_fee,
        cu.name AS customer_name,
        cu.phone AS customer_phone,
        c.id AS courier_id,
        c.name AS courier_name,
        c.tracking_url_template,
        GREATEST(0, CURRENT_DATE - COALESCE(cc.due_date, o.sale_date, cc.created_at::date)) AS age_days
       FROM cod_collections cc
       JOIN orders o ON o.id = cc.order_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
       LEFT JOIN couriers c ON c.id = cc.courier_id
       ${whereSql}
       ORDER BY o.sale_date DESC, o.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    res.json(paginatedResponse(result.rows.map(withTrackingUrl), Number(totalResult.rows[0]?.count || 0), pagination))
  } catch (error) {
    console.error('COD ledger error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/', async (req, res) => {
  try {
    const { search } = req.query

    let sql = 'SELECT * FROM couriers WHERE is_active = true'
    const params: any[] = []

    if (search) {
      sql += ' AND name ILIKE $1'
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
    const { name, tracking_prefix, tracking_url_template } = req.body
    const result = await query(
      'INSERT INTO couriers (name, tracking_prefix, tracking_url_template) VALUES ($1, $2, $3) RETURNING *',
      [name, tracking_prefix || null, tracking_url_template || null]
    )
    res.status(201).json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, tracking_prefix, tracking_url_template, is_active } = req.body
    const result = await query(
      'UPDATE couriers SET name = $1, tracking_prefix = $2, tracking_url_template = $3, is_active = $4, updated_at = NOW() WHERE id = $5 RETURNING *',
      [name, tracking_prefix || null, tracking_url_template || null, is_active, id]
    )
    res.json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    await query('UPDATE couriers SET is_active = false WHERE id = $1', [id])
    res.status(204).send()
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as courierRoutes }
