import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { query } from '../db/index.js'
import { paginatedResponse, paginationFromQuery } from '../utils/pagination.js'

const router = Router()

router.use(authMiddleware)

router.get('/', async (req, res) => {
  try {
    const { is_read, type } = req.query
    const params: any[] = [req.user?.userId]
    let sql = `
      SELECT
        n.id,
        n.title,
        n.message,
        n.type,
        n.entity_type,
        n.entity_id,
        n.is_read,
        n.created_at
      FROM notifications n
      WHERE n.user_id = $1
    `

    if (is_read === 'true') {
      sql += ' AND n.is_read = true'
    } else if (is_read === 'false') {
      sql += ' AND n.is_read = false'
    }
    if (type) {
      sql += ' AND n.type = $' + (params.length + 1)
      params.push(type)
    }

    const pagination = paginationFromQuery(req.query)
    if (pagination) {
      const countResult = await query(`SELECT COUNT(*)::int AS total FROM (${sql}) notifications_list`, params)
      const total = countResult.rows[0].total
      params.push(pagination.pageSize, pagination.offset)
      sql += ' ORDER BY n.created_at DESC LIMIT $' + (params.length - 1) + ' OFFSET $' + params.length
      const result = await query(sql, params)
      return res.json(paginatedResponse(result.rows, total, pagination))
    }

    sql += ' ORDER BY n.created_at DESC'
    const result = await query(sql, params)
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/unread-count', async (req, res) => {
  try {
    const result = await query(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user?.userId]
    )
    res.json({ count: result.rows[0].count })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/:id/read', async (req, res) => {
  try {
    const { id } = req.params
    const result = await query(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, req.user?.userId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Notification not found' } })
    }
    res.json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/read-all', async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
      [req.user?.userId]
    )
    res.status(204).send()
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as notificationsRoutes }
