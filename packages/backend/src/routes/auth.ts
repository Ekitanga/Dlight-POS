import { Router } from 'express'
import { query } from '../db/index.js'
import { generateAccessToken, authMiddleware, getUserPermissions } from '../middleware/auth.js'
import {
  REFRESH_COOKIE,
  clearFailedLogins,
  clearRefreshCookie,
  createSession,
  loginLockedFor,
  readCookie,
  recordFailedLogin,
  revokeAllUserSessions,
  revokeSession,
  rotateSession,
  sessionIdFromRefreshToken,
  setRefreshCookie
} from '../services/sessions.js'
import { logAudit } from '../utils/audit.js'
import bcrypt from 'bcryptjs'

const router = Router()

// Compared against when the email is unknown, so a missing account takes about
// as long to reject as a wrong password (no account enumeration by timing).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dlight-timing-equaliser', 10)

function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }) {
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

function lockoutMessage(seconds: number) {
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

router.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim()
  const password = String(req.body?.password || '')
  if (!email || !password) {
    return res.status(400).json({ error: { message: 'Email and password are required' } })
  }
  const ip = clientIp(req)

  try {
    const lockedFor = await loginLockedFor(ip, email)
    if (lockedFor > 0) {
      res.setHeader('Retry-After', String(lockedFor))
      return res.status(429).json({ error: { message: lockoutMessage(lockedFor) } })
    }

    const result = await query(
      'SELECT id, email, password_hash, full_name, role FROM users WHERE email = $1 AND is_active = true',
      [email]
    )
    const user = result.rows[0]
    const valid = await bcrypt.compare(password, user?.password_hash || DUMMY_PASSWORD_HASH)

    if (!user || !valid) {
      await recordFailedLogin(ip, email)
      return res.status(401).json({ error: { message: 'Invalid credentials' } })
    }
    await clearFailedLogins(ip, email)

    const session = await createSession(user.id, req)
    const accessToken = generateAccessToken({ userId: user.id, email: user.email, role: user.role, sid: session.sessionId })
    setRefreshCookie(req, res, session.refreshToken)
    const permissions = await getUserPermissions(user.id, user.role)
    res.json({ accessToken, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, permissions } })
  } catch (err) {
    console.error('Login error:', err)
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

router.post('/refresh', async (req, res) => {
  try {
    const rotated = await rotateSession(readCookie(req, REFRESH_COOKIE))
    if (!rotated.ok) {
      clearRefreshCookie(req, res)
      if (rotated.reason === 'reused') {
        await logAudit({ req, action: 'session_token_reuse_detected', entityType: 'user', metadata: { status_code: 401 } }).catch(() => {})
      }
      return res.status(401).json({ error: { message: 'Session expired. Please sign in again.' } })
    }

    const result = await query(
      'SELECT id, email, full_name, role FROM users WHERE id = $1 AND is_active = true',
      [rotated.userId]
    )
    const user = result.rows[0]
    if (!user) {
      await revokeSession(rotated.sessionId, 'user_inactive')
      clearRefreshCookie(req, res)
      return res.status(401).json({ error: { message: 'Session expired. Please sign in again.' } })
    }

    setRefreshCookie(req, res, rotated.refreshToken)
    const accessToken = generateAccessToken({ userId: user.id, email: user.email, role: user.role, sid: rotated.sessionId })
    const permissions = await getUserPermissions(user.id, user.role)
    res.json({ accessToken, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, permissions } })
  } catch (err) {
    console.error('Refresh error:', err)
    res.status(500).json({ error: { message: 'Database error' } })
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

// Logout works from the refresh cookie alone, so it still ends the session
// when the access token has already expired.
router.post('/logout', async (req, res) => {
  const sessionId = sessionIdFromRefreshToken(readCookie(req, REFRESH_COOKIE))
  try {
    await revokeSession(sessionId, 'logout')
    if (sessionId) {
      const owner = await query('SELECT user_id FROM user_sessions WHERE id = $1', [sessionId])
      if (owner.rows[0]) {
        await logAudit({ req, userId: owner.rows[0].user_id, action: 'logout', entityType: 'user', entityId: owner.rows[0].user_id })
      }
    }
  } catch (err) {
    console.error('Logout error:', err)
  }
  clearRefreshCookie(req, res)
  res.json({ message: 'Logged out successfully' })
})

router.post('/logout-all', authMiddleware, async (req, res) => {
  try {
    await revokeAllUserSessions(req.user!.userId, 'logout_all')
    await logAudit({ req, action: 'logout_all_sessions', entityType: 'user', entityId: req.user!.userId })
    clearRefreshCookie(req, res)
    res.json({ message: 'Signed out on all devices' })
  } catch {
    res.status(500).json({ error: { message: 'Database error' } })
  }
})

export { router as authRoutes }
