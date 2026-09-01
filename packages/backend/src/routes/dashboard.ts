import { Router } from 'express'
import { query } from '../db/index.js'
import { recognizedExpensesSql } from '../lib/expenseRecognition.js'
import { getUserPermissions } from '../middleware/auth.js'
import { evaluateOrderItemFromRecords } from '../services/commission.js'

const router = Router()

const dashboardStatPermissions = [
  'dashboard.personal_sales',
  'dashboard.personal_orders',
  'dashboard.pending_speedaf',
  'dashboard.management_sales',
  'dashboard.management_profit',
  'dashboard.management_expenses',
  'dashboard.management_suppliers',
  'dashboard.management_riders',
  'dashboard.management_inventory'
]

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

function commissionCompletionTimestampSql(alias: string): string {
  return `(CASE
    WHEN ${alias}.delivery_type = 'courier' AND ${alias}.courier_payment_type = 'cod' THEN (
      SELECT COALESCE(cc.remitted_at, cc.closed_at)
      FROM cod_collections cc
      WHERE cc.order_id = ${alias}.id
        AND cc.status IN ('remitted', 'closed')
        AND cc.remitted_amount >= cc.cod_amount
      LIMIT 1
    )
    ELSE COALESCE(${alias}.commission_completion_at, (
      SELECT al.created_at
      FROM audit_logs al
      WHERE al.entity_type = 'order' AND al.entity_id = ${alias}.id
        AND al.action = 'order_status_changed'
        AND al.new_values->>'status' IN ('delivered', 'collected_paid')
      ORDER BY al.created_at DESC, al.id DESC
      LIMIT 1
    ))
  END)`
}

function physicalDeliveryTimestampSql(alias: string): string {
  return `(CASE
    WHEN ${alias}.delivery_type = 'courier' AND ${alias}.courier_payment_type = 'cod' THEN (
      SELECT cc.delivered_at FROM cod_collections cc WHERE cc.order_id = ${alias}.id LIMIT 1
    )
    ELSE (
      SELECT d.delivered_at FROM deliveries d WHERE d.order_id = ${alias}.id ORDER BY d.created_at DESC LIMIT 1
    )
  END)`
}

function commissionCompletedStatusSql(alias: string): string {
  return `(${alias}.status = 'collected_paid' OR (
    ${alias}.status = 'delivered'
    AND NOT (${alias}.delivery_type = 'courier' AND ${alias}.courier_payment_type = 'cod')
  ))`
}

function asNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function asInteger(value: unknown): number {
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function isBusinessDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

function nextMonthStart(monthStart: string): string {
  const [year, month] = monthStart.split('-').map(Number)
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10)
}

const personalOrderCards: Record<string, { permission: string; title: string; condition: string }> = {
  my_sales_today: {
    permission: 'dashboard.personal_sales',
    title: 'My completed sales today',
    condition: `COALESCE(o.sale_date, o.created_at::date) = $2::date AND ${commissionCompletedStatusSql('o')}`
  },
  my_sales_period: {
    permission: 'dashboard.personal_sales',
    title: 'My completed sales for the selected period',
    condition: `COALESCE(o.sale_date, o.created_at::date) BETWEEN $2::date AND $3::date AND ${commissionCompletedStatusSql('o')}`
  },
  my_orders_period: {
    permission: 'dashboard.personal_orders',
    title: 'My orders for the selected period',
    condition: 'COALESCE(o.sale_date, o.created_at::date) BETWEEN $2::date AND $3::date'
  },
  my_open_orders: {
    permission: 'dashboard.personal_orders',
    title: 'My open orders',
    condition: "o.status NOT IN ('delivered', 'collected_paid', 'cancelled', 'returned')"
  },
  my_completed_orders: {
    permission: 'dashboard.personal_orders',
    title: 'My completed sales for the selected period',
    condition: `${commissionCompletedStatusSql('o')}
      AND ${commissionCompletionTimestampSql('o')}::date BETWEEN $2::date AND $3::date`
  },
  my_speedaf_pending: {
    permission: 'dashboard.pending_speedaf',
    title: 'My Speedaf orders awaiting completion',
    condition: `o.delivery_type = 'courier' AND o.courier_payment_type = 'cod'
      AND COALESCE(cc.status, '') IN ('assigned_to_courier', 'in_transit', 'delivered_awaiting_remittance', 'partially_remitted', 'disputed')`
  }
}

const ownCommissionPermissions = [
  'commission.own_view', 'commission.own_monthly', 'commission.own_transactions'
]

const commissionCardTitles: Record<string, string> = {
  recorded: 'Recorded commission sales',
  pending: 'Commission pending approval',
  reversals: 'Commission reversals',
  balance: 'Commission balance breakdown',
  approved: 'Approved commission',
  paid: 'Paid commission',
  outstanding: 'Outstanding commission',
  recovery: 'Commission recovery',
  salespeople: 'Commission by salesperson'
}

