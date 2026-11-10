import { recognizedExpensesSql } from './expenseRecognition.js'

type Executor = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }

export function shopDeliveryIncomeSql(alias: string): string {
  return `(CASE WHEN ${alias}.delivery_type = 'courier'
    AND ${alias}.courier_payment_type = 'cod'
    AND ${alias}.delivery_fee_payment_method IN ('paid_to_courier', 'pay_on_delivery')
    THEN 0 ELSE ${alias}.delivery_income END)`
}

export function shopDeliveryCostSql(alias: string): string {
  return `(CASE WHEN ${alias}.delivery_type = 'courier'
    AND ${alias}.courier_payment_type = 'cod'
    AND ${alias}.delivery_fee_payment_method IN ('paid_to_courier', 'pay_on_delivery')
    THEN 0 ELSE ${alias}.delivery_cost END)`
}

export interface ProfitSummary {
  revenue: number
  internalCogs: number
  supplierCosts: number
  deliveryCosts: number
  expenses: number
  grossProfit: number
  netProfit: number
}

/**
 * Profit for completed orders (delivered / collected_paid) whose business date
 * falls in [dateFrom, dateTo], less approved expenses recognised in that range.
 * This is the single definition used by Reports > Profit and by Tithe.
 */
export async function profitSummary(executor: Executor, dateFrom: string, dateTo: string): Promise<ProfitSummary> {
  const result = await executor.query(
    `WITH completed_orders AS (
       SELECT
         o.id, o.subtotal, ${shopDeliveryIncomeSql('o')} AS delivery_income, ${shopDeliveryCostSql('o')} AS delivery_cost,
         COALESCE(SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE 0 END), 0) AS internal_cogs,
         COALESCE(SUM(CASE WHEN oi.fulfillment_type IN ('supplier', 'hybrid') THEN oi.supplier_cost * oi.supplier_quantity ELSE 0 END), 0) AS supplier_costs
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE COALESCE(o.sale_date, o.created_at::date) >= $1
         AND COALESCE(o.sale_date, o.created_at::date) <= $2
         AND o.status IN ('delivered', 'collected_paid')
       GROUP BY o.id
     )
     SELECT
       COALESCE(SUM(subtotal + delivery_income), 0) AS revenue,
       COALESCE(SUM(internal_cogs), 0) AS internal_cogs,
       COALESCE(SUM(supplier_costs), 0) AS supplier_costs,
       COALESCE(SUM(delivery_cost), 0) AS delivery_costs,
       ${recognizedExpensesSql('$1', '$2')} AS expenses
     FROM completed_orders`,
    [dateFrom, dateTo]
  )
  const row = result.rows[0] || {}
  const revenue = Number(row.revenue || 0)
  const internalCogs = Number(row.internal_cogs || 0)
  const supplierCosts = Number(row.supplier_costs || 0)
  const deliveryCosts = Number(row.delivery_costs || 0)
  const expenses = Number(row.expenses || 0)
  return {
    revenue,
    internalCogs,
    supplierCosts,
    deliveryCosts,
    expenses,
    grossProfit: revenue - internalCogs - supplierCosts,
    netProfit: revenue - internalCogs - supplierCosts - deliveryCosts - expenses
  }
}
