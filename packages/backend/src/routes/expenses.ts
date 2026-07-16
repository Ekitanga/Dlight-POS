import { Router } from 'express'
import { query } from '../db/index.js'
import { auditMiddleware } from '../middleware/audit.js'
import { paginatedResponse, paginationFromQuery } from '../utils/pagination.js'
import { logAudit } from '../utils/audit.js'

const router = Router()
const allowedFrequencies = ['daily', 'monthly', 'one_off']
const allowedPaymentMethods = ['cash', 'mpesa', 'bank_transfer']

function validateExpenseBody(body: any) {
  const category = String(body.category || '').trim()
  const description = String(body.description || '').trim()
  const amount = Number(body.amount)
  const frequency = allowedFrequencies.includes(body.frequency) ? body.frequency : ''
  const paymentMethod = allowedPaymentMethods.includes(body.payment_method) ? body.payment_method : ''
  const expenseDate = String(body.expense_date || '').trim()
  const effectiveEndDate = String(body.effective_end_date || '').trim() || null
  const referenceNotes = String(body.reference_notes || '').trim() || null
  const receiptUrl = String(body.receipt_url || '').trim() || null

  if (!category) return { error: 'Category is required' }
  if (!description) return { error: 'Expense name is required' }
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Amount must be greater than zero' }
  if (!frequency) return { error: 'Frequency must be Daily, Monthly, or One-off' }
  if (!paymentMethod) return { error: 'Payment method must be Cash, M-Pesa, or Bank' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) return { error: 'Expense date is required' }
  if (effectiveEndDate && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveEndDate)) return { error: 'End date must be a valid date' }
  if (effectiveEndDate && effectiveEndDate < expenseDate) return { error: 'End date cannot be before the start date' }

  return {
    category,
    description,
    amount,
    frequency,
    expense_date: expenseDate,
    effective_end_date: frequency === 'one_off' ? null : effectiveEndDate,
    payment_method: paymentMethod,
    reference_notes: referenceNotes,
    receipt_url: receiptUrl
  }
}

function expenseDatabaseError(error: any) {
  console.error('Expense database error:', error)
  if (error?.code === '42703' && ['frequency', 'reference_notes', 'effective_end_date', 'expense_categories'].some(column => String(error.message || '').includes(column))) {
    return 'Expense workflow migration is required. Run database\\expense_workflow_migration.sql, database\\expense_effective_dates_migration.sql, and database\\expense_categories_migration.sql, then restart the backend.'
  }
  if (error?.code === '23514') {
    return 'Expense data failed validation. Check frequency, payment method, and status.'
  }
  return 'Database error'
}

router.get('/', async (req, res) => {
  try {
    const { search, category, frequency, status, date_from, date_to } = req.query
    
    let sql = 'SELECT e.*, u.full_name as created_by_name FROM expenses e LEFT JOIN users u ON e.created_by = u.id'
    const params: any[] = []
    const conditions: string[] = []

    if (search) {
      conditions.push('(e.description ILIKE $' + (params.length + 1) + ' OR e.category ILIKE $' + (params.length + 1) + ')')
      params.push(`%${search}%`)
    }

    if (category) {
      conditions.push('e.category = $' + (params.length + 1))
      params.push(category)
    }

    if (frequency) {
      conditions.push('e.frequency = $' + (params.length + 1))
      params.push(frequency)
    }

    if (status) {
      conditions.push('e.status = $' + (params.length + 1))
      params.push(status)
    }

    if (date_from && date_to) {
      conditions.push(`(
        (e.frequency = 'one_off' AND e.expense_date BETWEEN $${params.length + 1} AND $${params.length + 2})
        OR (e.frequency <> 'one_off' AND e.expense_date <= $${params.length + 2}
          AND COALESCE(e.effective_end_date, DATE '9999-12-31') >= $${params.length + 1})
      )`)
      params.push(date_from, date_to)
    } else if (date_from) {
      conditions.push(`(
        (e.frequency = 'one_off' AND e.expense_date >= $${params.length + 1})
        OR (e.frequency <> 'one_off' AND COALESCE(e.effective_end_date, DATE '9999-12-31') >= $${params.length + 1})
      )`)
      params.push(date_from)
    } else if (date_to) {
      conditions.push('e.expense_date <= $' + (params.length + 1))
      params.push(date_to)
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ')
    }

    const pagination = paginationFromQuery(req.query)
    let total = 0
    if (pagination) {
      const countResult = await query(`SELECT COUNT(*)::int AS total FROM (${sql}) expenses_list`, params)
      total = countResult.rows[0].total
      params.push(pagination.pageSize, pagination.offset)
      sql += ` ORDER BY e.expense_date DESC, e.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`
    } else {
      sql += ' ORDER BY e.expense_date DESC, e.created_at DESC LIMIT 100'
    }

    const result = await query(sql, params)
    res.json(pagination ? paginatedResponse(result.rows, total, pagination) : result.rows)
  } catch (error) {
    res.status(500).json({ error: { message: expenseDatabaseError(error) } })
  }
})