router.get('/stats', async (req, res) => {
  try {
    const permissions = new Set(await getUserPermissions(req.user!.userId, req.user!.role))
    const allowed = (permission: string) => permissions.has(permission)

    // dashboard.view is intentionally not sufficient here. It is a legacy shell
    // permission; this endpoint returns data only to a role with a concrete
    // dashboard widget grant.
    if (!dashboardStatPermissions.some(allowed)) {
      return res.status(403).json({ error: { message: 'A dashboard statistic permission is required' } })
    }

    const dateFrom = typeof req.query.date_from === 'string' ? req.query.date_from : undefined
    const dateTo = typeof req.query.date_to === 'string' ? req.query.date_to : undefined
    const today = nairobiDate()
    const weekAgo = nairobiDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
    const monthAgo = nairobiDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    const periodFrom = dateFrom || today
    const periodTo = dateTo || today
    const monthStart = firstDayOfMonth(today)
    const parameters = [today, weekAgo, monthAgo, periodFrom, periodTo, monthStart, req.user!.userId]
    const payload: Record<string, number> = {}

    // Build the management query from only the fragments the caller is allowed
    // to see. This is deliberately not a "query everything, then redact"
    // endpoint: an unauthorised category is absent from the SQL altogether.
    const managementFields: string[] = []
    const oIncome = shopDeliveryIncomeSql('o')
    const oCost = shopDeliveryCostSql('o')
    const o2Income = shopDeliveryIncomeSql('o2')
    const o2Cost = shopDeliveryCostSql('o2')

    if (allowed('dashboard.management_sales')) {
      managementFields.push(
        `(SELECT COALESCE(SUM(o.subtotal + ${oIncome}), 0)
            FROM orders o
           WHERE COALESCE(o.sale_date, o.created_at::date) = $1
             AND o.status IN ('delivered', 'collected_paid')) AS today_sales`,
        `(SELECT COALESCE(SUM(o.subtotal + ${oIncome}), 0)
            FROM orders o
           WHERE COALESCE(o.sale_date, o.created_at::date) >= $2
             AND o.status IN ('delivered', 'collected_paid')) AS week_sales`,
        `(SELECT COALESCE(SUM(o.subtotal + ${oIncome}), 0)
            FROM orders o
           WHERE COALESCE(o.sale_date, o.created_at::date) >= $3
             AND o.status IN ('delivered', 'collected_paid')) AS month_sales`,
        `(SELECT COALESCE(SUM(o.subtotal + ${oIncome}), 0)
            FROM orders o
           WHERE COALESCE(o.sale_date, o.created_at::date) >= $4
             AND COALESCE(o.sale_date, o.created_at::date) <= $5
             AND o.status IN ('delivered', 'collected_paid')) AS period_sales`,
        `(SELECT COUNT(*) FROM orders o
           WHERE COALESCE(o.sale_date, o.created_at::date) >= $4
             AND COALESCE(o.sale_date, o.created_at::date) <= $5
             AND o.status IN ('delivered', 'collected_paid')) AS period_orders`,
        `(SELECT COUNT(*) FROM orders o
           WHERE o.status NOT IN ('cancelled', 'returned')) AS total_orders`,
        `(SELECT COALESCE(SUM(cc.cod_amount - cc.remitted_amount), 0)
            FROM cod_collections cc
           WHERE cc.status IN ('assigned_to_courier', 'in_transit', 'delivered_awaiting_remittance', 'partially_remitted', 'disputed')) AS outstanding_cod`
      )
    }

    if (allowed('dashboard.management_profit')) {
      const periodExpensesSql = recognizedExpensesSql('$4', '$5')
      const todayExpensesSql = recognizedExpensesSql('$1', '$1')
      const mtdExpensesSql = recognizedExpensesSql('$6', '$1')
      managementFields.push(
        `(SELECT COALESCE(SUM(${oIncome} - ${oCost}), 0)
            FROM orders o
           WHERE COALESCE(o.sale_date, o.created_at::date) >= $4
             AND COALESCE(o.sale_date, o.created_at::date) <= $5
             AND o.status IN ('delivered', 'collected_paid')) AS period_delivery_profit`,
        `(SELECT COALESCE(SUM(
            o2.subtotal + ${o2Income}
            - COALESCE((SELECT SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE oi.supplier_cost * oi.supplier_quantity END)
                FROM order_items oi WHERE oi.order_id = o2.id), 0)
          ), 0)
            FROM orders o2
           WHERE o2.status IN ('delivered', 'collected_paid')
             AND COALESCE(o2.sale_date, o2.created_at::date) >= $4
             AND COALESCE(o2.sale_date, o2.created_at::date) <= $5) AS gross_profit`,
        `(SELECT COALESCE(SUM(
            o2.subtotal + ${o2Income} - ${o2Cost}
            - COALESCE((SELECT SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE oi.supplier_cost * oi.supplier_quantity END)
                FROM order_items oi WHERE oi.order_id = o2.id), 0)
          ), 0)
            FROM orders o2
           WHERE o2.status IN ('delivered', 'collected_paid')
             AND COALESCE(o2.sale_date, o2.created_at::date) >= $4
             AND COALESCE(o2.sale_date, o2.created_at::date) <= $5)
          - ${periodExpensesSql} AS net_profit`,
        `(SELECT COALESCE(SUM(
            o2.subtotal + ${o2Income} - ${o2Cost}
            - COALESCE((SELECT SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE oi.supplier_cost * oi.supplier_quantity END)
                FROM order_items oi WHERE oi.order_id = o2.id), 0)
          ), 0)
            FROM orders o2
           WHERE o2.status IN ('delivered', 'collected_paid')
             AND COALESCE(o2.sale_date, o2.created_at::date) = $1) AS today_gross_after_delivery`,
        `(SELECT COALESCE(SUM(
            o2.subtotal + ${o2Income} - ${o2Cost}
            - COALESCE((SELECT SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE oi.supplier_cost * oi.supplier_quantity END)
                FROM order_items oi WHERE oi.order_id = o2.id), 0)
          ), 0)
            FROM orders o2
           WHERE o2.status IN ('delivered', 'collected_paid')
             AND COALESCE(o2.sale_date, o2.created_at::date) = $1)
          - ${todayExpensesSql} AS today_operating_profit`,
        `(SELECT COALESCE(SUM(
            o2.subtotal + ${o2Income} - ${o2Cost}
            - COALESCE((SELECT SUM(CASE WHEN oi.fulfillment_type = 'internal' THEN oi.unit_cost * oi.internal_quantity ELSE oi.supplier_cost * oi.supplier_quantity END)
                FROM order_items oi WHERE oi.order_id = o2.id), 0)
          ), 0)
            FROM orders o2
           WHERE o2.status IN ('delivered', 'collected_paid')
             AND COALESCE(o2.sale_date, o2.created_at::date) >= $6
             AND COALESCE(o2.sale_date, o2.created_at::date) <= $1)
          - ${mtdExpensesSql} AS month_to_date_net_profit`
      )
    }

    if (allowed('dashboard.management_expenses')) {
      managementFields.push(
        `${recognizedExpensesSql('$4', '$5')} AS period_expenses`,
        `${recognizedExpensesSql('$1', '$1')} AS today_expenses`,
        `${recognizedExpensesSql('$6', '$1')} AS month_to_date_expenses`
      )
    }

    if (allowed('dashboard.management_suppliers')) {
      managementFields.push(`(SELECT COALESCE(SUM(s.balance), 0) FROM suppliers s) AS supplier_payables`)
    }

    if (allowed('dashboard.management_riders')) {
      managementFields.push(`(SELECT COALESCE(SUM(r.balance), 0) FROM riders r) AS rider_payables`)
    }

    if (allowed('dashboard.management_inventory')) {
      managementFields.push(
        `(SELECT COUNT(*) FROM products p JOIN inventory i ON p.id = i.product_id
           WHERE p.deleted_at IS NULL AND p.is_active = TRUE
             AND (i.quantity - i.reserved_quantity) <= p.reorder_level) AS low_stock_count`,
        `(SELECT COALESCE(SUM(i.quantity * p.cost_price), 0)
            FROM inventory i JOIN products p ON p.id = i.product_id
           WHERE p.deleted_at IS NULL AND p.is_active = TRUE) AS shop_stock_value`,
        `(SELECT COALESCE(SUM(GREATEST(i.quantity - i.reserved_quantity, 0) * p.cost_price), 0)
            FROM inventory i JOIN products p ON p.id = i.product_id
           WHERE p.deleted_at IS NULL AND p.is_active = TRUE) AS available_stock_value`,
        `(SELECT COALESCE(SUM(i.reserved_quantity * p.cost_price), 0)
            FROM inventory i JOIN products p ON p.id = i.product_id
           WHERE p.deleted_at IS NULL AND p.is_active = TRUE) AS reserved_stock_value`,
        `(SELECT COALESCE(SUM(i.damaged_quantity * p.cost_price), 0)
            FROM inventory i JOIN products p ON p.id = i.product_id
           WHERE p.deleted_at IS NULL AND p.is_active = TRUE) AS damaged_stock_value`,
        `(SELECT COALESCE(SUM(GREATEST(i.quantity - i.reserved_quantity, 0) * p.selling_price), 0)
            FROM inventory i JOIN products p ON p.id = i.product_id
           WHERE p.deleted_at IS NULL AND p.is_active = TRUE) AS expected_sales_value`,
        `(SELECT COALESCE(SUM(
            GREATEST(i.quantity - i.reserved_quantity, 0) * p.selling_price
            - GREATEST(i.quantity - i.reserved_quantity, 0) * p.cost_price
          ), 0)
            FROM inventory i JOIN products p ON p.id = i.product_id
           WHERE p.deleted_at IS NULL AND p.is_active = TRUE) AS potential_gross_margin`,
        `(SELECT COUNT(*) FROM products p JOIN inventory i ON p.id = i.product_id
           WHERE p.deleted_at IS NULL AND p.is_active = TRUE
             AND p.cost_price <= 0 AND i.quantity > 0) AS missing_cost_count`
      )
    }

    if (managementFields.length > 0) {
      const managementSelectSql = `SELECT ${managementFields.join(',\n')}`
      const placeholderNumbers = [...managementSelectSql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]))
      const highestPlaceholder = Math.max(0, ...placeholderNumbers)
      const parameterTypes = ['date', 'date', 'date', 'date', 'date', 'date', 'uuid']
      // Explicitly type every positional parameter up to the highest one. Some
      // permission combinations legitimately omit an earlier parameter from
      // the SELECT fragments, and PostgreSQL otherwise rejects the gap.
      const typedParameters = Array.from({ length: highestPlaceholder }, (_, index) => `$${index + 1}::${parameterTypes[index]} AS p${index + 1}`)
      const managementSql = highestPlaceholder > 0
        ? `WITH dashboard_parameter_types AS (SELECT ${typedParameters.join(', ')}) ${managementSelectSql}`
        : managementSelectSql
      const managementParameters = parameters.slice(0, highestPlaceholder)
      const management = await query(managementSql, managementParameters)
      const row = management.rows[0]

      if (allowed('dashboard.management_sales')) {
        Object.assign(payload, {
          todaySales: asNumber(row.today_sales),
          weekSales: asNumber(row.week_sales),
          monthSales: asNumber(row.month_sales),
          periodSales: asNumber(row.period_sales),
          periodOrders: asInteger(row.period_orders),
          totalOrders: asInteger(row.total_orders),
          outstandingCOD: asNumber(row.outstanding_cod)
        })
      }
      if (allowed('dashboard.management_profit')) {
        Object.assign(payload, {
          periodDeliveryProfit: asNumber(row.period_delivery_profit),
          grossProfit: asNumber(row.gross_profit),
          netProfit: asNumber(row.net_profit),
          todayGrossAfterDelivery: asNumber(row.today_gross_after_delivery),
          todayOperatingProfit: asNumber(row.today_operating_profit),
          monthToDateNetProfit: asNumber(row.month_to_date_net_profit)
        })
      }
      if (allowed('dashboard.management_expenses')) {
        Object.assign(payload, {
          periodExpenses: asNumber(row.period_expenses),
          todayExpenses: asNumber(row.today_expenses),
          monthToDateExpenses: asNumber(row.month_to_date_expenses)
        })
      }
      if (allowed('dashboard.management_suppliers')) payload.supplierPayables = asNumber(row.supplier_payables)
      if (allowed('dashboard.management_riders')) payload.riderPayables = asNumber(row.rider_payables)
      if (allowed('dashboard.management_inventory')) {
        Object.assign(payload, {
          lowStockCount: asInteger(row.low_stock_count),
          shopStockValue: asNumber(row.shop_stock_value),
          availableStockValue: asNumber(row.available_stock_value),
          reservedStockValue: asNumber(row.reserved_stock_value),
          damagedStockValue: asNumber(row.damaged_stock_value),
          expectedSalesValue: asNumber(row.expected_sales_value),
          potentialGrossMargin: asNumber(row.potential_gross_margin),
          missingCostCount: asInteger(row.missing_cost_count)
        })
      }
    }

    const hasPersonalSales = allowed('dashboard.personal_sales')
    const hasPersonalOrders = allowed('dashboard.personal_orders')
    const hasPersonalSpeedaf = allowed('dashboard.pending_speedaf')
    if (hasPersonalSales || hasPersonalOrders || hasPersonalSpeedaf) {
      // The personal query has its own compact parameter list. PostgreSQL
      // cannot infer types for unused positional parameters, so do not reuse
      // the seven-value management list merely because the user id was $7.
      const personalParameters: any[] = [req.user!.userId]
      const personalFields: string[] = []
      let todayParameter = 0
      let periodFromParameter = 0
      let periodToParameter = 0
      if (hasPersonalSales) {
        personalParameters.push(today)
        todayParameter = personalParameters.length
      }
      if (hasPersonalSales || hasPersonalOrders) {
        personalParameters.push(periodFrom, periodTo)
        periodFromParameter = personalParameters.length - 1
        periodToParameter = personalParameters.length
      }
      if (hasPersonalSales) {
        personalFields.push(
          `COALESCE(SUM(o.subtotal + ${oIncome}) FILTER (
             WHERE COALESCE(o.sale_date, o.created_at::date) = $${todayParameter}::date
               AND ${commissionCompletedStatusSql('o')}
           ), 0) AS today_sales`,
          `COALESCE(SUM(o.subtotal + ${oIncome}) FILTER (
             WHERE COALESCE(o.sale_date, o.created_at::date) >= $${periodFromParameter}::date
               AND COALESCE(o.sale_date, o.created_at::date) <= $${periodToParameter}::date
               AND ${commissionCompletedStatusSql('o')}
           ), 0) AS period_sales`
        )
      }
      if (hasPersonalOrders) {
        personalFields.push(
          `COUNT(*) FILTER (
             WHERE COALESCE(o.sale_date, o.created_at::date) >= $${periodFromParameter}::date
               AND COALESCE(o.sale_date, o.created_at::date) <= $${periodToParameter}::date
            )::int AS period_orders`,
          `COUNT(*) FILTER (
             WHERE o.status NOT IN ('delivered', 'collected_paid', 'cancelled', 'returned')
           )::int AS open_orders`,
          `COUNT(*) FILTER (
             WHERE ${commissionCompletedStatusSql('o')}
               AND ${commissionCompletionTimestampSql('o')}::date >= $${periodFromParameter}::date
               AND ${commissionCompletionTimestampSql('o')}::date <= $${periodToParameter}::date
           )::int AS completed_orders`
        )
      }
      if (hasPersonalSpeedaf) {
        personalFields.push(
          `COUNT(*) FILTER (
             WHERE o.delivery_type = 'courier' AND o.courier_payment_type = 'cod'
               AND COALESCE(cc.status, '') IN ('assigned_to_courier', 'in_transit', 'delivered_awaiting_remittance', 'partially_remitted', 'disputed')
           )::int AS pending_speedaf_orders`,
          `COALESCE(SUM(GREATEST(COALESCE(cc.cod_amount, 0) - COALESCE(cc.remitted_amount, 0), 0)) FILTER (
             WHERE o.delivery_type = 'courier' AND o.courier_payment_type = 'cod'
               AND COALESCE(cc.status, '') IN ('assigned_to_courier', 'in_transit', 'delivered_awaiting_remittance', 'partially_remitted', 'disputed')
           ), 0) AS pending_speedaf_value`
        )
      }

      const personal = await query(
        `SELECT ${personalFields.join(',\n')}
           FROM orders o
           ${hasPersonalSpeedaf ? 'LEFT JOIN cod_collections cc ON cc.order_id = o.id' : ''}
          WHERE o.created_by = $1`,
        personalParameters
      )
      const row = personal.rows[0]
      if (hasPersonalSales) {
        payload.myTodaySales = asNumber(row.today_sales)
        payload.myPeriodSales = asNumber(row.period_sales)
      }
      if (hasPersonalOrders) {
        payload.myPeriodOrders = asInteger(row.period_orders)
        payload.myOpenOrders = asInteger(row.open_orders)
        payload.myCompletedOrders = asInteger(row.completed_orders)
      }
      if (hasPersonalSpeedaf) {
        payload.myPendingSpeedafOrders = asInteger(row.pending_speedaf_orders)
        payload.myPendingSpeedafValue = asNumber(row.pending_speedaf_value)
      }
    }

    res.json(payload)
  } catch (err) {
    console.error('Dashboard error:', err)
    res.status(500).json({ error: { message: 'Unable to load dashboard data' } })
  }
})

