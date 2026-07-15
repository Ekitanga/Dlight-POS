import { Router } from 'express'
import { query } from '../db'
import { authMiddleware } from '../middleware/auth'
import { paginatedResponse, paginationFromQuery } from '../utils/pagination'

const router = Router()

router.use(authMiddleware)

router.get('/', async (req, res) => {
  try {
    const { search, date_from, date_to } = req.query
    
    let sql = `
      SELECT 
        o.id,
        o.id as order_id,
        o.order_number,
        o.sale_date,
        o.created_at,
        o.subtotal,
        o.discount,
        o.tax,
        o.total_amount,
        o.paid_amount,
        o.delivery_type,
        o.delivery_income,
        o.delivery_fee_payment_method,
        o.delivery_fee_paid_amount,
        o.delivery_cost,
        o.courier_customer_fee,
        o.courier_actual_fee,
        o.courier_tracking_number,
        o.payment_status,
        o.status as order_status,
        c.name as customer_name,
        c.phone as customer_phone,
        COALESCE(NULLIF(o.delivery_address, ''), c.address) as customer_address,
        r.name as rider_name,
        cr.name as courier_name,
        COALESCE(payments.payment_method,
          CASE WHEN o.courier_payment_type='cod' OR (o.delivery_type='rider' AND o.payment_status <> 'paid')
            THEN 'pay_on_delivery' ELSE 'credit' END
        ) as payment_method,
        COALESCE(payments.payment_methods,
          CASE WHEN o.courier_payment_type='cod' OR (o.delivery_type='rider' AND o.payment_status <> 'paid')
            THEN 'pay_on_delivery' ELSE 'credit' END
        ) as payment_methods,
        s.company_name, s.logo_url, s.company_phone, s.company_email, s.company_address,
        s.website, s.kra_pin, s.currency, s.mpesa_paybill, s.mpesa_account_number, s.mpesa_till,
        s.receipt_header, s.receipt_footer, s.receipt_paper_width,
        s.receipt_show_customer_address, s.receipt_show_payment_details,
        s.receipt_show_delivery_details,
        COALESCE(items.items, '[]'::json) as items
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN riders r ON o.rider_id = r.id
      LEFT JOIN couriers cr ON o.courier_id = cr.id
      LEFT JOIN LATERAL (
        SELECT 
          MIN(op.payment_method::text) as payment_method,
          STRING_AGG(DISTINCT op.payment_method::text, ', ') as payment_methods
        FROM order_payments op
        WHERE op.order_id = o.id
      ) payments ON true
      LEFT JOIN LATERAL (
        SELECT JSON_AGG(
          JSON_BUILD_OBJECT(
            'product_name', p.name,
            'quantity', oi.quantity,
            'unit_price', oi.unit_price,
            'total_price', oi.total_price
          )
          ORDER BY p.name
        ) as items
        FROM order_items oi
        LEFT JOIN products p ON oi.product_id = p.id
        WHERE oi.order_id = o.id
      ) items ON true
      LEFT JOIN LATERAL (
        SELECT company_name, logo_url, company_phone, company_email, company_address,
          website, kra_pin, currency, mpesa_paybill, mpesa_account_number, mpesa_till, receipt_header,
          receipt_footer, receipt_paper_width, receipt_show_customer_address,
          receipt_show_payment_details, receipt_show_delivery_details
        FROM settings
        ORDER BY created_at DESC
        LIMIT 1
      ) s ON true
    `
    const params: any[] = []
    const conditions: string[] = []

    if (search) {
      conditions.push('o.order_number ILIKE $' + (params.length + 1))
      params.push(`%${search}%`)
    }

    if (date_from) {
      conditions.push('COALESCE(o.sale_date, o.created_at::date) >= $' + (params.length + 1))
      params.push(date_from)
    }

    if (date_to) {
      conditions.push('COALESCE(o.sale_date, o.created_at::date) <= $' + (params.length + 1))
      params.push(date_to)
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ')
    }

    const pagination = paginationFromQuery(req.query)
    let total = 0
    if (pagination) {
      const countResult = await query(`SELECT COUNT(*)::int AS total FROM (${sql}) receipts_list`, params)
      total = countResult.rows[0].total
      params.push(pagination.pageSize, pagination.offset)
      sql += ` ORDER BY COALESCE(o.sale_date, o.created_at::date) DESC, o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`
    } else {
      sql += ' ORDER BY COALESCE(o.sale_date, o.created_at::date) DESC, o.created_at DESC LIMIT 100'
    }

    const result = await query(sql, params)
    res.json(pagination ? paginatedResponse(result.rows, total, pagination) : result.rows)
  } catch (err) {
    console.error('Receipts error:', err)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as receiptRoutes }