router.post('/', async (req, res) => {
  try {
    const expense = validateExpenseBody(req.body)
    if ('error' in expense) return res.status(400).json({ error: { message: expense.error } })
    const result = await query(
      `INSERT INTO expenses (
        category, description, amount, frequency, expense_date, effective_end_date, payment_method,
        reference_notes, receipt_url, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        expense.category, expense.description, expense.amount, expense.frequency,
        expense.expense_date, expense.effective_end_date, expense.payment_method,
        expense.reference_notes, expense.receipt_url, req.user?.userId
      ]
    )
    await logAudit({
      req,
      action: 'expense_created',
      entityType: 'expense',
      entityId: result.rows[0].id,
      newValues: result.rows[0],
      metadata: { status_code: 201 }
    })
    res.status(201).json(result.rows[0])
  } catch (error) {
    res.status(500).json({ error: { message: expenseDatabaseError(error) } })
  }
})

router.put('/:id', auditMiddleware('expense', 'expense_updated'), async (req, res) => {
  try {
    const { id } = req.params
    const expense = validateExpenseBody(req.body)
    if ('error' in expense) return res.status(400).json({ error: { message: expense.error } })
    const result = await query(
      `UPDATE expenses
       SET category = $1, description = $2, amount = $3, frequency = $4,
           expense_date = $5, effective_end_date = $6, payment_method = $7, reference_notes = $8,
           receipt_url = $9
       WHERE id = $10
       RETURNING *`,
      [
        expense.category, expense.description, expense.amount, expense.frequency,
        expense.expense_date, expense.effective_end_date, expense.payment_method,
        expense.reference_notes, expense.receipt_url, id
      ]
    )
    res.json(result.rows[0])
  } catch (error) {
    res.status(500).json({ error: { message: expenseDatabaseError(error) } })
  }
})

router.put('/:id/approve', auditMiddleware('expense', 'expense_approved'), async (req, res) => {
  try {
    const { id } = req.params
    const result = await query(
      'UPDATE expenses SET status = $1, approved_by = $2, approved_at = NOW() WHERE id = $3 RETURNING *',
      ['approved', req.user?.userId, id]
    )
    res.json(result.rows[0])
  } catch (error) {
    res.status(500).json({ error: { message: expenseDatabaseError(error) } })
  }
})

router.put('/:id/reject', auditMiddleware('expense', 'expense_rejected'), async (req, res) => {
  try {
    const { id } = req.params
    const result = await query(
      'UPDATE expenses SET status = $1, approved_by = $2, approved_at = NOW() WHERE id = $3 RETURNING *',
      ['rejected', req.user?.userId, id]
    )
    res.json(result.rows[0])
  } catch (error) {
    res.status(500).json({ error: { message: expenseDatabaseError(error) } })
  }
})

router.delete('/:id', auditMiddleware('expense', 'expense_deleted'), async (req, res) => {
  try {
    const { id } = req.params
    await query('DELETE FROM expenses WHERE id = $1', [id])
    res.status(204).send()
  } catch (error) {
    res.status(500).json({ error: { message: expenseDatabaseError(error) } })
  }
})

export { router as expenseRoutes }
