import { query, transaction } from '../db/index.js'
import { logAudit } from '../utils/audit.js'

function toNumber(value: unknown): number {
  const numberValue = Number(value || 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

export interface CommissionProgramme {
  id: string
  status: string
  effective_from: string
  effective_to: string | null
  reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CommissionRate {
  id: string
  programme_id: string
  rate_per_item: number
  effective_from: string
  effective_to: string | null
  scope_type: string
  scope_id: string | null
  scope_name: string | null
  created_by: string | null
  created_at: string
}

export interface CommissionEligibility {
  id: string
  programme_id: string
  scope_type: string
  scope_id: string
  scope_name: string
  is_eligible: boolean
  effective_from: string
  effective_to: string | null
  created_by: string | null
  created_at: string
}

export async function getActiveProgramme(): Promise<CommissionProgramme | null> {
  const result = await query(
    `SELECT id, status, effective_from, effective_to, reason, created_by, created_at, updated_at
     FROM commission_programmes
     WHERE status = 'active'
       AND effective_from <= NOW()
       AND (effective_to IS NULL OR effective_to > NOW())
     ORDER BY effective_from DESC
     LIMIT 1`
  )
  return result.rows[0] || null
}

export async function getProgrammeHistory() {
  const result = await query(
    `SELECT id, status, effective_from, effective_to, reason, created_by, created_at, updated_at
     FROM commission_programmes
     ORDER BY effective_from DESC`
  )
  return result.rows
}

export async function updateProgrammeStatus(
  programmeId: string,
  status: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  reason: string | null,
  userId: string | null
): Promise<CommissionProgramme> {
  const result = await query(
    `INSERT INTO commission_programmes (status, effective_from, effective_to, reason, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING id, status, effective_from, effective_to, reason, created_by, created_at, updated_at`,
    [status, effectiveFrom, effectiveTo, reason, userId]
  )
  await logAudit({
    userId,
    action: 'commission_programme_updated',
    entityType: 'commission_programme',
    entityId: programmeId || result.rows[0].id,
    newValues: { status, effective_from: effectiveFrom, effective_to: effectiveTo, reason }
  })
  return result.rows[0]
}

export async function getRateForItem(programmeId: string, productId: string, categoryId: string | null, salespersonId: string): Promise<number> {
  const result = await query(
    `SELECT rate_per_item
     FROM commission_rates
     WHERE programme_id = $1
       AND effective_from <= NOW()
       AND (effective_to IS NULL OR effective_to > NOW())
       AND (
         scope_type = 'global'
         OR (scope_type = 'product' AND scope_id = $2)
         OR (scope_type = 'category' AND scope_id = $3)
         OR (scope_type = 'salesperson' AND scope_id = $4)
       )
     ORDER BY CASE scope_type
       WHEN 'salesperson' THEN 1
       WHEN 'product' THEN 2
       WHEN 'category' THEN 3
       WHEN 'global' THEN 4
     END
     LIMIT 1`,
    [programmeId, productId, categoryId, salespersonId]
  )
  return result.rows[0] ? toNumber(result.rows[0].rate_per_item) : 0
}

export async function setRate(
  programmeId: string,
  ratePerItem: number,
  scopeType: string,
  scopeId: string | null,
  scopeName: string | null,
  effectiveFrom: string,
  effectiveTo: string | null,
  userId: string | null
): Promise<CommissionRate> {
  const result = await query(
    `INSERT INTO commission_rates (programme_id, rate_per_item, effective_from, effective_to, scope_type, scope_id, scope_name, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING *`,
    [programmeId, ratePerItem, effectiveFrom, effectiveTo, scopeType, scopeId, scopeName, userId]
  )
  await logAudit({
    userId,
    action: 'commission_rate_set',
    entityType: 'commission_rate',
    entityId: result.rows[0].id,
    newValues: { programme_id: programmeId, rate_per_item: ratePerItem, scope_type: scopeType, scope_name: scopeName, effective_from: effectiveFrom, effective_to: effectiveTo }
  })
  return result.rows[0]
}

export async function getEligibility(
  programmeId: string,
  scopeType: 'category' | 'product',
  scopeId: string
): Promise<CommissionEligibility | null> {
  const result = await query(
    `SELECT id, programme_id, scope_type, scope_id, scope_name, is_eligible, effective_from, effective_to, created_by, created_at
     FROM commission_eligibility
     WHERE programme_id = $1
       AND scope_type = $2
       AND scope_id = $3
       AND effective_from <= NOW()
       AND (effective_to IS NULL OR effective_to > NOW())
     ORDER BY effective_from DESC
     LIMIT 1`,
    [programmeId, scopeType, scopeId]
  )
  return result.rows[0] || null
}

export async function setEligibility(
  programmeId: string,
  scopeType: string,
  scopeId: string,
  scopeName: string,
  isEligible: boolean,
  effectiveFrom: string,
  effectiveTo: string | null,
  userId: string | null
): Promise<CommissionEligibility> {
  const result = await query(
    `INSERT INTO commission_eligibility (programme_id, scope_type, scope_id, scope_name, is_eligible, effective_from, effective_to, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING *`,
    [programmeId, scopeType, scopeId, scopeName, isEligible, effectiveFrom, effectiveTo, userId]
  )
  await logAudit({
    userId,
    action: 'commission_eligibility_updated',
    entityType: 'commission_eligibility',
    entityId: result.rows[0].id,
    newValues: { programme_id: programmeId, scope_type: scopeType, scope_name: scopeName, is_eligible: isEligible, effective_from: effectiveFrom, effective_to: effectiveTo }
  })
  return result.rows[0]
}

export async function evaluateOrderItem(
  orderId: string,
  orderItemId: string,
  orderStatus: string,
  deliveryType: string,
  courierPaymentType: string | null,
  paidAmount: number,
  totalAmount: number,
  productId: string,
  categoryId: string | null,
  quantity: number,
  salespersonId: string | null,
  _qualificationDate: string
): Promise<{ eligible: boolean; reason?: string }> {
  const programme = await getActiveProgramme()
  if (!programme) {
    return { eligible: false, reason: 'No active commission programme' }
  }

  if (!salespersonId) {
    return { eligible: false, reason: 'No salesperson attribution' }
  }

  if (quantity <= 0) {
    return { eligible: false, reason: 'Zero or negative quantity' }
  }

  const eligibility = await getEligibility(programme.id, 'product', productId)
  if (!eligibility) {
    const catEligibility = categoryId ? await getEligibility(programme.id, 'category', categoryId) : null
    if (!catEligibility || !catEligibility.is_eligible) {
      return { eligible: false, reason: 'Product or category not eligible' }
    }
  } else if (!eligibility.is_eligible) {
    return { eligible: false, reason: 'Product explicitly ineligible' }
  }

  const rate = await getRateForItem(programme.id, productId, categoryId, salespersonId)
  if (rate <= 0) {
    return { eligible: false, reason: 'No applicable commission rate' }
  }

  if (deliveryType === 'courier' && courierPaymentType === 'cod') {
    if (orderStatus !== 'collected_paid') {
      return { eligible: false, reason: 'Speedaf COD order not yet fully remitted and completed' }
    }
  } else if (orderStatus !== 'delivered' && orderStatus !== 'collected_paid') {
    return { eligible: false, reason: 'Order not in a completed state' }
  }

  if (paidAmount < totalAmount) {
    return { eligible: false, reason: 'Order payment not fully settled' }
  }

  const existingResult = await query(
    `SELECT id FROM commission_transactions
     WHERE order_item_id = $1 AND transaction_type = 'earned' AND transaction_status <> 'reversed'`,
    [orderItemId]
  )
  if (existingResult.rows.length > 0) {
    return { eligible: false, reason: 'Commission already earned for this order item' }
  }

  return { eligible: true }
}

export async function earnCommission(
  orderId: string,
  orderItemId: string,
  productId: string,
  categoryId: string | null,
  quantity: number,
  salespersonId: string,
  qualificationDate: string,
  createdBy: string | null
): Promise<{ transactionId: string; amount: number } | null> {
  const programme = await getActiveProgramme()
  if (!programme) return null

  const rate = await getRateForItem(programme.id, productId, categoryId, salespersonId)
  if (rate <= 0) return null

  const monthDate = qualificationDate.slice(0, 7) + '-01'

  return transaction(async (client) => {
    const existingResult = await client.query(
      `SELECT id FROM commission_transactions
       WHERE order_item_id = $1 AND transaction_type = 'earned' AND transaction_status <> 'reversed'
       FOR UPDATE`,
      [orderItemId]
    )
    if (existingResult.rows.length > 0) {
      return null
    }

    const amount = quantity * rate

    const result = await client.query(
      `INSERT INTO commission_transactions
       (programme_id, salesperson_id, order_id, order_item_id, product_id, category_id, eligible_quantity, rate_per_item, amount, transaction_type, transaction_status, qualification_date, commission_month, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'earned', 'pending', $10, $11, $12, NOW())
       RETURNING id, amount`,
      [programme.id, salespersonId, orderId, orderItemId, productId, categoryId, quantity, rate, amount, qualificationDate, monthDate, createdBy]
    )

    await logAudit({
      userId: createdBy,
      action: 'commission_earned',
      entityType: 'commission_transaction',
      entityId: result.rows[0].id,
      newValues: { order_id: orderId, order_item_id: orderItemId, salesperson_id: salespersonId, quantity, rate_per_item: rate, amount }
    })

    return { transactionId: result.rows[0].id, amount }
  })
}

export async function reverseCommission(
  originalTransactionId: string,
  orderId: string,
  orderItemId: string,
  quantity: number,
  reason: string,
  createdBy: string | null
): Promise<{ transactionId: string; amount: number } | null> {
  const originalResult = await query(
    `SELECT id, programme_id, salesperson_id, product_id, category_id, rate_per_item, amount, eligible_quantity, commission_month
     FROM commission_transactions
     WHERE id = $1 AND transaction_type = 'earned' AND transaction_status <> 'reversed'
     FOR UPDATE`,
    [originalTransactionId]
  )
  const original = originalResult.rows[0]
  if (!original) return null

  const reversalQuantity = Math.min(quantity, original.eligible_quantity)
  const rate = toNumber(original.rate_per_item)
  const reversalAmount = reversalQuantity * rate

  if (reversalAmount <= 0) return null

  return transaction(async (client) => {
    await client.query(
      `UPDATE commission_transactions SET transaction_status = 'reversed' WHERE id = $1`,
      [originalTransactionId]
    )

    const result = await client.query(
      `INSERT INTO commission_transactions
       (programme_id, salesperson_id, order_id, order_item_id, product_id, category_id, eligible_quantity, rate_per_item, amount, transaction_type, transaction_status, qualification_date, commission_month, original_transaction_id, reason, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reversal', 'pending', $10, $11, $12, $13, $14, NOW())
       RETURNING id, amount`,
      [original.programme_id, original.salesperson_id, orderId, orderItemId, original.product_id, original.category_id, reversalQuantity, rate, reversalAmount, original.qualification_date, original.commission_month, originalTransactionId, reason, createdBy]
    )

    await logAudit({
      userId: createdBy,
      action: 'commission_reversed',
      entityType: 'commission_transaction',
      entityId: result.rows[0].id,
      newValues: { original_transaction_id: originalTransactionId, order_id: orderId, order_item_id: orderItemId, reversal_quantity: reversalQuantity, amount: reversalAmount, reason }
    })

    return { transactionId: result.rows[0].id, amount: reversalAmount }
  })
}

export async function getSalespersonCommissionSummary(
  salespersonId: string,
  monthStart: string,
  monthEnd: string
) {
  const result = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN transaction_type = 'earned' THEN amount ELSE 0 END), 0) AS gross_earned,
       COALESCE(SUM(CASE WHEN transaction_type = 'reversal' THEN amount ELSE 0 END), 0) AS reversals,
       COALESCE(SUM(CASE WHEN transaction_type = 'manual_add' THEN amount ELSE 0 END), 0) AS manual_additions,
       COALESCE(SUM(CASE WHEN transaction_type = 'manual_deduct' THEN amount ELSE 0 END), 0) AS manual_deductions,
       COALESCE(SUM(CASE WHEN transaction_type = 'payment' THEN amount ELSE 0 END), 0) AS payments,
       COUNT(CASE WHEN transaction_type = 'earned' THEN 1 END) AS earned_count,
       COUNT(CASE WHEN transaction_type = 'reversal' THEN 1 END) AS reversal_count
     FROM commission_transactions
     WHERE salesperson_id = $1
       AND commission_month >= $2
       AND commission_month < $3`,
    [salespersonId, monthStart, monthEnd]
  )
  const row = result.rows[0]
  const grossEarned = toNumber(row.gross_earned)
  const reversals = toNumber(row.reversals)
  const manualAdditions = toNumber(row.manual_additions)
  const manualDeductions = toNumber(row.manual_deductions)
  const payments = toNumber(row.payments)
  return {
    grossEarned,
    reversals,
    manualAdditions,
    manualDeductions,
    netCommission: grossEarned - reversals + manualAdditions - manualDeductions,
    paidAmount: payments,
    outstandingAmount: grossEarned - reversals + manualAdditions - manualDeductions - payments,
    earnedCount: Number(row.earned_count || 0),
    reversalCount: Number(row.reversal_count || 0)
  }
}

export async function getSalespersonDailyCommission(
  salespersonId: string,
  dateFrom: string,
  dateTo: string
) {
  const result = await query(
    `SELECT
       qualification_date,
       COUNT(CASE WHEN transaction_type = 'earned' THEN 1 END) AS eligible_items,
       COALESCE(SUM(CASE WHEN transaction_type = 'earned' THEN amount ELSE 0 END), 0) AS gross_commission,
       COALESCE(SUM(CASE WHEN transaction_type = 'reversal' THEN amount ELSE 0 END), 0) AS reversals,
       COALESCE(SUM(CASE WHEN transaction_type = 'manual_add' THEN amount ELSE 0 END), 0) AS manual_additions,
       COALESCE(SUM(CASE WHEN transaction_type = 'manual_deduct' THEN amount ELSE 0 END), 0) AS manual_deductions,
       COALESCE(SUM(CASE WHEN transaction_type IN ('earned','reversal','manual_add','manual_deduct') THEN amount ELSE 0 END), 0) AS net_commission
     FROM commission_transactions
     WHERE salesperson_id = $1
       AND qualification_date >= $2
       AND qualification_date <= $3
     GROUP BY qualification_date
     ORDER BY qualification_date DESC`,
    [salespersonId, dateFrom, dateTo]
  )
  return result.rows.map(row => ({
    date: row.qualification_date,
    eligibleItems: Number(row.eligible_items || 0),
    grossCommission: toNumber(row.gross_commission),
    reversals: toNumber(row.reversals),
    manualAdditions: toNumber(row.manual_additions),
    manualDeductions: toNumber(row.manual_deductions),
    netCommission: toNumber(row.net_commission)
  }))
}

export async function getSalespersonCommissionTransactions(
  salespersonId: string,
  page: number,
  pageSize: number
) {
  const offset = (page - 1) * pageSize
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM commission_transactions ct
     JOIN orders o ON o.id = ct.order_id
     JOIN products p ON p.id = ct.product_id
     LEFT JOIN users u ON u.id = ct.approved_by
     WHERE ct.salesperson_id = $1`,
    [salespersonId]
  )
  const result = await query(
    `SELECT ct.id, ct.order_id, o.order_number, ct.product_id, p.name AS product_name, ct.eligible_quantity,
            ct.rate_per_item, ct.amount, ct.transaction_type, ct.transaction_status, ct.qualification_date,
            ct.commission_month, ct.reason, u.full_name AS approved_by_name, ct.approved_at, ct.created_at
     FROM commission_transactions ct
     JOIN orders o ON o.id = ct.order_id
     JOIN products p ON p.id = ct.product_id
     LEFT JOIN users u ON u.id = ct.approved_by
     WHERE ct.salesperson_id = $1
     ORDER BY ct.created_at DESC
     LIMIT $2 OFFSET $3`,
    [salespersonId, pageSize, offset]
  )
  return {
    data: result.rows,
    pagination: {
      page,
      pageSize,
      total: countResult.rows[0]?.total || 0,
      totalPages: Math.ceil((countResult.rows[0]?.total || 0) / pageSize)
    }
  }
}

