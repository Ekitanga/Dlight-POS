import { Router } from 'express'
import { query } from '../db/index.js'
import { generateTokens, verifyRefreshToken, authMiddleware, getUserPermissions } from '../middleware/auth.js'
import bcrypt from 'bcryptjs'

const router = Router()
const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_LIMIT = 5

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  const attemptKey = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const attempt = loginAttempts.get(attemptKey)
  if (attempt && attempt.resetAt > now && attempt.count >= LOGIN_LIMIT) {
    return res.status(429).json({ error: { message: 'Too many login attempts. Try again later.' } })
  }
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'Email and password are required' } })
  }

  try {
    const result = await query(
      'SELECT id, email, password_hash, full_name, role FROM users WHERE email = $1 AND is_active = true',
      [email]
    )
    
    const user = result.rows[0]
    
    if (!user) {
      loginAttempts.set(attemptKey, { count: (attempt?.resetAt || 0) > now ? attempt!.count + 1 : 1, resetAt: now + LOGIN_WINDOW_MS })
      return res.status(401).json({ error: { message: 'Invalid credentials' } })
    }
    
    const valid = await bcrypt.compare(password, user.password_hash)
    
    if (!valid) {
      loginAttempts.set(attemptKey, { count: (attempt?.resetAt || 0) > now ? attempt!.count + 1 : 1, resetAt: now + LOGIN_WINDOW_MS })
      return res.status(401).json({ error: { message: 'Invalid credentials' } })
    }
    loginAttempts.delete(attemptKey)
    
    const tokens = generateTokens({
      userId: user.id,
      email: user.email,
      role: user.role
    })
    const permissions = await getUserPermissions(user.id, user.role)
    res.json({ ...tokens, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, permissions } })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body
  
  try {
    const payload = verifyRefreshToken(refreshToken)
    
    const result = await query(
      'SELECT id, email, full_name, role FROM users WHERE id = $1 AND is_active = true',
      [payload.userId]
    )
    const user = result.rows[0]
    if (!user) return res.status(401).json({ error: { message: 'Invalid refresh token' } })

    const tokens = generateTokens({ userId: user.id, email: user.email, role: user.role })
    const permissions = await getUserPermissions(user.id, user.role)
    res.json({ ...tokens, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, permissions } })
  } catch {
    res.status(401).json({ error: { message: 'Invalid refresh token' } })
  }
})

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, email, full_name, role FROM users WHERE id = $1 AND is_active = true',
      [req.user!.userId]
    )
    const user = result.rows[0]
    if (!user) return res.status(404).json({ error: { message: 'User not found' } })
    const permissions = await getUserPermissions(user.id, user.role)
    res.json({ ...user, permissions })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.get('/branding', async (_req, res) => {
  try {
    const result = await query(
      `SELECT company_name, logo_url, appearance_mode, brand_preset, primary_color,
        accent_color, sidebar_style, interface_density
       FROM settings ORDER BY created_at DESC LIMIT 1`
    )
    res.json(result.rows[0] || { company_name: 'Dlight POS', logo_url: null })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/logout', authMiddleware, async (req, res) => {
  try {
    await query(
      'INSERT INTO audit_logs (user_id, action, entity_type) VALUES ($1, $2, $3)',
      [req.user!.userId, 'logout', 'user']
    )
  } catch {
    // Ignore audit log errors
  }
  
  res.json({ message: 'Logged out successfully' })
})

export { router as authRoutes }
