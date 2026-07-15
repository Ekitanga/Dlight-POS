import { Router } from 'express'
import { query } from '../db'
import { recognizedExpensesSql } from '../lib/expenseRecognition'

const router = Router()

function nairobiDate(value = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(value)
}

function firstDayOfMonth(date: string): string {
  return `${date.slice(0, 8)}01`
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

router.get('/stats', async (req, res) => {
  try {
    const { date_from, date_to } = req.query
    const today = nairobiDate()
    const weekAgo = nairobiDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
    const monthAgo = nairobiDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    const periodFrom = date_from || today
    const periodTo = date_to || today
    const monthStart = firstDayOfMonth(today)
    const periodExpensesSql = recognizedExpensesSql('$4', '$5')
    const todayExpensesSql = recognizedExpensesSql('$1', '$1')
    const mtdExpensesSql = recognizedExpensesSql('$6', '$1')
    const oIncome = shopDeliveryIncomeSql('o')
    const oCost = shopDeliveryCostSql('o')
    const o2Income = shopDeliveryIncomeSql('o2')
    const o2Cost = shopDeliveryCostSql('o2')

    const stats = await query(`
      SELECT 
        (SELECT COALESCE(SUM(o.subtotal + ${oIncome}), 0) FROM orders o WHERE COALESCE(o.sale_date, o.created_at::date) = $1 AND o.status IN ('delivered', 'collected_paid')) as today_sales,
        (SELECT COALESCE(SUM(o.subtotal + ${oIncome}), 0) FROM orders o WHERE COALESCE(o.sale_date, o.created_at::date) >= $2 AND o.status IN ('delivered', 'collected_paid')) as week_sales,
        (SELECT COALESCE(SUM(o.subtotal + ${oIncome}), 0) FROM orders o WHERE COALESCE(o.sale_date, o.created_at::date) >= $3 AND o.status IN ('delivered', 'collected_paid')) as month_sales,
        (SELECT COALESCE(SUM(o.subtotal + ${oIncome}), 0) FROM orders o WHERE COALESCE(o.sale_date, o.created_at::date) >= $4 AND COALESCE(o.sale_date, o.created_at::date) <= $5 AND o.status IN ('delivered', 'collected_paid')) as period_sales,
        (SELECT COUNT(*) FROM orders o WHERE COALESCE(o.sale_date, o.created_at::date) >= $4 AND COALESCE(o.sale_date, o.created_at::date) <= $5 AND o.status IN ('delivered', 'collected_paid')) as period_orders,
        (SELECT COALESCE(SUM(${oIncome} - ${oCost}), 0) FROM orders o WHERE COALESCE(o.sale_date, o.created_at::date) >= $4 AND COALESCE(o.sale_date, o.created_at::date) <= $5 AND o.status IN ('delivered', 'collected_paid')) as period_delivery_profit,
        ${periodExpensesSql} as period_expenses,
        ${todayExpensesSql} as today_expenses,
        ${mtdExpensesSql} as month_to_date_expenses,
        (SELECT COUNT(*) FROM orders o WHERE o.status NOT IN ('cancelled', 'returned')) as total_orders,
        (SELECT COALESCE(SUM(cc.cod_amount - cc.remitted_amount), 0) FROM cod_collections cc WHERE cc.status IN ('assigned_to_courier', 'in_transit', 'delivered_awaiting_remittance', 'partially_remitted', 'disputed')) as outstanding_cod,
        (SELECT COALESCE(SUM(s.balance), 0) FROM suppliers s) as supplier_payables,
        (SELECT COALESCE(SUM(r.balance), 0) FROM riders r) as rider_payables,
        (SELECT COUNT(*) FROM products p JOIN inventory i ON p.id = i.product_id
          WHERE p.deleted_at IS NULL AND p.is_active = TRUE
            AND (i.quantity - i.reserved_quantity) <= p.reorder_level) as low_stock_count,
        (SELECT COALESCE(SUM(
          o2.subtotal + ${o2Income}
          - COALESCE((SELECT SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE oi.supplier_cost * oi.supplier_quantity END) FROM order_items oi WHERE oi.order_id = o2.id), 0)
        ), 0) FROM orders o2 WHERE o2.status IN ('delivered', 'collected_paid')
          AND COALESCE(o2.sale_date, o2.created_at::date) >= $4 AND COALESCE(o2.sale_date, o2.created_at::date) <= $5) as gross_profit,
        (SELECT COALESCE(SUM(
          o2.subtotal + ${o2Income} - ${o2Cost}
          - COALESCE((SELECT SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE oi.supplier_cost * oi.supplier_quantity END) FROM order_items oi WHERE oi.order_id = o2.id), 0)
        ), 0) FROM orders o2 WHERE o2.status IN ('delivered', 'collected_paid')
          AND COALESCE(o2.sale_date, o2.created_at::date) >= $4 AND COALESCE(o2.sale_date, o2.created_at::date) <= $5)
        - ${periodExpensesSql} as net_profit,
        (SELECT COALESCE(SUM(
          o2.subtotal + ${o2Income} - ${o2Cost}
          - COALESCE((SELECT SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE oi.supplier_cost * oi.supplier_quantity END) FROM order_items oi WHERE oi.order_id = o2.id), 0)
        ), 0) FROM orders o2 WHERE o2.status IN ('delivered', 'collected_paid')
          AND COALESCE(o2.sale_date, o2.created_at::date) = $1) as today_gross_after_delivery,
        (SELECT COALESCE(SUM(
          o2.subtotal + ${o2Income} - ${o2Cost}
          - COALESCE((SELECT SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE oi.supplier_cost * oi.supplier_quantity END) FROM order_items oi WHERE oi.order_id = o2.id), 0)
        ), 0) FROM orders o2 WHERE o2.status IN ('delivered', 'collected_paid')
          AND COALESCE(o2.sale_date, o2.created_at::date) = $1)
        - ${todayExpensesSql} as today_operating_profit,
        (SELECT COALESCE(SUM(
          o2.subtotal + ${o2Income} - ${o2Cost}
          - COALESCE((SELECT SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE oi.supplier_cost * oi.supplier_quantity END) FROM order_items oi WHERE oi.order_id = o2.id), 0)
        ), 0) FROM orders o2 WHERE o2.status IN ('delivered', 'collected_paid')
          AND COALESCE(o2.sale_date, o2.created_at::date) >= $6 AND COALESCE(o2.sale_date, o2.created_at::date) <= $1)
        - ${mtdExpensesSql} as month_to_date_net_profit
    `, [today, weekAgo, monthAgo, periodFrom, periodTo, monthStart])

    const row = stats.rows[0]
    res.json({
      todaySales: parseFloat(row.today_sales),
      weekSales: parseFloat(row.week_sales),
      monthSales: parseFloat(row.month_sales),
      periodSales: parseFloat(row.period_sales),
      periodOrders: parseInt(row.period_orders),
      periodDeliveryProfit: parseFloat(row.period_delivery_profit),
      periodExpenses: parseFloat(row.period_expenses),
      todayExpenses: parseFloat(row.today_expenses),
      todayGrossAfterDelivery: parseFloat(row.today_gross_after_delivery),
      todayOperatingProfit: parseFloat(row.today_operating_profit),
      monthToDateExpenses: parseFloat(row.month_to_date_expenses),
      monthToDateNetProfit: parseFloat(row.month_to_date_net_profit),
      totalOrders: parseInt(row.total_orders),
      outstandingCOD: parseFloat(row.outstanding_cod),
      supplierPayables: parseFloat(row.supplier_payables),
      riderPayables: parseFloat(row.rider_payables),
      lowStockCount: parseInt(row.low_stock_count),
      grossProfit: parseFloat(row.gross_profit),
      netProfit: parseFloat(row.net_profit)
    })
  } catch (err) {
    console.error('Dashboard error:', err)
    res.json({
      todaySales: 0,
      weekSales: 0,
      monthSales: 0,
      periodSales: 0,
      periodOrders: 0,
      periodDeliveryProfit: 0,
      periodExpenses: 0,
      todayExpenses: 0,
      todayGrossAfterDelivery: 0,
      todayOperatingProfit: 0,
      monthToDateExpenses: 0,
      monthToDateNetProfit: 0,
      totalOrders: 0,
      outstandingCOD: 0,
      supplierPayables: 0,
      riderPayables: 0,
      lowStockCount: 0,
      grossProfit: 0,
      netProfit: 0
    })
  }
})

export { router as dashboardRoutes }
