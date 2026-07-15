import { Router } from 'express'
import { query } from '../db'
import { paginatedResponse, paginationFromQuery } from '../utils/pagination'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const { entity_type, action, date_from, date_to, user } = req.query
    const params: any[] = []
    const conditions: string[] = []
    if (entity_type) {
      conditions.push(`a.entity_type = $${params.length + 1}`)
      params.push(entity_type)
    }
    if (action) {
      conditions.push(`a.action ILIKE $${params.length + 1}`)
      params.push(`%${action}%`)
    }
    if (date_from) {
      conditions.push(`a.created_at::date >= $${params.length + 1}`)
      params.push(date_from)
    }
    if (date_to) {
      conditions.push(`a.created_at::date <= $${params.length + 1}`)
      params.push(date_to)
    }
    if (user) {
      conditions.push(`(u.full_name ILIKE $${params.length + 1} OR u.email ILIKE $${params.length + 1})`)
      params.push(`%${user}%`)
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const filterParams = [...params]
    let sql = `SELECT a.*, u.full_name AS user_name, u.email AS user_email, u.role AS user_role
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${whereClause}`
    const pagination = paginationFromQuery(req.query)
    let total = 0
    if (pagination) {
      const countResult = await query(`SELECT COUNT(*)::int AS total FROM (${sql}) audit_list`, params)
      total = countResult.rows[0].total
      params.push(pagination.pageSize, pagination.offset)
      sql += ` ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`
    } else {
      sql += ' ORDER BY a.created_at DESC LIMIT 500'
    }
    const result = await query(sql, params)
    const summaryResult = await query(
      `SELECT
        COUNT(*)::int AS total,
        COUNT(DISTINCT user_id)::int AS users,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last_24h,
        COUNT(*) FILTER (WHERE action ILIKE '%payment%' OR action ILIKE '%settlement%' OR action ILIKE '%refund%' OR action ILIKE '%reconciliation%')::int AS financial_events
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${whereClause}`,
      filterParams
    )
    const payload = pagination ? paginatedResponse(result.rows, total, pagination) : result.rows
    if (pagination) {
      res.json({ ...payload, summary: summaryResult.rows[0] })
    } else {
      res.json({ data: result.rows, summary: summaryResult.rows[0] })
    }
  } catch (error) {
    console.error('Audit list error:', error)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as auditRoutes }
