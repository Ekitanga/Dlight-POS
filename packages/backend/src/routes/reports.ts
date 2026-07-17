import { Router } from 'express'
import { query, transaction } from '../db/index.js'
import { recognizedExpensesSql } from '../lib/expenseRecognition.js'

const router = Router()

function nairobiBusinessDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
}

function sendRows(req: any, res: any, rows: any[]) {
  if (req.query.format === 'csv') {
    const exportRows = rows.map(row => Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== 'id' && !key.endsWith('_id'))
    ))
    const headers = exportRows.length > 0 ? Object.keys(exportRows[0]) : []
    const isMoneyColumn = (key: string) => [
      'amount', 'sales', 'cost', 'profit', 'expense', 'paid', 'payable', 'earnings',
      'cash', 'mpesa', 'variance', 'balance', 'revenue', 'value', 'price', 'fee',
      'credit', 'subtotal', 'total', 'refund'
    ].some(term => key.includes(term)) && !/(method|status|date|count|number|margin)/.test(key)
    const exportValue = (key: string, value: any) => {
      if (value === null || value === undefined || value === '') return ''
      if (isMoneyColumn(key) && !Number.isNaN(Number(value))) return Math.round(Number(value))
      return value
    }
    const csv = [
      headers.join(','),
      ...exportRows.map(row => headers.map(header => JSON.stringify(exportValue(header, row[header]))).join(','))
    ].join('\n')
    res.setHeader('Content-Type', 'text/csv')
    res.send(csv)
    return
  }
  res.json(rows)
}

function shopDeliveryIncomeSql(alias: string): string {
  return `(CASE WHEN ${alias}.delivery_type = 'courier'
    AND ${alias}.courier_payment_type = 'cod'
    AND ${alias}.delivery_fee_payment_method IN ('paid_to_courier', 'pay_on_delivery')
    THEN 0 ELSE ${alias}.delivery_income END)`
}

function shopDeliveryCostSql(alias: string): string {
  return `(CASE WHEN ${alias}.delivery_type = 'courier'
    AND ${alias}.courier_payment_type = 'cod'
    AND ${alias}.delivery_fee_payment_method IN ('paid_to_courier', 'pay_on_delivery')
    THEN 0 ELSE ${alias}.delivery_cost END)`
}