export async function getPotentialCommission(salespersonId: string) {
  const result = await query(
    `SELECT o.id AS order_id, o.order_number, oi.id AS order_item_id, p.name AS product_name,
            oi.quantity, o.status AS order_status, o.delivery_type, o.courier_payment_type,
            o.paid_amount, o.total_amount, c.name AS category_name
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     JOIN products p ON p.id = oi.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE o.created_by = $1
       AND o.status IN ('delivered', 'collected_paid')
       AND o.payment_status = 'paid'
       AND NOT EXISTS (
         SELECT 1 FROM commission_transactions ct
         WHERE ct.order_item_id = oi.id AND ct.transaction_type = 'earned' AND ct.transaction_status <> 'reversed'
       )
     ORDER BY o.created_at DESC`,
    [salespersonId]
  )
  return result.rows.map(row => ({
    orderId: row.order_id,
    orderNumber: row.order_number,
    orderItemId: row.order_item_id,
    productName: row.product_name,
    quantity: row.quantity,
    orderStatus: row.order_status,
    deliveryType: row.delivery_type,
    courierPaymentType: row.courier_payment_type,
    paidAmount: toNumber(row.paid_amount),
    totalAmount: toNumber(row.total_amount),
    categoryName: row.category_name
  }))
}

export async function getManagementCommissionSummary(dateFrom: string, dateTo: string) {
  const result = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'earned' THEN ct.amount ELSE 0 END), 0) AS total_earned,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'reversal' THEN ct.amount ELSE 0 END), 0) AS total_reversals,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'manual_add' THEN ct.amount ELSE 0 END), 0) AS total_manual_additions,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'manual_deduct' THEN ct.amount ELSE 0 END), 0) AS total_manual_deductions,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'payment' THEN ct.amount ELSE 0 END), 0) AS total_payments,
       COUNT(DISTINCT ct.salesperson_id) AS salesperson_count,
       COUNT(DISTINCT ct.order_id) AS order_count,
       COUNT(DISTINCT CASE WHEN ct.transaction_type = 'earned' THEN ct.order_item_id END) AS item_count
     FROM commission_transactions ct
     WHERE ct.qualification_date >= $1 AND ct.qualification_date <= $2`,
    [dateFrom, dateTo]
  )
  const row = result.rows[0]
  return {
    totalEarned: toNumber(row.total_earned),
    totalReversals: toNumber(row.total_reversals),
    totalManualAdditions: toNumber(row.total_manual_additions),
    totalManualDeductions: toNumber(row.total_manual_deductions),
    totalPayments: toNumber(row.total_payments),
    netCommission: toNumber(row.total_earned) - toNumber(row.total_reversals) + toNumber(row.total_manual_additions) - toNumber(row.total_manual_deductions),
    salespersonCount: Number(row.salesperson_count || 0),
    orderCount: Number(row.order_count || 0),
    itemCount: Number(row.item_count || 0)
  }
}

export async function getManagementCommissionBySalesperson(dateFrom: string, dateTo: string) {
  const result = await query(
    `SELECT u.id AS salesperson_id, u.full_name, u.email,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'earned' THEN ct.amount ELSE 0 END), 0) AS gross_earned,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'reversal' THEN ct.amount ELSE 0 END), 0) AS reversals,
       COALESCE(SUM(CASE WHEN ct.transaction_type IN ('earned','reversal','manual_add','manual_deduct') THEN ct.amount ELSE 0 END), 0) AS net_commission,
       COALESCE(SUM(CASE WHEN ct.transaction_type = 'payment' THEN ct.amount ELSE 0 END), 0) AS paid
     FROM commission_transactions ct
     JOIN users u ON u.id = ct.salesperson_id
     WHERE ct.qualification_date >= $1 AND ct.qualification_date <= $2
     GROUP BY u.id, u.full_name, u.email
     ORDER BY net_commission DESC`,
    [dateFrom, dateTo]
  )
  return result.rows.map(row => ({
    salespersonId: row.salesperson_id,
    fullName: row.full_name,
    email: row.email,
    grossEarned: toNumber(row.gross_earned),
    reversals: toNumber(row.reversals),
    netCommission: toNumber(row.net_commission),
    paid: toNumber(row.paid)
  }))
}

export async function approveCommission(transactionId: string, userId: string | null) {
  const result = await query(
    `UPDATE commission_transactions SET transaction_status = 'approved', approved_by = $1, approved_at = NOW()
     WHERE id = $2 AND transaction_status = 'pending'
     RETURNING *`,
    [userId, transactionId]
  )
  if (result.rows.length > 0) {
    await logAudit({
      userId,
      action: 'commission_approved',
      entityType: 'commission_transaction',
      entityId: transactionId,
      newValues: { transaction_status: 'approved' }
    })
  }
  return result.rows[0] || null
}

export async function payCommission(transactionId: string, userId: string | null) {
  const result = await query(
    `UPDATE commission_transactions SET transaction_status = 'paid', approved_by = COALESCE(approved_by, $1), approved_at = COALESCE(approved_at, NOW())
     WHERE id = $2 AND transaction_status = 'approved'
     RETURNING *`,
    [userId, transactionId]
  )
  if (result.rows.length > 0) {
    await logAudit({
      userId,
      action: 'commission_paid',
      entityType: 'commission_transaction',
      entityId: transactionId,
      newValues: { transaction_status: 'paid' }
    })
  }
  return result.rows[0] || null
}

export async function manualAdjustment(
  salespersonId: string,
  amount: number,
  adjustmentType: 'manual_add' | 'manual_deduct',
  reason: string,
  orderId: string | null,
  orderItemId: string | null,
  userId: string | null
) {
  const monthDate = new Date().toISOString().slice(0, 7) + '-01'
  const result = await query(
    `INSERT INTO commission_transactions
     (programme_id, salesperson_id, order_id, order_item_id, amount, transaction_type, transaction_status, qualification_date, commission_month, reason, created_by, created_at)
     VALUES (
       (SELECT id FROM commission_programmes WHERE status = 'active' AND effective_from <= NOW() AND (effective_to IS NULL OR effective_to > NOW()) ORDER BY effective_from DESC LIMIT 1),
       $1, $2, $3, $4, $5, 'pending', CURRENT_DATE, $6, $7, $8, NOW()
     )
     RETURNING id, amount`,
    [salespersonId, orderId, orderItemId, amount, adjustmentType, monthDate, reason, userId]
  )
  await logAudit({
    userId,
    action: 'commission_adjusted',
    entityType: 'commission_transaction',
    entityId: result.rows[0].id,
    newValues: { salesperson_id: salespersonId, amount, adjustment_type: adjustmentType, reason, order_id: orderId, order_item_id: orderItemId }
  })
  return result.rows[0]
}
