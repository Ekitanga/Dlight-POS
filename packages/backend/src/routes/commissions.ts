import { Router } from 'express'
import { query } from '../db/index.js'
import { authMiddleware, getUserPermissions, requireAnyPermission, requirePermission } from '../middleware/auth.js'
import { logAudit } from '../utils/audit.js'
import {
  getProgrammeHistory,
  getProgrammeStateAsOf,
  updateProgrammeStatus,
  setRate,
  setEligibility,
  getSalespersonCommissionSummary,
  getSalespersonDailyCommission,
  getSalespersonMonthlyCommissionHistory,
  getSalespersonCommissionTransactions,
  getManagementCommissionTransactions,
  getPotentialCommission,
  getManagementCommissionSummary,
  getManagementCommissionBySalesperson,
  getManagementCommissionSettlements,
  approveCommission,
  approveCommissionBulk,
  revokeCommissionApproval,
  payCommission,
  payCommissionBulk,
  voidCommissionSettlement,
  manualAdjustment,
  evaluateOrdersForDateRange,
  closeCommissionPeriod,
  getCommissionPeriodClosures,
  getCommissionPeriodReadiness,
  reopenCommissionPeriod
} from '../services/commission.js'

const router = Router()

function nairobiToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date())
}

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function isIsoMonth(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

router.use(authMiddleware)

// Commission operators need their own narrowly scoped selector data. Requiring
// products.view or users.view here would make commission.manage unusable and
// leaks unrelated modules into a deliberately granular permission model.
router.get('/lookups', requireAnyPermission([['commission', 'manage'], ['commission', 'adjust'], ['commission', 'view'], ['commission', 'approve'], ['commission', 'pay']]), async (req, res) => {
  try {
    const permissions = new Set(await getUserPermissions(req.user!.userId, req.user!.role))
    const canManage = permissions.has('commission.manage')
    const [salespeopleResult, productsResult, categoriesResult] = await Promise.all([
      query(`SELECT id, full_name, email FROM users
             WHERE is_active = TRUE AND commission_eligible = TRUE AND role NOT IN ('admin', 'owner')
             ORDER BY full_name ASC`),
      canManage
        ? query(`SELECT id, name, sku, category_id FROM products WHERE is_active = TRUE AND deleted_at IS NULL ORDER BY name ASC`)
        : Promise.resolve({ rows: [] }),
      canManage
        ? query(`SELECT id, name FROM categories ORDER BY name ASC`)
        : Promise.resolve({ rows: [] })
    ])
    res.json({ salespeople: salespeopleResult.rows, products: productsResult.rows, categories: categoriesResult.rows })
  } catch {
    res.status(500).json({ error: { message: 'Unable to load commission lookup data' } })
  }
})

router.get('/programme', requirePermission('commission', 'manage'), async (req, res) => {
  try {
    const history = await getProgrammeHistory()
    const current = await getProgrammeStateAsOf(new Date().toISOString())
    res.json({ current, active: current?.status === 'active' ? current : null, history })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/status', requireAnyPermission([
  ['commission', 'own_view'], ['commission', 'own_daily'], ['commission', 'own_monthly'],
  ['commission', 'own_history'], ['commission', 'own_transactions'], ['commission', 'own_potential'],
  ['commission', 'view'], ['commission', 'manage'], ['commission', 'approve'], ['commission', 'pay'],
  ['commission', 'adjust'], ['commission', 'reconcile'], ['commission', 'close']
]), async (_req, res) => {
  try {
    const current = await getProgrammeStateAsOf(new Date().toISOString())
    const permissions = new Set(await getUserPermissions(_req.user!.userId, _req.user!.role))
    const canManage = permissions.has('commission.manage')
    const rateResult = current && canManage
      ? await query(
          `SELECT rate_per_item, effective_from
           FROM commission_rates
           WHERE programme_id = $1 AND scope_type = 'global'
             AND effective_from <= (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')
             AND (effective_to IS NULL OR effective_to >= (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi'))
           ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
          [current.id]
        )
      : { rows: [] as any[] }
    const settingsResult = await query('SELECT commission_module_enabled FROM settings ORDER BY id DESC LIMIT 1')
    const moduleEnabled = settingsResult.rows[0]?.commission_module_enabled !== false
    res.json({
      configured: Boolean(current),
      status: current?.status || 'not_configured',
      effectiveFrom: current?.effective_from || null,
      reason: canManage ? current?.reason || null : null,
      currentRate: rateResult.rows[0] || null,
      moduleEnabled
    })
  } catch (error) {
    const statusCode = (error as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.post('/programme', requirePermission('commission', 'manage'), async (req, res) => {
  try {
    const { status, effective_from, effective_to, reason } = req.body
    const result = await updateProgrammeStatus('', status, effective_from, effective_to, reason, req.user?.userId || null, true)
    res.status(201).json(result)
  } catch (error) {
    const statusCode = (error as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.get('/rates', requirePermission('commission', 'manage'), async (req, res) => {
  try {
    const programme = await getProgrammeStateAsOf(new Date().toISOString())
    if (!programme) {
      return res.json({ rates: [], programmeId: null })
    }
    const result = await query(
      `SELECT id, programme_id, rate_per_item, effective_from, effective_to, scope_type, scope_id, scope_name, created_by, created_at
       FROM commission_rates WHERE programme_id = $1 ORDER BY effective_from DESC, created_at DESC`,
      [programme.id]
    )
    res.json({ rates: result.rows, programmeId: programme.id })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/rates', requirePermission('commission', 'manage'), async (req, res) => {
  try {
    const { rate_per_item, scope_type, scope_id, scope_name, effective_from, effective_to } = req.body
    const programme = await getProgrammeStateAsOf(new Date().toISOString())
    if (!programme) {
      return res.status(400).json({ error: { message: 'Configure the commission programme first' } })
    }
    const numericRate = Number(rate_per_item)
    if (!Number.isFinite(numericRate) || numericRate <= 0) {
      return res.status(400).json({ error: { message: 'Rate must be greater than zero' } })
    }
    if (!['global', 'category', 'product', 'salesperson'].includes(scope_type || 'global')) {
      return res.status(400).json({ error: { message: 'Invalid rate scope' } })
    }
    if ((scope_type || 'global') !== 'global' && !scope_id) {
      return res.status(400).json({ error: { message: 'Select a category, product, or salesperson for this rate' } })
    }
    const result = await setRate(programme.id, numericRate, scope_type || 'global', scope_id || null, scope_name || null, effective_from || new Date().toISOString(), effective_to || null, req.user?.userId || null, true)
    res.status(201).json(result)
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.get('/eligibility', requirePermission('commission', 'manage'), async (req, res) => {
  try {
    const programme = await getProgrammeStateAsOf(new Date().toISOString())
    if (!programme) {
      return res.json({ eligibility: [], programmeId: null })
    }
    const result = await query(
      `SELECT id, programme_id, scope_type, scope_id, scope_name, is_eligible, effective_from, effective_to, created_by, created_at
       FROM commission_eligibility WHERE programme_id = $1 ORDER BY effective_from DESC, created_at DESC`,
      [programme.id]
    )
    res.json({ eligibility: result.rows, programmeId: programme.id })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/eligibility', requirePermission('commission', 'manage'), async (req, res) => {
  try {
    const { scope_type, scope_id, scope_name, is_eligible, effective_from, effective_to } = req.body
    const programme = await getProgrammeStateAsOf(new Date().toISOString())
    if (!programme) {
      return res.status(400).json({ error: { message: 'Configure the commission programme first' } })
    }
    if (!['category', 'product'].includes(scope_type) || !scope_id || !scope_name) {
      return res.status(400).json({ error: { message: 'Select a valid product or category' } })
    }
    if (typeof is_eligible !== 'boolean') {
      return res.status(400).json({ error: { message: 'is_eligible must be true or false' } })
    }
    const result = await setEligibility(programme.id, scope_type, scope_id, scope_name, is_eligible, effective_from || new Date().toISOString(), effective_to || null, req.user?.userId || null, true)
    res.status(201).json(result)
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.put('/eligibility/:id', requirePermission('commission', 'manage'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM commission_eligibility WHERE id = $1', [req.params.id])
    if (!existing.rows.length) return res.status(404).json({ error: { message: 'Eligibility rule not found' } })
    const prior = existing.rows[0]
    const { is_eligible, effective_from, effective_to } = req.body
    if (typeof is_eligible !== 'boolean' || !effective_from) {
      return res.status(400).json({ error: { message: 'is_eligible and effective_from are required' } })
    }
    const replacement = await setEligibility(
      prior.programme_id,
      prior.scope_type,
      prior.scope_id,
      prior.scope_name,
      is_eligible,
      effective_from,
      effective_to || null,
      req.user?.userId || null,
      true,
      req.params.id
    )
    await logAudit({
      userId: req.user?.userId || null,
      action: 'commission_eligibility_replaced',
      entityType: 'commission_eligibility',
      entityId: req.params.id,
      oldValues: { is_eligible: prior.is_eligible, effective_from: prior.effective_from, effective_to: prior.effective_to },
      newValues: { replacement_rule_id: replacement.id, is_eligible, effective_from, effective_to: effective_to || null }
    })
    res.json(replacement)
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.delete('/eligibility/:id', requirePermission('commission', 'manage'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM commission_eligibility WHERE id = $1', [req.params.id])
    if (!existing.rows.length) return res.status(404).json({ error: { message: 'Eligibility rule not found' } })
    const ended = await query(
      `UPDATE commission_eligibility
       SET effective_to = COALESCE(effective_to, CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    )
    await logAudit({
      userId: req.user?.userId || null,
      action: 'commission_eligibility_ended',
      entityType: 'commission_eligibility',
      entityId: req.params.id,
      oldValues: { effective_to: existing.rows[0].effective_to },
      newValues: { effective_to: ended.rows[0].effective_to }
    })
    res.status(204).send()
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.get('/own/summary', requireAnyPermission([['commission', 'own_view'], ['commission', 'own_monthly']]), async (req, res) => {
  try {
    const today = nairobiToday()
    const dateFrom = String(req.query.date_from || `${today.slice(0, 8)}01`)
    const dateTo = String(req.query.date_to || today)
    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || dateFrom > dateTo) {
      return res.status(400).json({ error: { message: 'Choose a valid commission date range' } })
    }
    const summary = await getSalespersonCommissionSummary(req.user!.userId, dateFrom, dateTo)
    res.json({ ...summary, dateFrom, dateTo })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/own/daily', requirePermission('commission', 'own_daily'), async (req, res) => {
  try {
    const today = nairobiToday()
    const monthStart = today.slice(0, 8) + '01'
    const daily = await getSalespersonDailyCommission(req.user!.userId, monthStart, today)
    res.json({ daily, monthStart })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/own/transactions', requirePermission('commission', 'own_transactions'), async (req, res) => {
  try {
    const page = Number(req.query.page) || 1
    const pageSize = Number(req.query.page_size) || 25
    const result = await getSalespersonCommissionTransactions(req.user!.userId, page, pageSize)
    res.json(result)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/own/potential', requirePermission('commission', 'own_potential'), async (req, res) => {
  try {
    const potential = await getPotentialCommission(req.user!.userId)
    res.json({ potential })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/summary', requirePermission('commission', 'view'), async (req, res) => {
  try {
    const { date_from, date_to } = req.query
    const today = nairobiToday()
    const dateFrom = String(date_from || `${today.slice(0, 8)}01`)
    const dateTo = String(date_to || today)
    const summary = await getManagementCommissionSummary(dateFrom, dateTo)
    res.json(summary)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/by-salesperson', requirePermission('commission', 'view'), async (req, res) => {
  try {
    const { date_from, date_to } = req.query
    const today = nairobiToday()
    const dateFrom = String(date_from || `${today.slice(0, 8)}01`)
    const dateTo = String(date_to || today)
    const data = await getManagementCommissionBySalesperson(dateFrom, dateTo)
    res.json({ salespeople: data, dateFrom, dateTo })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/settlements', requirePermission('commission', 'view'), async (req, res) => {
  try {
    const today = nairobiToday()
    const dateFrom = String(req.query.date_from || `${today.slice(0, 8)}01`)
    const dateTo = String(req.query.date_to || today)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) {
      return res.status(400).json({ error: { message: 'A valid settlement date range is required' } })
    }
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 25))
    const result = await getManagementCommissionSettlements(
      dateFrom, dateTo, page, pageSize,
      req.query.salesperson_id ? String(req.query.salesperson_id) : undefined
    )
    res.json({ ...result, dateFrom, dateTo })
  } catch (error) {
    const statusCode = (error as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Unable to load commission settlements' : (error as Error).message } })
  }
})

router.get('/own/history', requirePermission('commission', 'own_history'), async (req, res) => {
  try {
    const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24))
    const monthFrom = req.query.month_from ? String(req.query.month_from) : undefined
    const monthTo = req.query.month_to ? String(req.query.month_to) : undefined
    if ((monthFrom && !monthTo) || (!monthFrom && monthTo) || (monthFrom && monthTo && (!isIsoMonth(monthFrom) || !isIsoMonth(monthTo) || monthFrom > monthTo))) {
      return res.status(400).json({ error: { message: 'Choose a valid commission month range' } })
    }
    if (monthFrom && monthTo) {
      const [fromYear, fromMonth] = monthFrom.split('-').map(Number)
      const [toYear, toMonth] = monthTo.split('-').map(Number)
      if ((toYear - fromYear) * 12 + toMonth - fromMonth + 1 > 60) {
        return res.status(400).json({ error: { message: 'Commission history is limited to 60 months at a time' } })
      }
    }
    const history = await getSalespersonMonthlyCommissionHistory(req.user!.userId, {
      limit,
      includeEmptyMonths: req.query.include_empty === 'true',
      monthFrom,
      monthTo
    })
    res.json({ history, monthFrom: monthFrom || null, monthTo: monthTo || null })
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.get('/transactions', requireAnyPermission([['commission', 'view'], ['commission', 'approve'], ['commission', 'pay'], ['commission', 'adjust']]), async (req, res) => {
  try {
    const today = nairobiToday()
    const dateFrom = String(req.query.date_from || `${today.slice(0, 8)}01`)
    const dateTo = String(req.query.date_to || today)
    const commissionMonth = req.query.commission_month ? String(req.query.commission_month) : undefined
    if (commissionMonth && !/^\d{4}-\d{2}-01$/.test(commissionMonth)) {
      return res.status(400).json({ error: { message: 'Commission month must use YYYY-MM-01' } })
    }
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 50))
    const result = await getManagementCommissionTransactions(
      dateFrom,
      dateTo,
      page,
      pageSize,
      req.query.status ? String(req.query.status) : undefined,
      req.query.salesperson_id ? String(req.query.salesperson_id) : undefined,
      commissionMonth
    )
    res.json({ ...result, dateFrom, dateTo, commissionMonth: commissionMonth || null })
  } catch (error) {
    const statusCode = (error as any).statusCode || 500
    res.status(statusCode).json({ error: { message: statusCode === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.post('/transactions/:id/approve', requirePermission('commission', 'approve'), async (req, res) => {
  try {
    const result = await approveCommission(req.params.id, req.user?.userId || null)
    if (!result) return res.status(404).json({ error: { message: 'Transaction not found or not pending' } })
    res.json(result)
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.post('/bulk-approve', requirePermission('commission', 'approve'), async (req, res) => {
  try {
    const transactionIds = Array.isArray(req.body.transaction_ids)
      ? req.body.transaction_ids.filter((id: any) => typeof id === 'string')
      : []
    const result = await approveCommissionBulk(transactionIds, req.user?.userId || null)
    res.json(result)
  } catch (error) {
    const status = (error as any).statusCode || ((error as any).code === '55000' ? 409 : 500)
    res.status(status).json({ error: { message: status === 500 ? 'Unable to approve the selected commission transactions' : (error as Error).message } })
  }
})

router.post('/transactions/:id/pay', requirePermission('commission', 'pay'), async (req, res) => {
  try {
    const result = await payCommission(req.params.id, req.user?.userId || null, {
      amount: req.body.amount === undefined ? undefined : Number(req.body.amount),
      paymentMethod: req.body.payment_method,
      reference: req.body.reference || null,
      notes: req.body.notes || null,
      idempotencyKey: req.body.idempotency_key || req.get('Idempotency-Key') || null,
      settledAt: req.body.settled_at || null
    })
    if (!result) return res.status(404).json({ error: { message: 'Transaction not found or not approved' } })
    res.json(result)
  } catch (error) {
    const status = (error as any).statusCode || ((error as any).code === '23505' || (error as any).code === '55000' ? 409 : 500)
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.post('/bulk-pay', requirePermission('commission', 'pay'), async (req, res) => {
  try {
    const transactionIds = Array.isArray(req.body.transaction_ids) ? req.body.transaction_ids.filter((id: any) => typeof id === 'string') : []
    if (transactionIds.length === 0) {
      return res.status(400).json({ error: { message: 'Select at least one commission transaction to pay' } })
    }
    const result = await payCommissionBulk(transactionIds, req.user?.userId || null, {
      amount: req.body.amount === undefined ? undefined : Number(req.body.amount),
      paymentMethod: req.body.payment_method,
      reference: req.body.reference || null,
      notes: req.body.notes || null,
      idempotencyKey: req.body.idempotency_key || req.get('Idempotency-Key') || null,
      settledAt: req.body.settled_at || null
    })
    res.json(result)
  } catch (error) {
    const status = (error as any).statusCode || ((error as any).code === '23505' || (error as any).code === '55000' ? 409 : 500)
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.post('/transactions/:id/revoke-approval', requirePermission('commission', 'approve'), async (req, res) => {
  try {
    if (!['admin', 'owner'].includes(req.user?.role || '')) {
      return res.status(403).json({ error: { message: 'Only an administrator or owner can revoke commission approval' } })
    }
    const result = await revokeCommissionApproval(req.params.id, req.body.reason, req.user?.userId || null)
    if (!result) return res.status(404).json({ error: { message: 'Approved transaction not found or not eligible for revocation' } })
    res.json(result)
  } catch (error) {
    const status = (error as any).statusCode || ((error as any).code === '55000' ? 409 : 500)
    res.status(status).json({ error: { message: status === 500 ? 'Unable to revoke commission approval' : (error as Error).message } })
  }
})

router.post('/payments/:id/void', requirePermission('commission', 'pay'), async (req, res) => {
  try {
    if (!['admin', 'owner'].includes(req.user?.role || '')) {
      return res.status(403).json({ error: { message: 'Only an administrator or owner can void a commission settlement' } })
    }
    const result = await voidCommissionSettlement(req.params.id, req.body.reason, req.user?.userId || null)
    if (!result) return res.status(404).json({ error: { message: 'Active commission settlement not found' } })
    res.json(result)
  } catch (error) {
    const status = (error as any).statusCode || ((error as any).code === '55000' ? 409 : 500)
    res.status(status).json({ error: { message: status === 500 ? 'Unable to void commission settlement' : (error as Error).message } })
  }
})

router.post('/adjust', requirePermission('commission', 'adjust'), async (req, res) => {
  try {
    const { salesperson_id, amount, adjustment_type, reason, order_id, order_item_id, period } = req.body
    if (!salesperson_id || !amount || !adjustment_type || !reason || !period) {
      return res.status(400).json({ error: { message: 'salesperson_id, amount, adjustment_type, reason, and period are required' } })
    }
    if (!['manual_add', 'manual_deduct'].includes(adjustment_type)) {
      return res.status(400).json({ error: { message: 'adjustment_type must be manual_add or manual_deduct' } })
    }
    const result = await manualAdjustment(salesperson_id, amount, adjustment_type, reason, order_id || null, order_item_id || null, period, req.user?.userId || null)
    res.status(201).json(result)
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

// Period closure is deliberately separate from general commission management.
// It has its own permission because it freezes historical payroll records.
router.get('/periods', requirePermission('commission', 'close'), async (req, res) => {
  try {
    const closures = await getCommissionPeriodClosures(Number(req.query.limit) || 24)
    res.json({ closures })
  } catch {
    res.status(500).json({ error: { message: 'Unable to load commission closure history' } })
  }
})

router.get('/periods/readiness', requirePermission('commission', 'close'), async (req, res) => {
  try {
    const readiness = await getCommissionPeriodReadiness(String(req.query.period || ''))
    res.json(readiness)
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Unable to prepare the commission close preview' : (error as Error).message } })
  }
})

router.post('/periods/close', requirePermission('commission', 'close'), async (req, res) => {
  try {
    const period = String(req.body.period || req.body.period_start || '')
    const result = await closeCommissionPeriod(period, req.body.reason, req.user?.userId || null)
    res.status(201).json(result)
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({
      error: {
        message: status === 500 ? 'Unable to close commission period' : (error as Error).message,
        pending_transactions: (error as any).pendingTransactions || undefined
      }
    })
  }
})

router.post('/periods/reopen', requirePermission('commission', 'close'), async (req, res) => {
  try {
    if (!['admin', 'owner'].includes(req.user?.role || '')) {
      return res.status(403).json({ error: { message: 'Only an administrator or owner can undo a commission period close' } })
    }
    const result = await reopenCommissionPeriod(String(req.body.period || ''), req.body.reason, req.user?.userId || null)
    if (!result) return res.status(404).json({ error: { message: 'Closed commission period not found' } })
    res.json(result)
  } catch (error) {
    const status = (error as any).statusCode || ((error as any).code === '55000' ? 409 : 500)
    res.status(status).json({ error: { message: status === 500 ? 'Unable to undo the commission period close' : (error as Error).message } })
  }
})

router.put('/rates/:id', requirePermission('commission', 'manage'), async (req, res) => {
  try {
    const { id } = req.params
    const { rate_per_item, effective_from, effective_to } = req.body
    if (rate_per_item === undefined || rate_per_item === null || rate_per_item <= 0) {
      return res.status(400).json({ error: { message: 'Valid rate_per_item is required' } })
    }
    if (!effective_from) {
      return res.status(400).json({ error: { message: 'effective_from is required' } })
    }
    const existing = await query('SELECT * FROM commission_rates WHERE id = $1', [id])
    if (!existing.rows.length) {
      return res.status(404).json({ error: { message: 'Rate not found' } })
    }
    const prior = existing.rows[0]
    const result = await setRate(
      prior.programme_id,
      Number(rate_per_item),
      prior.scope_type,
      prior.scope_id,
      prior.scope_name,
      effective_from,
      effective_to || null,
      req.user?.userId || null,
      true,
      id
    )
    await logAudit({
      userId: req.user?.userId || null,
      action: 'commission_rate_updated',
      entityType: 'commission_rate',
      entityId: id,
      oldValues: { rate_per_item: prior.rate_per_item, effective_from: prior.effective_from, effective_to: prior.effective_to },
      newValues: { rate_per_item, effective_from, effective_to }
    })
    res.json(result)
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.delete('/rates/:id', requirePermission('commission', 'manage'), async (req, res) => {
  try {
    const { id } = req.params
    const existing = await query('SELECT * FROM commission_rates WHERE id = $1', [id])
    if (!existing.rows.length) {
      return res.status(404).json({ error: { message: 'Rate not found' } })
    }
    const ended = await query(
      `UPDATE commission_rates
       SET effective_to = COALESCE(effective_to, CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')
       WHERE id = $1 RETURNING *`,
      [id]
    )
    await logAudit({
      userId: req.user?.userId || null,
      action: 'commission_rate_ended',
      entityType: 'commission_rate',
      entityId: id,
      oldValues: { effective_to: existing.rows[0].effective_to },
      newValues: { effective_to: ended.rows[0].effective_to }
    })
    res.status(204).send()
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/retroactive', requireAnyPermission([['commission', 'manage'], ['commission', 'reconcile']]), async (req, res) => {
  try {
    const { date_from, date_to, apply, reason } = req.body
    if (!date_from || !date_to) {
      return res.status(400).json({ error: { message: 'date_from and date_to are required (YYYY-MM-DD)' } })
    }
    if (apply === true && req.user?.role !== 'admin' && req.user?.role !== 'owner') {
      const permissions = await getUserPermissions(req.user!.userId, req.user!.role)
      if (!permissions.includes('commission.reconcile')) {
        return res.status(403).json({ error: { message: 'commission.reconcile is required to apply reconciliation changes' } })
      }
    }
    const result = await evaluateOrdersForDateRange(date_from, date_to, req.user?.userId || null, apply === true, reason || null)
    res.json(result)
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

router.post('/own/retroactive', requireAnyPermission([['commission', 'own_view'], ['commission', 'own_potential'], ['commission', 'reconcile'], ['commission', 'manage']]), async (req, res) => {
  try {
    const { date_from, date_to, apply, reason } = req.body
    if (!date_from || !date_to) {
      return res.status(400).json({ error: { message: 'date_from and date_to are required (YYYY-MM-DD)' } })
    }
    if (apply === true && req.user?.role !== 'admin' && req.user?.role !== 'owner') {
      const permissions = await getUserPermissions(req.user!.userId, req.user!.role)
      if (!permissions.includes('commission.reconcile') && !permissions.includes('commission.manage')) {
        return res.status(403).json({ error: { message: 'commission.reconcile or commission.manage is required to apply reconciliation changes' } })
      }
    }
    const result = await evaluateOrdersForDateRange(date_from, date_to, req.user?.userId || null, apply === true, reason || null, req.user?.userId || null)
    res.json(result)
  } catch (error) {
    const status = (error as any).statusCode || 500
    res.status(status).json({ error: { message: status === 500 ? 'Database error' : (error as Error).message } })
  }
})

export { router as commissionRoutes }