router.get('/overview', async (req, res) => {
  try {
    const today = nairobiBusinessDate()
    const dateFrom = String(req.query.date_from || today)
    const dateTo = String(req.query.date_to || today)
    const params = [dateFrom, dateTo]
    const recognizedExpenses = recognizedExpensesSql('$1', '$2')
    const overviewIncome = shopDeliveryIncomeSql('o')
    const overviewCost = shopDeliveryCostSql('o')

    const [kpis, trends, payments, deliveries, products, customers, pending] = await Promise.all([
      query(`
        WITH completed AS (
          SELECT o.id, o.subtotal, o.subtotal + ${overviewIncome} AS revenue,
            ${overviewIncome} AS delivery_income, ${overviewCost} AS delivery_cost
          FROM orders o
          WHERE o.status IN ('delivered', 'collected_paid')
            AND COALESCE(o.sale_date, o.created_at::date) BETWEEN $1 AND $2
        ), costs AS (
          SELECT oi.order_id,
            SUM(oi.unit_cost * oi.internal_quantity) AS internal_cogs,
            SUM(oi.supplier_cost * oi.supplier_quantity) AS supplier_costs
          FROM order_items oi JOIN completed c ON c.id=oi.order_id GROUP BY oi.order_id
        )
        SELECT
          COALESCE((SELECT SUM(revenue) FROM completed),0) AS revenue,
          COALESCE((SELECT SUM(subtotal + delivery_income
            - COALESCE(costs.internal_cogs,0) - COALESCE(costs.supplier_costs,0))
            FROM completed LEFT JOIN costs ON costs.order_id=completed.id),0) AS gross_profit,
          COALESCE((SELECT SUM(subtotal + delivery_income - delivery_cost
            - COALESCE(costs.internal_cogs,0) - COALESCE(costs.supplier_costs,0))
            FROM completed LEFT JOIN costs ON costs.order_id=completed.id),0)
            - ${recognizedExpenses} AS net_profit,
          (SELECT COUNT(*) FROM orders WHERE COALESCE(sale_date, created_at::date) BETWEEN $1 AND $2) AS orders,
          (SELECT COUNT(*) FROM orders WHERE status IN ('pending','confirmed','packed')) AS pending_orders,
          (SELECT COUNT(*) FROM completed) AS completed_orders,
          ${recognizedExpenses} AS expenses,
          COALESCE((SELECT SUM(sp.amount) FROM supplier_payables sp),0)
            - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p),0)
            - COALESCE((SELECT SUM(sr.amount) FROM supplier_returns sr),0) AS supplier_payables,
          COALESCE((SELECT SUM(re.amount) FROM rider_earnings re WHERE re.status <> 'reversed'),0)
            - COALESCE((SELECT SUM(rp.amount) FROM rider_payments rp),0) AS rider_payables,
          COALESCE((SELECT SUM(cc.amount) FROM customer_credits cc),0) AS customer_credit,
          COALESCE((SELECT SUM(cc.cod_amount - cc.remitted_amount) FROM cod_collections cc
            WHERE cc.status NOT IN ('closed','remitted','returned')),0) AS pending_cod,
          COALESCE((SELECT SUM(GREATEST(i.quantity-i.reserved_quantity,0) * p.cost_price)
            FROM inventory i JOIN products p ON p.id=i.product_id
            WHERE p.deleted_at IS NULL AND p.is_active=TRUE),0) AS inventory_value
      `, params),
      query(`
        WITH days AS (
          SELECT generate_series($1::date,$2::date,'1 day')::date AS day
        ), order_totals AS (
          SELECT days.day,
            COALESCE(SUM(o.subtotal + ${overviewIncome}),0) AS sales,
            COUNT(o.id)::int AS orders,
            COALESCE(SUM(o.subtotal + ${overviewIncome} - ${overviewCost}
              - COALESCE(item_costs.cost,0)),0) AS gross_after_delivery
          FROM days
          LEFT JOIN orders o ON COALESCE(o.sale_date, o.created_at::date)=days.day
            AND o.status IN ('delivered','collected_paid')
          LEFT JOIN LATERAL (
            SELECT SUM(oi.unit_cost*oi.internal_quantity + oi.supplier_cost*oi.supplier_quantity) AS cost
            FROM order_items oi WHERE oi.order_id=o.id
          ) item_costs ON TRUE
          GROUP BY days.day
        )
        SELECT ot.day AS date, ot.sales, ot.orders,
          ot.gross_after_delivery - ${recognizedExpensesSql('ot.day', 'ot.day')} AS profit
        FROM order_totals ot
        ORDER BY ot.day
      `, params),
      query(`
        SELECT op.payment_method::text AS method, COALESCE(SUM(op.amount),0) AS amount
        FROM order_payments op JOIN orders o ON o.id=op.order_id
        WHERE op.payment_date BETWEEN $1 AND $2
        GROUP BY op.payment_method ORDER BY amount DESC
      `, params),
      query(`
        SELECT o.delivery_type::text AS type, COUNT(*)::int AS orders,
          COALESCE(SUM(${overviewIncome}-${overviewCost}),0) AS margin
        FROM orders o WHERE o.status IN ('delivered','collected_paid')
          AND COALESCE(o.sale_date, o.created_at::date) BETWEEN $1 AND $2
        GROUP BY o.delivery_type ORDER BY orders DESC
      `, params),
      query(`
        SELECT p.name AS product, p.sku, SUM(oi.quantity)::int AS quantity,
          SUM(oi.total_price) AS revenue,
          SUM(oi.total_price - oi.unit_cost*oi.internal_quantity
            - oi.supplier_cost*oi.supplier_quantity) AS profit
        FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN products p ON p.id=oi.product_id
        WHERE o.status IN ('delivered','collected_paid')
          AND COALESCE(o.sale_date, o.created_at::date) BETWEEN $1 AND $2
        GROUP BY p.id ORDER BY quantity DESC, revenue DESC LIMIT 8
      `, params),
      query(`
        SELECT c.name AS customer, c.phone, COUNT(o.id)::int AS orders,
          SUM(o.subtotal + ${overviewIncome}) AS lifetime_value
        FROM customers c JOIN orders o ON o.customer_id=c.id
        WHERE o.status IN ('delivered','collected_paid')
          AND COALESCE(o.sale_date, o.created_at::date) BETWEEN $1 AND $2
        GROUP BY c.id ORDER BY lifetime_value DESC LIMIT 8
      `, params),
      query(`
        SELECT
          (SELECT COUNT(*) FROM orders WHERE status IN ('pending','confirmed','packed'))::int AS orders_to_process,
          (SELECT COUNT(*) FROM cod_collections WHERE status IN ('delivered_awaiting_remittance','partially_remitted','disputed'))::int AS cod_to_collect,
          (SELECT COUNT(*) FROM products p JOIN inventory i ON i.product_id=p.id
            WHERE p.deleted_at IS NULL AND p.is_active=TRUE
              AND i.quantity-i.reserved_quantity <= p.reorder_level)::int AS low_stock,
          (SELECT COUNT(*) FROM order_refunds WHERE status='pending')::int AS refunds_due
      `)
    ])

    res.json({
      period: { dateFrom, dateTo },
      kpis: kpis.rows[0],
      trends: trends.rows,
      paymentMethods: payments.rows,
      deliveryTypes: deliveries.rows,
      topProducts: products.rows,
      topCustomers: customers.rows,
      pendingActions: pending.rows[0]
    })
  } catch (error) {
    console.error('Report overview error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

function dateConditions(alias: string, dateColumn = 'created_at', queryParams: any, params: any[]) {
  const conditions: string[] = []
  if (queryParams.date_from) {
    conditions.push(`${alias}.${dateColumn}::date >= $${params.length + 1}`)
    params.push(queryParams.date_from)
  }
  if (queryParams.date_to) {
    conditions.push(`${alias}.${dateColumn}::date <= $${params.length + 1}`)
    params.push(queryParams.date_to)
  }
  return conditions
}

router.get('/sales', async (req, res) => {
  try {
    const params: any[] = []
    const conditions = dateConditions('o', 'sale_date', req.query, params)
    conditions.push("o.status IN ('delivered', 'collected_paid')")
    const salesIncome = shopDeliveryIncomeSql('o')
    const salesCost = shopDeliveryCostSql('o')
    const result = await query(
      `SELECT o.order_number, o.sale_date, o.created_at, c.name as customer, o.status, o.payment_status,
        o.delivery_type, o.subtotal + ${salesIncome} AS revenue, ${salesCost} AS delivery_cost,
        COALESCE(items.items, '-') AS items,
        COALESCE(items.product_cost,0) AS product_cost,
        o.subtotal + ${salesIncome} - ${salesCost} - COALESCE(items.product_cost,0) AS profit,
        CASE WHEN o.subtotal + ${salesIncome} > 0 THEN
          ROUND((o.subtotal + ${salesIncome} - ${salesCost} - COALESCE(items.product_cost,0))/(o.subtotal + ${salesIncome})*100,2)
          ELSE 0 END AS margin_percent,
        COALESCE(STRING_AGG(DISTINCT op.payment_method::text, ', '), 'credit') as payment_methods
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN order_payments op ON o.id = op.order_id
      LEFT JOIN LATERAL (
        SELECT STRING_AGG(p.name || ' x' || oi.quantity, ', ' ORDER BY p.name) AS items,
          SUM(oi.unit_cost*oi.internal_quantity + oi.supplier_cost*oi.supplier_quantity) AS product_cost
        FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=o.id
      ) items ON TRUE
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      GROUP BY o.id, c.name, items.items, items.product_cost
      ORDER BY o.sale_date DESC, o.created_at DESC`,
      params
    )
    sendRows(req, res, result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/inventory', async (req, res) => {
  try {
    const params: any[] = []
    const salesConditions = dateConditions('o', 'sale_date', req.query, params)
    salesConditions.push("oi.product_id=p.id")
    salesConditions.push("o.status IN ('delivered','collected_paid')")
    const result = await query(`
      SELECT p.name, p.sku, i.quantity, i.reserved_quantity, i.damaged_quantity, i.lost_quantity,
        i.returned_quantity, (i.quantity - i.reserved_quantity) as available_stock,
        p.reorder_level, p.cost_price AS average_cost,
        (GREATEST(i.quantity-i.reserved_quantity,0) * p.cost_price) as current_value,
        CASE
          WHEN i.quantity-i.reserved_quantity <= 0 THEN 'Out of stock'
          WHEN i.quantity-i.reserved_quantity <= p.reorder_level THEN 'Low stock'
          ELSE 'In stock'
        END AS stock_status,
        sales.last_sale, COALESCE(sales.units_sold,0) AS units_sold
      FROM inventory i
      JOIN products p ON i.product_id = p.id
      LEFT JOIN LATERAL (
        SELECT MAX(COALESCE(o.sale_date, o.created_at::date)) AS last_sale, SUM(oi.quantity)::int AS units_sold
        FROM order_items oi JOIN orders o ON o.id=oi.order_id
        WHERE ${salesConditions.join(' AND ')}
      ) sales ON TRUE
      WHERE p.deleted_at IS NULL
      ORDER BY stock_status, p.name
    `, params)
    sendRows(req, res, result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/category-demand', async (req, res) => {
  try {
    const today = nairobiBusinessDate()
    const dateFrom = String(req.query.date_from || today)
    const dateTo = String(req.query.date_to || today)
    const result = await query(`
      WITH product_sales AS (
        SELECT
          COALESCE(c.name, 'Uncategorized') AS category,
          p.name AS product,
          SUM(oi.quantity)::int AS units_sold,
          COUNT(DISTINCT o.id)::int AS orders,
          COALESCE(SUM(oi.total_price),0) AS revenue,
          COALESCE(SUM(oi.total_price - oi.unit_cost*oi.internal_quantity
            - oi.supplier_cost*oi.supplier_quantity),0) AS gross_profit
        FROM order_items oi
        JOIN orders o ON o.id=oi.order_id
        JOIN products p ON p.id=oi.product_id
        LEFT JOIN categories c ON c.id=p.category_id
        WHERE o.status IN ('delivered','collected_paid')
          AND COALESCE(o.sale_date, o.created_at::date) BETWEEN $1 AND $2
          AND p.deleted_at IS NULL
        GROUP BY COALESCE(c.name, 'Uncategorized'), p.id
      ), ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY category ORDER BY units_sold DESC, revenue DESC, product) AS product_rank
        FROM product_sales
      ), category_rollup AS (
        SELECT
          category,
          COUNT(*)::int AS products_sold,
          SUM(units_sold)::int AS units_sold,
          SUM(orders)::int AS orders,
          SUM(revenue) AS revenue,
          SUM(gross_profit) AS gross_profit
        FROM product_sales
        GROUP BY category
      ), top_products AS (
        SELECT
          category,
          STRING_AGG(
            (CASE WHEN LENGTH(product) > 72 THEN LEFT(product, 72) || '...' ELSE product END)
              || ' x' || units_sold,
            ', ' ORDER BY units_sold DESC, revenue DESC, product
          ) AS top_products
        FROM ranked
        WHERE product_rank <= 5
        GROUP BY category
      )
      SELECT
        cr.category,
        cr.products_sold,
        cr.units_sold,
        cr.orders,
        cr.revenue,
        cr.gross_profit,
        CASE WHEN cr.revenue > 0 THEN ROUND(cr.gross_profit / cr.revenue * 100, 0) ELSE 0 END AS average_margin_percent,
        COALESCE(tp.top_products, '-') AS top_products,
        CASE
          WHEN cr.units_sold >= 10 AND cr.gross_profit > 0 THEN 'Prioritise category'
          WHEN cr.units_sold >= 4 THEN 'Stock winners only'
          WHEN cr.units_sold > 0 THEN 'Monitor category'
          ELSE 'Low movement'
        END AS stocking_signal
      FROM category_rollup cr
      LEFT JOIN top_products tp ON tp.category=cr.category
      ORDER BY cr.revenue DESC, cr.units_sold DESC, cr.category
    `, [dateFrom, dateTo])
    sendRows(req, res, result.rows)
  } catch (error) {
    console.error('Category demand report error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/product-demand', async (req, res) => {
  try {
    const today = nairobiBusinessDate()
    const dateFrom = String(req.query.date_from || today)
    const dateTo = String(req.query.date_to || today)
    const result = await query(`
      WITH period AS (
        SELECT $1::date AS date_from, $2::date AS date_to,
          GREATEST(($2::date - $1::date + 1), 1)::numeric AS days
      ), sales AS (
        SELECT
          p.id AS product_id,
          COALESCE(c.name, 'Uncategorized') AS category,
          p.name AS product,
          COALESCE(NULLIF(p.sku, ''), '-') AS sku,
          SUM(oi.quantity)::int AS units_sold,
          COUNT(DISTINCT o.id)::int AS orders,
          COALESCE(SUM(oi.total_price),0) AS revenue,
          COALESCE(SUM(oi.total_price - oi.unit_cost*oi.internal_quantity
            - oi.supplier_cost*oi.supplier_quantity),0) AS gross_profit
        FROM order_items oi
        JOIN orders o ON o.id=oi.order_id
        JOIN products p ON p.id=oi.product_id
        LEFT JOIN categories c ON c.id=p.category_id
        WHERE o.status IN ('delivered','collected_paid')
          AND COALESCE(o.sale_date, o.created_at::date) BETWEEN $1 AND $2
          AND p.deleted_at IS NULL
        GROUP BY p.id, COALESCE(c.name, 'Uncategorized')
      ), stock AS (
        SELECT
          p.id AS product_id,
          COALESCE(i.quantity - i.reserved_quantity, 0)::numeric AS available_stock
        FROM products p
        LEFT JOIN inventory i ON i.product_id=p.id
        WHERE p.deleted_at IS NULL
      ), scored AS (
        SELECT
          sales.*,
          COALESCE(stock.available_stock,0) AS available_stock,
          ROUND(sales.units_sold::numeric / period.days, 2) AS average_daily_units,
          CEIL(sales.units_sold::numeric / period.days * 14)::int AS suggested_stock_14_days,
          CEIL(sales.units_sold::numeric / period.days * 30)::int AS suggested_stock_30_days
        FROM sales
        CROSS JOIN period
        LEFT JOIN stock ON stock.product_id=sales.product_id
      )
      SELECT
        category,
        product,
        sku,
        units_sold,
        orders,
        revenue,
        gross_profit,
        available_stock,
        average_daily_units,
        suggested_stock_14_days,
        suggested_stock_30_days,
        GREATEST(suggested_stock_14_days - available_stock, 0)::int AS reorder_gap,
        CASE
          WHEN units_sold > 0 AND available_stock <= 0 THEN 'Stock now'
          WHEN suggested_stock_14_days - available_stock > 0 THEN 'Increase stock'
          WHEN average_daily_units > 0 THEN 'Monitor demand'
          ELSE 'Low movement'
        END AS recommendation
      FROM scored
      ORDER BY category, units_sold DESC, revenue DESC, product
    `, [dateFrom, dateTo])
    sendRows(req, res, result.rows)
  } catch (error) {
    console.error('Product demand report error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/supplier-payables', async (req, res) => {
  try {
    const params: any[] = []
    const payableConditions = dateConditions('sp', 'created_at', req.query, params)
    const paymentConditions = dateConditions('pmt', 'created_at', req.query, params)
    const returnConditions = dateConditions('sr', 'created_at', req.query, params)
    const result = await query(`
      WITH payable_base AS (
        SELECT * FROM supplier_payables sp
        ${payableConditions.length ? 'WHERE ' + payableConditions.join(' AND ') : ''}
      ), payment_base AS (
        SELECT * FROM supplier_payments pmt
        ${paymentConditions.length ? 'WHERE ' + paymentConditions.join(' AND ') : ''}
      ), return_base AS (
        SELECT * FROM supplier_returns sr
        ${returnConditions.length ? 'WHERE ' + returnConditions.join(' AND ') : ''}
      )
      SELECT s.name AS supplier,
        COUNT(DISTINCT sp.order_id)::int AS orders_supplied,
        COUNT(DISTINCT oi.product_id)::int AS products_supplied,
        COALESCE(STRING_AGG(DISTINCT p.name, ', '), '-') AS products,
        COALESCE(SUM(sp.amount),0) AS supplier_cost,
        COALESCE(payments.amount,0) AS payments_made,
        COALESCE(returns.amount,0) AS credit_notes,
        COALESCE(SUM(sp.amount),0)-COALESCE(payments.amount,0)-COALESCE(returns.amount,0) AS outstanding,
        COALESCE(SUM(oi.total_price-oi.supplier_cost*oi.supplier_quantity),0) AS profit_generated,
        CASE WHEN SUM(oi.total_price) > 0 THEN
          ROUND(SUM(oi.total_price-oi.supplier_cost*oi.supplier_quantity)/SUM(oi.total_price)*100,2)
        ELSE 0 END AS average_margin_percent,
        MAX(sp.created_at) AS last_transaction
      FROM suppliers s
      LEFT JOIN payable_base sp ON sp.supplier_id=s.id
      LEFT JOIN order_items oi ON oi.id=sp.order_item_id
      LEFT JOIN products p ON p.id=oi.product_id
      LEFT JOIN LATERAL (SELECT SUM(amount) AS amount FROM payment_base WHERE supplier_id=s.id) payments ON TRUE
      LEFT JOIN LATERAL (SELECT SUM(amount) AS amount FROM return_base WHERE supplier_id=s.id) returns ON TRUE
      GROUP BY s.id, payments.amount, returns.amount
      ORDER BY outstanding DESC, s.name
    `, params)
    sendRows(req, res, result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/supplier-settlements', async (req, res) => {
  try {
    const params: any[] = []
    const conditions = dateConditions('ss', 'created_at', req.query, params)
    const result = await query(`
      SELECT ss.*, s.name as supplier_name
      FROM supplier_settlements ss
      JOIN suppliers s ON ss.supplier_id = s.id
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY ss.created_at DESC
    `, params)
    sendRows(req, res, result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/rider-earnings', async (req, res) => {
  try {
    const params: any[] = []
    const deliveryConditions = dateConditions('d', 'created_at', req.query, params)
    const earningConditions = dateConditions('re', 'created_at', req.query, params)
    const paymentConditions = dateConditions('rp', 'created_at', req.query, params)
    const result = await query(`
      WITH delivery_base AS (
        SELECT * FROM deliveries d
        WHERE d.delivery_status IN ('delivered','collected_paid')
        ${deliveryConditions.length ? 'AND ' + deliveryConditions.join(' AND ') : ''}
      ), earning_base AS (
        SELECT * FROM rider_earnings re
        WHERE re.status <> 'reversed'
        ${earningConditions.length ? 'AND ' + earningConditions.join(' AND ') : ''}
      ), payment_base AS (
        SELECT * FROM rider_payments rp
        ${paymentConditions.length ? 'WHERE ' + paymentConditions.join(' AND ') : ''}
      )
      SELECT r.name AS rider, COUNT(DISTINCT d.id)::int AS deliveries,
        COALESCE(SUM(d.delivery_income),0) AS collected_delivery_fees,
        COALESCE(SUM(d.delivery_cost),0) AS actual_rider_costs,
        COALESCE(earnings.amount,0) AS total_earnings,
        COALESCE(payments.amount,0) AS paid,
        COALESCE(earnings.amount,0)-COALESCE(payments.amount,0) AS outstanding_earnings,
        COALESCE(SUM(d.delivery_income-d.delivery_cost),0) AS profit_loss,
        COALESCE(AVG(d.delivery_income),0) AS average_delivery_fee,
        MAX(d.delivered_at) AS last_delivery
      FROM riders r
      LEFT JOIN delivery_base d ON d.rider_id=r.id
      LEFT JOIN LATERAL (SELECT SUM(amount) AS amount FROM earning_base WHERE rider_id=r.id) earnings ON TRUE
      LEFT JOIN LATERAL (SELECT SUM(amount) AS amount FROM payment_base WHERE rider_id=r.id) payments ON TRUE
      GROUP BY r.id, earnings.amount, payments.amount
      ORDER BY outstanding_earnings DESC, r.name
    `, params)
    sendRows(req, res, result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/rider-settlements', async (req, res) => {
  try {
    const params: any[] = []
    const conditions = dateConditions('rs', 'created_at', req.query, params)
    const result = await query(`
      SELECT rs.*, r.name as rider_name
      FROM rider_settlements rs
      JOIN riders r ON rs.rider_id = r.id
      ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY rs.created_at DESC
    `, params)
    sendRows(req, res, result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/cod-outstanding', async (req, res) => {
  try {
    const params: any[] = []
    const conditions = dateConditions('cc', 'created_at', req.query, params)
    conditions.push("cc.status NOT IN ('closed', 'remitted')")
    const result = await query(`
      SELECT cc.*, o.order_number, cr.name as courier_name,
        c.name AS customer, o.courier_tracking_number AS tracking_number,
        (cc.cod_amount - cc.remitted_amount) as outstanding_amount
      FROM cod_collections cc
      LEFT JOIN orders o ON cc.order_id = o.id
      LEFT JOIN customers c ON c.id=o.customer_id
      LEFT JOIN couriers cr ON cc.courier_id = cr.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY cc.created_at DESC
    `, params)
    sendRows(req, res, result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/cod-ageing', async (req, res) => {
  try {
    const params: any[] = []
    const conditions = dateConditions('cc', 'created_at', req.query, params)
    conditions.push("cc.status NOT IN ('closed', 'remitted')")
    const result = await query(`
      SELECT o.order_number, cr.name AS courier, o.courier_tracking_number AS tracking_number,
        c.name AS customer, cc.cod_amount,
        cc.remitted_amount, (cc.cod_amount - cc.remitted_amount) AS outstanding_amount,
        cc.delivered_at, CURRENT_DATE - COALESCE(cc.delivered_at::date, cc.created_at::date) AS age_days,
        CASE
          WHEN CURRENT_DATE - COALESCE(cc.delivered_at::date, cc.created_at::date) <= 2 THEN '0-2 days'
          WHEN CURRENT_DATE - COALESCE(cc.delivered_at::date, cc.created_at::date) <= 7 THEN '3-7 days'
          WHEN CURRENT_DATE - COALESCE(cc.delivered_at::date, cc.created_at::date) <= 14 THEN '8-14 days'
          ELSE '15+ days'
        END AS ageing_bucket,
        cc.status
      FROM cod_collections cc
      JOIN orders o ON o.id = cc.order_id
      LEFT JOIN customers c ON c.id=o.customer_id
      LEFT JOIN couriers cr ON cr.id = cc.courier_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY age_days DESC, cc.created_at
    `, params)
    sendRows(req, res, result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/customer-credit', async (req, res) => {
  try {
    const params: any[] = []
    const creditConditions = dateConditions('cc', 'created_at', req.query, params)
    const purchaseConditions = dateConditions('o', 'sale_date', req.query, params)
    const result = await query(`
      WITH credit_base AS (
        SELECT * FROM customer_credits cc
        ${creditConditions.length ? 'WHERE ' + creditConditions.join(' AND ') : ''}
      ), purchase_base AS (
        SELECT * FROM orders o
        ${purchaseConditions.length ? 'WHERE ' + purchaseConditions.join(' AND ') : ''}
      )
      SELECT c.name AS customer, c.phone, c.credit_limit,
        COALESCE(credit.credit_sales,0) AS credit_sales,
        COALESCE(credit.payments,0) AS payments,
        COALESCE(credit.outstanding,0) AS outstanding,
        COALESCE(purchases.orders,0) AS orders,
        COALESCE(purchases.lifetime_value,0) AS lifetime_value,
        purchases.last_purchase
      FROM customers c
      LEFT JOIN LATERAL (
        SELECT SUM(amount) FILTER (WHERE type='sale') AS credit_sales,
          -SUM(amount) FILTER (WHERE type='payment') AS payments,
          SUM(amount) AS outstanding
        FROM credit_base WHERE customer_id=c.id
      ) credit ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS orders,
          SUM(subtotal + ${shopDeliveryIncomeSql('purchase_base')}) FILTER (WHERE status IN ('delivered','collected_paid')) AS lifetime_value,
          MAX(COALESCE(sale_date, created_at::date)) AS last_purchase
        FROM purchase_base WHERE customer_id=c.id
      ) purchases ON TRUE
      ORDER BY outstanding DESC
    `, params)
    sendRows(req, res, result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/expenses', async (req, res) => {
  try {
    const params: any[] = []
    const conditions: string[] = []
    if (req.query.date_from && req.query.date_to) {
      conditions.push(`(
        (e.frequency = 'one_off' AND e.expense_date BETWEEN $${params.length + 1} AND $${params.length + 2})
        OR (e.frequency <> 'one_off' AND e.expense_date <= $${params.length + 2}
          AND COALESCE(e.effective_end_date, DATE '9999-12-31') >= $${params.length + 1})
      )`)
      params.push(req.query.date_from, req.query.date_to)
    } else if (req.query.date_from) {
      conditions.push(`(
        (e.frequency = 'one_off' AND e.expense_date >= $${params.length + 1})
        OR (e.frequency <> 'one_off' AND COALESCE(e.effective_end_date, DATE '9999-12-31') >= $${params.length + 1})
      )`)
      params.push(req.query.date_from)
    } else if (req.query.date_to) {
      conditions.push(`e.expense_date <= $${params.length + 1}`)
      params.push(req.query.date_to)
    }
    const result = await query(
      `SELECT e.*, u.full_name as created_by_name
       FROM expenses e
       LEFT JOIN users u ON e.created_by = u.id
       ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
       ORDER BY e.expense_date DESC`,
      params
    )
    sendRows(req, res, result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/profit', async (req, res) => {
  try {
    const today = nairobiBusinessDate()
    const dateFrom = String(req.query.date_from || today)
    const dateTo = String(req.query.date_to || dateFrom)
    const params: any[] = [dateFrom, dateTo]
    const conditions = ['COALESCE(o.sale_date, o.created_at::date) >= $1', 'COALESCE(o.sale_date, o.created_at::date) <= $2']
    conditions.push("o.status IN ('delivered', 'collected_paid')")
    const recognizedExpenses = recognizedExpensesSql('$1', '$2')
    const profitIncome = shopDeliveryIncomeSql('o')
    const profitCost = shopDeliveryCostSql('o')
    const result = await query(
      `WITH completed_orders AS (
         SELECT
           o.id, o.subtotal, ${profitIncome} AS delivery_income, ${profitCost} AS delivery_cost,
           COALESCE(SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE 0 END), 0) AS internal_cogs,
           COALESCE(SUM(CASE WHEN oi.fulfillment_type IN ('supplier', 'hybrid') THEN oi.supplier_cost * oi.supplier_quantity ELSE 0 END), 0) AS supplier_costs
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         WHERE ${conditions.join(' AND ')}
         GROUP BY o.id
       )
       SELECT
         COALESCE(SUM(subtotal + delivery_income), 0) AS revenue,
         COALESCE(SUM(internal_cogs), 0) AS internal_cogs,
         COALESCE(SUM(supplier_costs), 0) AS supplier_costs,
         COALESCE(SUM(delivery_cost), 0) AS delivery_costs,
         ${recognizedExpenses} AS expenses
       FROM completed_orders`,
      params
    )
    const row = result.rows[0]
    const revenue = Number(row.revenue || 0)
    const internalCogs = Number(row.internal_cogs || 0)
    const supplierCosts = Number(row.supplier_costs || 0)
    const deliveryCosts = Number(row.delivery_costs || 0)
    const expenses = Number(row.expenses || 0)
    res.json({
      revenue,
      internalCogs,
      supplierCosts,
      deliveryCosts,
      expenses,
      grossProfit: revenue - internalCogs - supplierCosts,
      netProfit: revenue - internalCogs - supplierCosts - deliveryCosts - expenses
    })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/reconciliation/daily', async (req, res) => {
  try {
    const { business_date, actual_cash, actual_mpesa, notes } = req.body
    const reconciliation = await transaction(async (client) => {
      const date = business_date || nairobiBusinessDate()
      const totals = await client.query(
        `SELECT
          COALESCE(SUM(CASE WHEN op.payment_method = 'cash' THEN op.amount ELSE 0 END), 0) as cash_sales,
          COALESCE(SUM(CASE WHEN op.payment_method = 'mpesa' THEN op.amount ELSE 0 END), 0) as mpesa_sales,
          COALESCE(SUM(CASE WHEN op.payment_method = 'bank_transfer' THEN op.amount ELSE 0 END), 0) as bank_transfer_sales
        FROM order_payments op
        WHERE op.payment_date = $1`,
        [date]
      )
      const expenseTotals = await client.query(
        `SELECT
          COALESCE(SUM(recognized_amount), 0) AS expenses,
          COALESCE(SUM(recognized_amount) FILTER (WHERE payment_method = 'cash'), 0) AS cash_expenses,
          COALESCE(SUM(recognized_amount) FILTER (WHERE payment_method = 'mpesa'), 0) AS mpesa_expenses
         FROM (
           SELECT e.payment_method,
             CASE
               WHEN e.frequency = 'one_off' THEN e.amount
               WHEN e.frequency = 'daily' THEN e.amount
               WHEN e.frequency = 'monthly' THEN
                 e.amount / EXTRACT(DAY FROM (date_trunc('month', days.day)::date + INTERVAL '1 month - 1 day'))::numeric
               ELSE 0
             END AS recognized_amount
           FROM generate_series($1::date, $1::date, INTERVAL '1 day') AS days(day)
           JOIN expenses e ON e.status = 'approved'
             AND e.expense_date <= days.day::date
             AND (e.effective_end_date IS NULL OR e.effective_end_date >= days.day::date)
             AND (
               e.frequency IN ('daily', 'monthly')
               OR (e.frequency = 'one_off' AND e.expense_date = days.day::date)
             )
         ) recognized_expenses`,
        [date]
      )
      const supplierPayments = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total,
          COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0) AS cash_total,
          COALESCE(SUM(amount) FILTER (WHERE payment_method = 'mpesa'), 0) AS mpesa_total
         FROM supplier_payments WHERE created_at::date = $1`,
        [date]
      )
      const riderPayments = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total,
          COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0) AS cash_total,
          COALESCE(SUM(amount) FILTER (WHERE payment_method = 'mpesa'), 0) AS mpesa_total
         FROM rider_payments WHERE created_at::date = $1`,
        [date]
      )
      const codCollections = await client.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM cod_remittances WHERE received_at::date = $1',
        [date]
      )

      const cashSales = Number(totals.rows[0].cash_sales || 0)
      const mpesaSales = Number(totals.rows[0].mpesa_sales || 0)
      const expenses = Number(expenseTotals.rows[0].expenses || 0)
      const supplierPaid = Number(supplierPayments.rows[0].total || 0)
      const riderPaid = Number(riderPayments.rows[0].total || 0)
      const codCollected = Number(codCollections.rows[0].total || 0)
      const expectedCash = cashSales
        - Number(expenseTotals.rows[0].cash_expenses || 0)
        - Number(supplierPayments.rows[0].cash_total || 0)
        - Number(riderPayments.rows[0].cash_total || 0)
      const expectedMpesa = mpesaSales
        - Number(expenseTotals.rows[0].mpesa_expenses || 0)
        - Number(supplierPayments.rows[0].mpesa_total || 0)
        - Number(riderPayments.rows[0].mpesa_total || 0)

      const result = await client.query(
        `INSERT INTO daily_reconciliations (
          business_date, cash_sales, actual_cash, cash_variance, mpesa_sales, actual_mpesa, mpesa_variance,
          bank_transfer_sales, cod_collections, expected_cash, expected_mpesa, expenses, supplier_payments, rider_payments, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (business_date) DO UPDATE SET
          cash_sales = EXCLUDED.cash_sales,
          actual_cash = EXCLUDED.actual_cash,
          cash_variance = EXCLUDED.cash_variance,
          mpesa_sales = EXCLUDED.mpesa_sales,
          actual_mpesa = EXCLUDED.actual_mpesa,
          mpesa_variance = EXCLUDED.mpesa_variance,
          bank_transfer_sales = EXCLUDED.bank_transfer_sales,
          cod_collections = EXCLUDED.cod_collections,
          expected_cash = EXCLUDED.expected_cash,
          expected_mpesa = EXCLUDED.expected_mpesa,
          expenses = EXCLUDED.expenses,
          supplier_payments = EXCLUDED.supplier_payments,
          rider_payments = EXCLUDED.rider_payments,
          notes = EXCLUDED.notes
        WHERE daily_reconciliations.status = 'pending'
        RETURNING *`,
        [
          date,
          cashSales,
          Number(actual_cash || 0),
          Number(actual_cash || 0) - expectedCash,
          mpesaSales,
          Number(actual_mpesa || 0),
          Number(actual_mpesa || 0) - expectedMpesa,
          Number(totals.rows[0].bank_transfer_sales || 0),
          codCollected,
          expectedCash,
          expectedMpesa,
          expenses,
          supplierPaid,
          riderPaid,
          notes || null
        ]
      )
      if (result.rows.length === 0) {
        throw Object.assign(new Error('This reconciliation is already closed'), { statusCode: 409 })
      }
      await client.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values)
         VALUES ($1, 'daily_reconciliation_calculated', 'daily_reconciliation', $2, $3)`,
        [req.user?.userId, result.rows[0].id, JSON.stringify(result.rows[0])]
      )
      return result.rows[0]
    })
    res.status(201).json(reconciliation)
  } catch (err) {
    const status = (err as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (err as Error).message } })
  }
})

router.get('/reconciliation/daily', async (req, res) => {
  try {
    const params: any[] = []
    const conditions: string[] = []
    if (req.query.date_from) {
      conditions.push(`business_date >= $${params.length + 1}`)
      params.push(req.query.date_from)
    }
    if (req.query.date_to) {
      conditions.push(`business_date <= $${params.length + 1}`)
      params.push(req.query.date_to)
    }
    const result = await query(
      `SELECT * FROM daily_reconciliations
       ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
       ORDER BY business_date DESC, created_at DESC`,
      params
    )
    sendRows(req, res, result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/reconciliation/daily/:id/close', async (req, res) => {
  try {
    const result = await query(
      `UPDATE daily_reconciliations
       SET status = 'closed', closed_by = $1, closed_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [req.user?.userId, req.params.id]
    )
    if (result.rows.length === 0) {
      return res.status(409).json({ error: { message: 'Only a pending reconciliation can be closed' } })
    }
    await query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values)
       VALUES ($1, 'daily_reconciliation_closed', 'daily_reconciliation', $2, $3)`,
      [req.user?.userId, req.params.id, JSON.stringify(result.rows[0])]
    )
    res.json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as reportRoutes }
