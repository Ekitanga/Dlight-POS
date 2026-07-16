import { Router } from 'express'
import { query } from '../db/index.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const { search } = req.query

    let sql = 'SELECT * FROM couriers WHERE is_active = true'
    const params: any[] = []

    if (search) {
      sql += ' AND name ILIKE $1'
      params.push(`%${search}%`)
    }

    sql += ' ORDER BY name'

    const result = await query(sql, params)
    res.json(result.rows)
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/', async (req, res) => {
  try {
    const { name, tracking_prefix } = req.body
    const result = await query(
      'INSERT INTO couriers (name, tracking_prefix) VALUES ($1, $2) RETURNING *',
      [name, tracking_prefix || null]
    )
    res.status(201).json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, tracking_prefix, is_active } = req.body
    const result = await query(
      'UPDATE couriers SET name = $1, tracking_prefix = $2, is_active = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
      [name, tracking_prefix || null, is_active, id]
    )
    res.json(result.rows[0])
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    await query('UPDATE couriers SET is_active = false WHERE id = $1', [id])
    res.status(204).send()
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as courierRoutes }
