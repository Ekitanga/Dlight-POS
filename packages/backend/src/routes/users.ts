import { Router } from 'express'
import { query, transaction } from '../db'
import { authMiddleware } from '../middleware/auth'
import bcrypt from 'bcryptjs'

const router = Router()

router.use(authMiddleware)

router.get('/permissions', async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, description, module, action
       FROM permissions
       ORDER BY module, action`
    )
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/', async (req, res) => {
  try {
    const { search } = req.query
    let sql = `SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.created_at,
      COALESCE(
        (SELECT JSON_AGG(p.module || '.' || p.action ORDER BY p.module, p.action)
         FROM user_permissions up
         JOIN permissions p ON p.id = up.permission_id
         WHERE up.user_id = u.id),
        '[]'::json
      ) AS permissions
      FROM users u`
    const params: any[] = []
    
    if (search) {
      sql += ' WHERE u.email ILIKE $1 OR u.full_name ILIKE $1'
      params.push(`%${search}%`)
    }
    
    sql += ' ORDER BY u.created_at DESC'
    
    const result = await query(sql, params)
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/', async (req, res) => {
  try {
    const { email, full_name, role, password, is_active, permissions = [] } = req.body
    
    const existing = await query('SELECT id FROM users WHERE email = $1', [email])
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: { message: 'Email already exists' } })
    }
    
    const password_hash = await bcrypt.hash(password, 10)
    
    const user = await transaction(async client => {
      const result = await client.query(
        'INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, full_name, role, is_active, created_at',
        [email, password_hash, full_name, role || 'attendant', is_active ?? true]
      )
      const createdUser = result.rows[0]
      if (createdUser.role !== 'admin' && permissions.length > 0) {
        await client.query(
          `INSERT INTO user_permissions (user_id, permission_id, granted_by)
           SELECT $1, p.id, $2
           FROM permissions p
           WHERE p.module || '.' || p.action = ANY($3::text[])`,
          [createdUser.id, req.user?.userId, permissions]
        )
      }
      return createdUser
    })
    
    res.status(201).json(user)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { email, full_name, role, password, is_active, permissions } = req.body
    const existingResult = await query('SELECT id, role, is_active FROM users WHERE id = $1', [id])
    const existingUser = existingResult.rows[0]
    if (!existingUser) return res.status(404).json({ error: { message: 'User not found' } })

    const removingAdmin = existingUser.role === 'admin' && (role && role !== 'admin' || is_active === false)
    if (removingAdmin) {
      const adminCount = await query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND is_active = true")
      if (adminCount.rows[0].count <= 1) {
        return res.status(400).json({ error: { message: 'The final active administrator cannot be demoted or deactivated' } })
      }
    }
    
    const updateFields: string[] = []
    const params: any[] = []
    
    if (email) { updateFields.push(`email = $${updateFields.length + 1}`); params.push(email) }
    if (full_name) { updateFields.push(`full_name = $${updateFields.length + 1}`); params.push(full_name) }
    if (role) { updateFields.push(`role = $${updateFields.length + 1}`); params.push(role) }
    if (is_active !== undefined) { updateFields.push(`is_active = $${updateFields.length + 1}`); params.push(is_active) }
    
    if (password) {
      const password_hash = await bcrypt.hash(password, 10)
      updateFields.push(`password_hash = $${updateFields.length + 1}`)
      params.push(password_hash)
    }
    
    updateFields.push(`updated_at = NOW()`)
    params.push(id)
    
    const user = await transaction(async client => {
      const result = await client.query(
        `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${params.length} RETURNING id, email, full_name, role, is_active, created_at`,
        params
      )
      const updatedUser = result.rows[0]
      if (Array.isArray(permissions)) {
        await client.query('DELETE FROM user_permissions WHERE user_id = $1', [id])
        if (updatedUser.role !== 'admin' && permissions.length > 0) {
          await client.query(
            `INSERT INTO user_permissions (user_id, permission_id, granted_by)
             SELECT $1, p.id, $2
             FROM permissions p
             WHERE p.module || '.' || p.action = ANY($3::text[])`,
            [id, req.user?.userId, permissions]
          )
        }
      }
      await client.query(
        'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values) VALUES ($1, $2, $3, $4, $5)',
        [req.user?.userId, 'user_permissions_updated', 'user', id, JSON.stringify({ role: updatedUser.role, permissions })]
      )
      return updatedUser
    })
    
    res.json(user)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const target = await query('SELECT role, is_active FROM users WHERE id = $1', [id])
    if (!target.rows[0]) return res.status(404).json({ error: { message: 'User not found' } })
    if (target.rows[0].role === 'admin' && target.rows[0].is_active) {
      const adminCount = await query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND is_active = true")
      if (adminCount.rows[0].count <= 1) {
        return res.status(400).json({ error: { message: 'The final active administrator cannot be deactivated' } })
      }
    }
    await query('UPDATE users SET is_active = false WHERE id = $1', [id])
    res.status(204).send()
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as userRoutes }
