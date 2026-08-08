import { Router } from 'express'
import { query } from '../db/index.js'
import { authMiddleware, requireModulePermission, requireAdmin } from '../middleware/auth.js'
import { logAudit } from '../utils/audit.js'
import {
  getProgrammeHistory,
  updateProgrammeStatus,
  setRate,
  setEligibility,
  getSalespersonCommissionSummary,
  getSalespersonDailyCommission,
  getSalespersonCommissionTransactions,
  getPotentialCommission,
  getManagementCommissionSummary,
  getManagementCommissionBySalesperson,
  approveCommission,
  payCommission,
  manualAdjustment,
  evaluateOrdersForDateRange
} from '../services/commission.js'

const router = Router()

router.use(authMiddleware)

router.get('/programme', requireModulePermission('commission'), async (req, res) => {
  try {
    const history = await getProgrammeHistory()
    res.json({ active: history[0] || null, history })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/programme', requireAdmin, requireModulePermission('commission'), async (req, res) => {
  try {
    const { status, effective_from, effective_to, reason } = req.body
    const result = await updateProgrammeStatus('', status, effective_from, effective_to, reason, req.user?.userId || null)
    res.status(201).json(result)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/rates', requireModulePermission('commission'), async (req, res) => {
  try {
    const programmeResult = await query(`SELECT id FROM commission_programmes WHERE status = 'active' ORDER BY effective_from DESC LIMIT 1`)
    const programmeId = programmeResult.rows[0]?.id
    if (!programmeId) {
      return res.json({ rates: [], programmeId: null })
    }
    const result = await query(
      `SELECT id, programme_id, rate_per_item, effective_from, effective_to, scope_type, scope_id, scope_name, created_by, created_at
       FROM commission_rates WHERE programme_id = $1 ORDER BY effective_from DESC`,
      [programmeId]
    )
    res.json({ rates: result.rows, programmeId })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/rates', requireAdmin, requireModulePermission('commission'), async (req, res) => {
  try {
    const { rate_per_item, scope_type, scope_id, scope_name, effective_from, effective_to } = req.body
    const programmeResult = await query(`SELECT id FROM commission_programmes WHERE status = 'active' ORDER BY effective_from DESC LIMIT 1`)
    const programmeId = programmeResult.rows[0]?.id
    if (!programmeId) {
      return res.status(400).json({ error: { message: 'No active commission programme' } })
    }
    const result = await setRate(programmeId, rate_per_item, scope_type || 'global', scope_id || null, scope_name || null, effective_from || new Date().toISOString(), effective_to || null, req.user?.userId || null)
    res.status(201).json(result)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/eligibility', requireModulePermission('commission'), async (req, res) => {
  try {
    const programmeResult = await query(`SELECT id FROM commission_programmes WHERE status = 'active' ORDER BY effective_from DESC LIMIT 1`)
    const programmeId = programmeResult.rows[0]?.id
    if (!programmeId) {
      return res.json({ eligibility: [], programmeId: null })
    }
    const result = await query(
      `SELECT id, programme_id, scope_type, scope_id, scope_name, is_eligible, effective_from, effective_to, created_by, created_at
       FROM commission_eligibility WHERE programme_id = $1 ORDER BY effective_from DESC`,
      [programmeId]
    )
    res.json({ eligibility: result.rows, programmeId })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/eligibility', requireAdmin, requireModulePermission('commission'), async (req, res) => {
  try {
    const { scope_type, scope_id, scope_name, is_eligible, effective_from, effective_to } = req.body
    const programmeResult = await query(`SELECT id FROM commission_programmes WHERE status = 'active' ORDER BY effective_from DESC LIMIT 1`)
    const programmeId = programmeResult.rows[0]?.id
    if (!programmeId) {
      return res.status(400).json({ error: { message: 'No active commission programme' } })
    }
    const result = await setEligibility(programmeId, scope_type, scope_id, scope_name, is_eligible, effective_from || new Date().toISOString(), effective_to || null, req.user?.userId || null)
    res.status(201).json(result)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/own/summary', requireModulePermission('commission'), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const monthStart = today.slice(0, 8) + '01'
    const nextMonth = new Date(Date.now() + 32 * 24 * 60 * 60 * 1000).toISOString().slice(0, 8) + '01'
    const summary = await getSalespersonCommissionSummary(req.user!.userId, monthStart, nextMonth)
    res.json(summary)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/own/daily', requireModulePermission('commission'), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const monthStart = today.slice(0, 8) + '01'
    const daily = await getSalespersonDailyCommission(req.user!.userId, monthStart, today)
    res.json({ daily, monthStart })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/own/transactions', requireModulePermission('commission'), async (req, res) => {
  try {
    const page = Number(req.query.page) || 1
    const pageSize = Number(req.query.page_size) || 25
    const result = await getSalespersonCommissionTransactions(req.user!.userId, page, pageSize)
    res.json(result)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/own/potential', requireModulePermission('commission'), async (req, res) => {
  try {
    const potential = await getPotentialCommission(req.user!.userId)
    res.json({ potential })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/summary', requireModulePermission('commission'), async (req, res) => {
  try {
    const { date_from, date_to } = req.query
    const today = new Date().toISOString().slice(0, 10)
    const dateFrom = String(date_from || today)
    const dateTo = String(date_to || today)
    const summary = await getManagementCommissionSummary(dateFrom, dateTo)
    res.json(summary)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/by-salesperson', requireModulePermission('commission'), async (req, res) => {
  try {
    const { date_from, date_to } = req.query
    const today = new Date().toISOString().slice(0, 10)
    const dateFrom = String(date_from || today)
    const dateTo = String(date_to || today)
    const data = await getManagementCommissionBySalesperson(dateFrom, dateTo)
    res.json({ salespeople: data, dateFrom, dateTo })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/transactions/:id/approve', requireModulePermission('commission'), async (req, res) => {
  try {
    const result = await approveCommission(req.params.id, req.user?.userId || null)
    if (!result) return res.status(404).json({ error: { message: 'Transaction not found or not pending' } })
    res.json(result)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/transactions/:id/pay', requireModulePermission('commission'), async (req, res) => {
  try {
    const result = await payCommission(req.params.id, req.user?.userId || null)
    if (!result) return res.status(404).json({ error: { message: 'Transaction not found or not approved' } })
    res.json(result)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/adjust', requireModulePermission('commission'), async (req, res) => {
  try {
    const { salesperson_id, amount, adjustment_type, reason, order_id, order_item_id } = req.body
    if (!salesperson_id || !amount || !adjustment_type || !reason) {
      return res.status(400).json({ error: { message: 'salesperson_id, amount, adjustment_type, and reason are required' } })
    }
    if (!['manual_add', 'manual_deduct'].includes(adjustment_type)) {
      return res.status(400).json({ error: { message: 'adjustment_type must be manual_add or manual_deduct' } })
    }
    const result = await manualAdjustment(salesperson_id, amount, adjustment_type, reason, order_id || null, order_item_id || null, req.user?.userId || null)
    res.status(201).json(result)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/rates/:id', requireAdmin, requireModulePermission('commission'), async (req, res) => {
  try {
    const { id } = req.params
    const { rate_per_item, effective_from, effective_to } = req.body
    if (rate_per_item === undefined || rate_per_item === null || rate_per_item <= 0) {
      return res.status(400).json({ error: { message: 'Valid rate_per_item is required' } })
    }
    if (!effective_from) {
      return res.status(400).json({ error: { message: 'effective_from is required' } })
    }
    const existing = await query('SELECT id FROM commission_rates WHERE id = $1', [id])
    if (!existing.rows.length) {
      return res.status(404).json({ error: { message: 'Rate not found' } })
    }
    const result = await query(
      `UPDATE commission_rates SET rate_per_item = $1, effective_from = $2, effective_to = $3 WHERE id = $4 RETURNING *`,
      [rate_per_item, effective_from, effective_to || null, id]
    )
    await logAudit({
      userId: req.user?.userId || null,
      action: 'commission_rate_updated',
      entityType: 'commission_rate',
      entityId: id,
      newValues: { rate_per_item, effective_from, effective_to }
    })
    res.json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.delete('/rates/:id', requireAdmin, requireModulePermission('commission'), async (req, res) => {
  try {
    const { id } = req.params
    const existing = await query('SELECT id FROM commission_rates WHERE id = $1', [id])
    if (!existing.rows.length) {
      return res.status(404).json({ error: { message: 'Rate not found' } })
    }
    await query('DELETE FROM commission_rates WHERE id = $1', [id])
    await logAudit({
      userId: req.user?.userId || null,
      action: 'commission_rate_deleted',
      entityType: 'commission_rate',
      entityId: id
    })
    res.status(204).send()
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/retroactive', requireAdmin, requireModulePermission('commission'), async (req, res) => {
  try {
    const { date_from, date_to } = req.body
    if (!date_from || !date_to) {
      return res.status(400).json({ error: { message: 'date_from and date_to are required (YYYY-MM-DD)' } })
    }
    const result = await evaluateOrdersForDateRange(date_from, date_to, req.user?.userId || null)
    res.json(result)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as commissionRoutes }