router.get('/drilldown', async (req, res) => {
  try {
    const card = String(req.query.card || '')
    const permissions = new Set(await getUserPermissions(req.user!.userId, req.user!.role))
    const allowed = (permission: string) => permissions.has(permission)
    const today = nairobiDate()
    const dateFrom = typeof req.query.date_from === 'string' ? req.query.date_from : today
    const dateTo = typeof req.query.date_to === 'string' ? req.query.date_to : today
    if (!isBusinessDate(dateFrom) || !isBusinessDate(dateTo) || dateFrom > dateTo) {
      return res.status(400).json({ error: { message: 'A valid dashboard date range is required' } })
    }

    const personalCard = personalOrderCards[card]
    if (personalCard) {
      if (!allowed(personalCard.permission)) {
        return res.status(403).json({ error: { message: `Permission required: ${personalCard.permission}` } })
      }
      const saleAmount = `(o.subtotal + ${shopDeliveryIncomeSql('o')})`
      const orderSort = card === 'my_completed_orders'
        ? `${commissionCompletionTimestampSql('o')} DESC NULLS LAST, o.created_at DESC`
        : 'COALESCE(o.sale_date, o.created_at::date) DESC, o.created_at DESC'
      const orderSql = `SELECT o.id AS order_id, o.order_number, o.sale_date, o.status, o.payment_status,
                o.delivery_type, o.courier_payment_type, ${saleAmount} AS sale_amount,
                creator.full_name AS creator_name,
                COALESCE(items.total_quantity, 0)::int AS total_quantity,
                COALESCE(items.product_summary, 'No products') AS product_summary,
                COALESCE(items.order_item_ids, ARRAY[]::uuid[]) AS order_item_ids,
                ${physicalDeliveryTimestampSql('o')} AS delivery_date,
                ${commissionCompletionTimestampSql('o')} AS completion_date,
                COALESCE(cc.status, '') AS cod_status,
                GREATEST(COALESCE(cc.cod_amount, 0) - COALESCE(cc.remitted_amount, 0), 0) AS cod_outstanding,
                COALESCE(commission.commission_amount, 0) AS commission_amount,
                COALESCE(commission.earned_transaction_count, 0)::int AS earned_transaction_count,
                COALESCE(commission.reversal_transaction_count, 0)::int AS reversal_transaction_count,
                commission.rate_summary,
                COUNT(*) OVER()::int AS total_rows,
                COALESCE(SUM(${saleAmount}) OVER(), 0) AS total_sale_amount,
                COUNT(*) FILTER (WHERE COALESCE(commission.earned_transaction_count, 0) > 0) OVER()::int AS commission_order_count,
                COALESCE(SUM(COALESCE(commission.commission_amount, 0)) OVER(), 0) AS total_commission_amount
         FROM orders o
         LEFT JOIN users creator ON creator.id = o.created_by
         LEFT JOIN cod_collections cc ON cc.order_id = o.id
         LEFT JOIN LATERAL (
           SELECT SUM(oi.quantity)::int AS total_quantity,
                  string_agg(p.name || ' x' || oi.quantity::text, ', ' ORDER BY p.name) AS product_summary,
                  array_agg(oi.id ORDER BY oi.id) AS order_item_ids
           FROM order_items oi
           JOIN products p ON p.id = oi.product_id
           WHERE oi.order_id = o.id
         ) items ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(CASE
                    WHEN ct.transaction_type IN ('earned', 'manual_add') THEN ct.amount
                    WHEN ct.transaction_type IN ('reversal', 'manual_deduct') THEN -ct.amount
                    WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'credit' THEN ct.amount
                    WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'deduction' THEN -ct.amount
                    ELSE 0 END), 0) AS commission_amount,
                  COUNT(*) FILTER (WHERE ct.transaction_type = 'earned')::int AS earned_transaction_count,
                  COUNT(*) FILTER (WHERE ct.transaction_type = 'reversal')::int AS reversal_transaction_count,
                  string_agg(DISTINCT CASE WHEN ct.transaction_type = 'earned' THEN ct.rate_per_item::text END, ', ') AS rate_summary
           FROM commission_transactions ct
           WHERE ct.order_id = o.id AND ct.salesperson_id = $1
         ) commission ON TRUE
         WHERE o.created_by = $1 AND ${personalCard.condition}
         ORDER BY ${orderSort}
         LIMIT 101`
      const orderParameters: any[] = [req.user!.userId]
      if (card === 'my_sales_today') orderParameters.push(today)
      if (['my_sales_period', 'my_orders_period', 'my_completed_orders'].includes(card)) orderParameters.push(dateFrom, dateTo)
      const result = await query(orderSql, orderParameters)
      const total = Number(result.rows[0]?.total_rows || 0)
      const visibleRows = result.rows.slice(0, 100)
      const enrichedRows = card === 'my_completed_orders'
        ? await Promise.all(visibleRows.map(async row => {
            const earnedCount = Number(row.earned_transaction_count || 0)
            const reversalCount = Number(row.reversal_transaction_count || 0)
            const recordedAmount = Number(row.commission_amount || 0)
            let commissionStatus = earnedCount > 0 ? 'earned' : 'not_eligible'
            let commissionReason = earnedCount > 0 ? 'Commission has been recorded for this completed sale.' : ''
            let expectedAmount = 0
            let expectedRates: number[] = []

            if (reversalCount > 0 && recordedAmount <= 0) {
              commissionStatus = 'reversed'
              commissionReason = 'The recorded commission was reversed.'
            } else if (earnedCount === 0) {
              const evaluations = await Promise.all((row.order_item_ids || []).map(async (orderItemId: string) => {
                try {
                  return await evaluateOrderItemFromRecords(row.order_id, orderItemId)
                } catch (error) {
                  console.error('Dashboard commission eligibility error:', error)
                  return { eligible: false, reason: 'Commission eligibility could not be evaluated' }
                }
              }))
              const expected = evaluations.filter(evaluation => evaluation.eligible)
              if (expected.length > 0) {
                commissionStatus = 'expected'
                commissionReason = 'Eligible commission has not yet been recorded.'
                expectedAmount = expected.reduce((sum, evaluation) => sum + Number(evaluation.amount || 0), 0)
                expectedRates = [...new Set(expected.map(evaluation => Number(evaluation.rate || 0)).filter(rate => rate > 0))]
              } else {
                const reasons = [...new Set(evaluations.map(evaluation => evaluation.reason).filter(Boolean))]
                commissionReason = reasons.join('; ') || 'No commission-eligible items were found.'
              }
            } else if (reversalCount > 0) {
              commissionReason = 'Commission is earned with a partial reversal applied.'
            }

            return {
              ...row,
              commission_amount: earnedCount > 0 ? recordedAmount : expectedAmount,
              rate_summary: row.rate_summary || expectedRates.map(rate => rate.toFixed(2)).join(', '),
              commission_status: commissionStatus,
              commission_reason: commissionReason
            }
          }))
        : visibleRows.map(row => ({
            ...row,
            commission_status: Number(row.earned_transaction_count || 0) > 0 ? 'earned' : 'not_recorded',
            commission_reason: Number(row.earned_transaction_count || 0) > 0 ? 'Commission has been recorded.' : 'No commission is recorded for this order.'
          }))
      const firstRow = result.rows[0]
      return res.json({
        kind: 'orders', card, title: personalCard.title,
        dateFrom: card === 'my_sales_today' ? today : dateFrom,
        dateTo: card === 'my_sales_today' ? today : dateTo,
        periodLabel: ['my_open_orders', 'my_speedaf_pending'].includes(card) ? 'All dates' : null,
        summary: card === 'my_completed_orders' ? {
          completedOrders: total,
          commissionEarningOrders: Number(firstRow?.commission_order_count || 0),
          totalCompletedSales: Number(firstRow?.total_sale_amount || 0),
          recordedCommission: Number(firstRow?.total_commission_amount || 0)
        } : undefined,
        total, truncated: total > 100, rows: enrichedRows
      })
    }

    const ownPrefix = 'my_commission_'
    const companyPrefix = 'company_commission_'
    const isOwnCommission = card.startsWith(ownPrefix)
    const isCompanyCommission = card.startsWith(companyPrefix)
    if (!isOwnCommission && !isCompanyCommission) {
      return res.status(400).json({ error: { message: 'Unknown dashboard card' } })
    }
    const commissionCard = card.slice(isOwnCommission ? ownPrefix.length : companyPrefix.length)
    if (!commissionCardTitles[commissionCard]) {
      return res.status(400).json({ error: { message: 'Unknown commission dashboard card' } })
    }
    if (isOwnCommission && !ownCommissionPermissions.some(allowed)) {
      return res.status(403).json({ error: { message: 'Permission required to view own commission details' } })
    }
    if (isCompanyCommission && !allowed('commission.view')) {
      return res.status(403).json({ error: { message: 'Permission required: commission.view' } })
    }

    const periodFrom = isOwnCommission ? firstDayOfMonth(today) : dateFrom
    const periodTo = isOwnCommission ? nextMonthStart(periodFrom) : dateTo
    const params: any[] = []
    const conditions: string[] = []
    if (isOwnCommission) {
      params.push(req.user!.userId)
      conditions.push(`ct.salesperson_id = $${params.length}`)
      params.push(periodFrom, periodTo)
      conditions.push(`ct.commission_month >= $${params.length - 1}::date AND ct.commission_month < $${params.length}::date`)
    } else {
      params.push(periodFrom, periodTo)
      conditions.push(`ct.qualification_date >= $1::date AND ct.qualification_date <= $2::date`)
    }

    if (commissionCard === 'paid') {
      const paymentParams: any[] = isOwnCommission
        ? [req.user!.userId, periodFrom, periodTo]
        : [periodFrom, periodTo]
      const paymentConditions = isOwnCommission
        ? `cp.salesperson_id = $1 AND cp.paid_at::date >= $2::date AND cp.paid_at::date < $3::date`
        : `cp.paid_at::date >= $1::date AND cp.paid_at::date <= $2::date`
      const result = await query(
        `SELECT cp.id AS payment_id, ct.id AS transaction_id, ct.order_id,
                COALESCE(o.order_number, 'Commission adjustment') AS order_number,
                o.sale_date, ${physicalDeliveryTimestampSql('o')} AS delivery_date,
                ${commissionCompletionTimestampSql('o')} AS completion_date,
                ct.qualified_at AS earned_date,
                COALESCE(p.name, 'Commission adjustment') AS product_name,
                COALESCE(ct.eligible_quantity, 0) AS eligible_quantity,
                COALESCE(ct.rate_per_item, 0) AS rate_per_item,
                COALESCE(ct.amount, cp.total_amount, cp.paid_amount) AS amount,
                COALESCE(ct.amount, cp.total_amount, cp.paid_amount) AS signed_amount,
                COALESCE(ct.transaction_type, 'settlement') AS transaction_type,
                'settled' AS transaction_status,
                ct.policy_date, ct.qualification_date, ct.commission_month,
                cp.notes AS reason, sp.full_name AS salesperson_name,
                cp.paid_amount, cp.paid_at AS last_paid_at,
                CONCAT(COALESCE(cp.payment_method::text, 'payment'), ': ', COALESCE(NULLIF(cp.reference, ''), 'no reference')) AS payment_references,
                0 AS reversed_amount, 0 AS outstanding_amount,
                COUNT(*) OVER()::int AS total_rows
         FROM commission_payments cp
         JOIN users sp ON sp.id = cp.salesperson_id
         LEFT JOIN commission_transactions ct ON ct.id = cp.commission_transaction_id
         LEFT JOIN orders o ON o.id = ct.order_id
         LEFT JOIN products p ON p.id = ct.product_id
         WHERE cp.status <> 'voided' AND ${paymentConditions}
         ORDER BY cp.paid_at DESC, cp.created_at DESC
         LIMIT 101`,
        paymentParams
      )
      const total = Number(result.rows[0]?.total_rows || 0)
      return res.json({
        kind: 'commissions', card,
        title: `${isOwnCommission ? 'My' : 'Company'} commission settlements by payment date`,
        dateFrom: periodFrom,
        dateTo: isOwnCommission ? today : periodTo,
        total, truncated: total > 100, rows: result.rows.slice(0, 100)
      })
    }

    if (commissionCard === 'salespeople') {
      if (!isCompanyCommission) return res.status(400).json({ error: { message: 'Salespeople is a company commission view' } })
      const result = await query(
        `SELECT u.id AS salesperson_id, u.full_name, u.email,
                COALESCE(SUM(CASE WHEN ct.transaction_type = 'earned' THEN ct.amount ELSE 0 END), 0) AS recorded,
                COALESCE(SUM(CASE WHEN ct.transaction_type = 'reversal' THEN ct.amount ELSE 0 END), 0) AS reversals,
                COALESCE(SUM(CASE
                  WHEN ct.transaction_type IN ('earned', 'manual_add') THEN ct.amount
                  WHEN ct.transaction_type IN ('reversal', 'manual_deduct') THEN -ct.amount
                  WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'credit' THEN ct.amount
                  WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'deduction' THEN -ct.amount
                  ELSE 0 END), 0) AS balance,
                COALESCE(SUM(payments.paid_amount), 0) AS paid,
                COUNT(DISTINCT ct.order_id)::int AS orders,
                COUNT(*) OVER()::int AS total_rows
         FROM commission_transactions ct
         JOIN users u ON u.id = ct.salesperson_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(cp.paid_amount), 0) AS paid_amount
           FROM commission_payments cp WHERE cp.commission_transaction_id = ct.id AND cp.status <> 'voided'
         ) payments ON TRUE
         WHERE ${conditions.join(' AND ')}
         GROUP BY u.id, u.full_name, u.email
         ORDER BY balance DESC, u.full_name ASC
         LIMIT 101`,
        params
      )
      const total = Number(result.rows[0]?.total_rows || 0)
      return res.json({ kind: 'salespeople', card, title: commissionCardTitles.salespeople, dateFrom: periodFrom, dateTo, total, truncated: total > 100, rows: result.rows.slice(0, 100) })
    }

    if (commissionCard === 'recorded') conditions.push("ct.transaction_type = 'earned'")
    if (commissionCard === 'reversals') conditions.push("ct.transaction_type = 'reversal'")
    if (commissionCard === 'pending') conditions.push("ct.transaction_status = 'pending'")
    if (commissionCard === 'approved') conditions.push(`ct.transaction_status = 'approved'
      AND ct.transaction_type IN ('earned', 'manual_add', 'carry_forward')
      AND (ct.transaction_type <> 'carry_forward' OR ct.carry_forward_direction = 'credit')
      AND GREATEST(ct.amount - COALESCE(payments.paid_amount, 0) - COALESCE(reversals.reversed_amount, 0), 0) > 0`)
    if (commissionCard === 'outstanding') {
      conditions.push(`ct.transaction_type IN ('earned', 'manual_add', 'carry_forward')
        AND (ct.transaction_type <> 'carry_forward' OR ct.carry_forward_direction = 'credit')
        AND GREATEST(ct.amount - COALESCE(payments.paid_amount, 0) - COALESCE(reversals.reversed_amount, 0), 0) > 0`)
    }
    if (commissionCard === 'recovery') {
      conditions.push(`ct.transaction_type IN ('reversal', 'manual_deduct')
        OR (ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'deduction')`)
    }

    const result = await query(
      `SELECT ct.id AS transaction_id, ct.order_id, COALESCE(o.order_number, 'Adjustment') AS order_number,
              o.sale_date, ${physicalDeliveryTimestampSql('o')} AS delivery_date,
              ${commissionCompletionTimestampSql('o')} AS completion_date,
              ct.qualified_at AS earned_date,
              COALESCE(p.name, 'Commission adjustment') AS product_name,
              ct.eligible_quantity, ct.rate_per_item, ct.amount,
              CASE
                WHEN ct.transaction_type IN ('earned', 'manual_add') THEN ct.amount
                WHEN ct.transaction_type IN ('reversal', 'manual_deduct') THEN -ct.amount
                WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'credit' THEN ct.amount
                WHEN ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'deduction' THEN -ct.amount
                ELSE 0 END AS signed_amount,
              ct.transaction_type, ct.carry_forward_direction, ct.transaction_status,
              ct.policy_date, ct.qualification_date, ct.commission_month, ct.reason,
              sp.full_name AS salesperson_name,
              COALESCE(payments.paid_amount, 0) AS paid_amount,
              payments.last_paid_at, payments.payment_references,
              COALESCE(reversals.reversed_amount, 0) AS reversed_amount,
              GREATEST(CASE
                WHEN ct.transaction_type IN ('earned', 'manual_add')
                  OR (ct.transaction_type = 'carry_forward' AND ct.carry_forward_direction = 'credit')
                THEN ct.amount - COALESCE(payments.paid_amount, 0) - COALESCE(reversals.reversed_amount, 0)
                ELSE 0 END, 0) AS outstanding_amount,
              COUNT(*) OVER()::int AS total_rows
       FROM commission_transactions ct
       JOIN users sp ON sp.id = ct.salesperson_id
       LEFT JOIN orders o ON o.id = ct.order_id
       LEFT JOIN products p ON p.id = ct.product_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(cp.paid_amount), 0) AS paid_amount,
                MAX(cp.paid_at) AS last_paid_at,
                string_agg(CONCAT(COALESCE(cp.payment_method::text, 'payment'), ': ', COALESCE(NULLIF(cp.reference, ''), 'no reference')), '; ' ORDER BY cp.paid_at DESC) AS payment_references
         FROM commission_payments cp WHERE cp.commission_transaction_id = ct.id AND cp.status <> 'voided'
       ) payments ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(reversal.amount), 0) AS reversed_amount
         FROM commission_transactions reversal
         WHERE reversal.original_transaction_id = ct.id AND reversal.transaction_type = 'reversal'
       ) reversals ON TRUE
       WHERE ${conditions.map(condition => `(${condition})`).join(' AND ')}
       ORDER BY ct.qualified_at DESC, ct.created_at DESC
       LIMIT 101`,
      params
    )
    const total = Number(result.rows[0]?.total_rows || 0)
    return res.json({
      kind: 'commissions', card,
      title: `${isOwnCommission ? 'My ' : 'Company '}${commissionCardTitles[commissionCard].toLowerCase()}`,
      dateFrom: periodFrom,
      dateTo: isOwnCommission ? today : periodTo,
      total, truncated: total > 100, rows: result.rows.slice(0, 100)
    })
  } catch (err) {
    console.error('Dashboard drill-down error:', err)
    res.status(500).json({ error: { message: 'Unable to load dashboard details' } })
  }
})

export { router as dashboardRoutes }
