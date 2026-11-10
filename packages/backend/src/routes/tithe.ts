import { Router } from 'express'
import { query, transaction } from '../db/index.js'
import { logAudit } from '../utils/audit.js'
import {
  TITHE_BASES,
  TITHE_PAYMENT_METHODS,
  getTitheSettings,
  isIsoDate,
  nairobiToday,
  titheSummary,
  type TitheBasis
} from '../services/tithe.js'

// Mounted behind authMiddleware + requireAdmin: only owners and administrators
// can see or change anything here.
const router = Router()

function badRequest(res: any, message: string) {
  return res.status(400).json({ error: { message } })
}

async function requireEnabled(res: any) {
  const settings = await getTitheSettings()
  if (!settings.enabled) {
    res.status(409).json({ error: { message: 'Tithe tracking is turned off. Switch it on in Settings.', code: 'TITHE_DISABLED' } })
    return null
  }
  return settings
}

router.get('/settings', async (_req, res) => {
  try {
    res.json(await getTitheSettings())
  } catch (error) {
    console.error('Tithe settings error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/settings', async (req, res) => {
  const { enabled, rate_percent, basis, start_date, recipient_name } = req.body || {}
  const rate = Number(rate_percent)
  if (typeof enabled !== 'boolean') return badRequest(res, 'Choose whether tithe tracking is on or off')
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) return badRequest(res, 'Tithe rate must be more than 0% and at most 100%')
  if (!TITHE_BASES.includes(basis)) return badRequest(res, 'Choose what the tithe is calculated on')
  if (!isIsoDate(start_date)) return badRequest(res, 'Start date must be a valid date')
  if (start_date > nairobiToday()) return badRequest(res, 'Start date cannot be in the future')
  const recipient = String(recipient_name || '').trim().slice(0, 255) || null

  try {
    const before = await getTitheSettings()
    await query(
      `INSERT INTO tithe_settings (id, enabled, rate_percent, basis, start_date, recipient_name, updated_by, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET
         enabled = EXCLUDED.enabled, rate_percent = EXCLUDED.rate_percent, basis = EXCLUDED.basis,
         start_date = EXCLUDED.start_date, recipient_name = EXCLUDED.recipient_name,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [enabled, Math.round(rate * 100) / 100, basis as TitheBasis, start_date, recipient, req.user?.userId]
    )
    const after = await getTitheSettings()
    await logAudit({ req, action: 'tithe_settings_updated', entityType: 'setting', oldValues: { ...before }, newValues: { ...after } })
    res.json(after)
  } catch (error) {
    console.error('Tithe settings update error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/summary', async (_req, res) => {
  try {
    const settings = await requireEnabled(res)
    if (!settings) return
    res.json(await titheSummary(settings))
  } catch (error) {
    console.error('Tithe summary error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/payments', async (req, res) => {
  try {
    if (!(await requireEnabled(res))) return
    const includeVoided = req.query.include_voided === 'true'
    const result = await query(
      `SELECT tp.*, cu.full_name AS created_by_name, vu.full_name AS voided_by_name
       FROM tithe_payments tp
       LEFT JOIN users cu ON cu.id = tp.created_by
       LEFT JOIN users vu ON vu.id = tp.voided_by
       ${includeVoided ? '' : 'WHERE tp.voided_at IS NULL'}
       ORDER BY tp.paid_on DESC, tp.created_at DESC
       LIMIT 500`
    )
    res.json(result.rows)
  } catch (error) {
    console.error('Tithe payments error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/payments', async (req, res) => {
  const { amount, paid_on, payment_method, recipient, reference, notes } = req.body || {}
  const paymentAmount = Math.round(Number(amount) * 100) / 100
  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) return badRequest(res, 'Amount must be greater than zero')
  if (paymentAmount > 9_999_999_999) return badRequest(res, 'Amount is too large')
  if (!isIsoDate(paid_on)) return badRequest(res, 'Payment date must be a valid date')
  if (paid_on > nairobiToday()) return badRequest(res, 'Payment date cannot be in the future')
  if (!TITHE_PAYMENT_METHODS.includes(payment_method)) return badRequest(res, 'Choose cash, M-Pesa, bank transfer, or other')

  try {
    const settings = await requireEnabled(res)
    if (!settings) return
    if (paid_on < settings.start_date) {
      return badRequest(res, `Payment date is before the tithe start date (${settings.start_date})`)
    }
    const payment = await transaction(async client => {
      const result = await client.query(
        `INSERT INTO tithe_payments (amount, paid_on, payment_method, recipient, reference, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          paymentAmount,
          paid_on,
          payment_method,
          String(recipient || settings.recipient_name || '').trim().slice(0, 255) || null,
          String(reference || '').trim().slice(0, 255) || null,
          String(notes || '').trim().slice(0, 2000) || null,
          req.user?.userId
        ]
      )
      await logAudit({
        req,
        client,
        action: 'tithe_payment_recorded',
        entityType: 'tithe_payment',
        entityId: result.rows[0].id,
        newValues: result.rows[0],
        metadata: { amount: paymentAmount, payment_method }
      })
      return result.rows[0]
    })
    res.status(201).json(payment)
  } catch (error) {
    console.error('Tithe payment error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/payments/:id/void', async (req, res) => {
  const reason = String(req.body?.reason || '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: { message: 'Payment not found' } })
  if (!reason) return badRequest(res, 'A reason is required to void a payment')

  try {
    if (!(await requireEnabled(res))) return
    const voided = await transaction(async client => {
      const result = await client.query(
        `UPDATE tithe_payments
         SET voided_at = NOW(), voided_by = $2, void_reason = $3
         WHERE id = $1 AND voided_at IS NULL
         RETURNING *`,
        [req.params.id, req.user?.userId, reason.slice(0, 1000)]
      )
      if (!result.rows[0]) return null
      await logAudit({
        req,
        client,
        action: 'tithe_payment_voided',
        entityType: 'tithe_payment',
        entityId: req.params.id,
        newValues: result.rows[0],
        metadata: { amount: Number(result.rows[0].amount), reason }
      })
      return result.rows[0]
    })
    if (!voided) return res.status(404).json({ error: { message: 'Payment not found or already voided' } })
    res.json(voided)
  } catch (error) {
    console.error('Tithe void error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as titheRoutes }
