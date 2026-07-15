import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { query } from '../db'

export interface AuthPayload {
  userId: string
  email: string
  role: string
}

function jwtSecret(name: 'JWT_SECRET' | 'JWT_REFRESH_SECRET'): string {
  const value = process.env[name]
  const unsafeDefaults = ['secret', 'refresh-secret', 'your-secret-key-here-change-in-production', 'your-refresh-secret-here-change-in-production']
  if (!value || (process.env.NODE_ENV === 'production' && unsafeDefaults.includes(value))) {
    throw new Error(`${name} must be configured with a secure production value`)
  }
  return value
}

export function generateTokens(payload: AuthPayload) {
  const accessToken = jwt.sign(payload, jwtSecret('JWT_SECRET'), {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m'
  } as jwt.SignOptions)
  
  const refreshToken = jwt.sign({ ...payload }, jwtSecret('JWT_REFRESH_SECRET'), {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
  } as jwt.SignOptions)
  
  return { accessToken, refreshToken }
}

export function verifyAccessToken(token: string): AuthPayload {
  return jwt.verify(token, jwtSecret('JWT_SECRET')) as AuthPayload
}

export function verifyRefreshToken(token: string): AuthPayload {
  return jwt.verify(token, jwtSecret('JWT_REFRESH_SECRET')) as AuthPayload
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: { message: 'No token provided' } })
  }
  
  const token = authHeader.split(' ')[1]
  
  try {
    const payload = verifyAccessToken(token)
    
    const userResult = await query(
      'SELECT id, email, role FROM users WHERE id = $1 AND is_active = true',
      [payload.userId]
    )
    
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: { message: 'Invalid token' } })
    }
    
    req.user = {
      userId: userResult.rows[0].id,
      email: userResult.rows[0].email,
      role: userResult.rows[0].role
    }
    next()
  } catch {
    return res.status(401).json({ error: { message: 'Invalid token' } })
  }
}

export async function getUserPermissions(userId: string, role?: string): Promise<string[]> {
  if (role === 'admin' || role === 'owner') {
    const result = await query('SELECT module, action FROM permissions ORDER BY module, action')
    return result.rows.map(permission => `${permission.module}.${permission.action}`)
  }

  const result = await query(
    `SELECT p.module, p.action
     FROM user_permissions up
     JOIN permissions p ON p.id = up.permission_id
     WHERE up.user_id = $1
     ORDER BY p.module, p.action`,
    [userId]
  )
  return result.rows.map(permission => `${permission.module}.${permission.action}`)
}

function actionForRequest(module: string, req: Request): string {
  const method = req.method.toUpperCase()
  const path = req.path
  if (module === 'orders' && path.includes('/refunds')) return method === 'GET' ? 'view' : 'edit'

  if (
    module === 'orders' &&
    req.method.toUpperCase() === 'PUT' &&
    req.path.endsWith('/status')
  ) return ['cancelled', 'returned'].includes(req.body?.status) ? 'cancel' : 'status'
  if (module === 'inventory') return method === 'GET' ? 'view' : 'adjust'
  if (module === 'suppliers') {
    if (method === 'GET') return 'view'
    if (/payments|settlements|returns|payables/.test(path)) return 'pay'
    return 'manage'
  }
  if (module === 'riders') {
    if (method === 'GET') return 'view'
    if (/payments|settlements|earnings/.test(path)) return 'pay'
    return 'manage'
  }
  if (module === 'couriers') return method === 'GET' ? 'view' : 'manage'
  if (module === 'deliveries') {
    if (path.includes('/cod')) return method === 'GET' ? 'view' : 'remit'
    return method === 'GET' ? 'view' : 'manage'
  }
  if (module === 'expenses' && (path.endsWith('/approve') || path.endsWith('/reject'))) return 'approve'
  if (module === 'reports') {
    if (method !== 'GET' && path.includes('/reconciliation')) return 'reconcile'
    return req.query.format === 'csv' ? 'export' : 'view'
  }
  if (module === 'customers' && path.includes('/payments')) return 'edit'
  if (module === 'users') return method === 'GET' ? 'view' : 'manage'
  if (module === 'settings') return method === 'GET' ? 'view' : 'edit'
  if (method === 'GET') return 'view'
  if (method === 'POST') return 'create'
  if (method === 'DELETE') return 'delete'
  return 'edit'
}

export function requireModulePermission(module: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.user?.role === 'admin' || req.user?.role === 'owner') return next()
      if (!req.user) return res.status(401).json({ error: { message: 'Authentication required' } })

      const permissionModule = module === 'deliveries' && req.path.includes('/cod') ? 'cod' : module
      const action = actionForRequest(module, req)
      const result = await query(
        `SELECT 1
         FROM user_permissions up
         JOIN permissions p ON p.id = up.permission_id
         WHERE up.user_id = $1 AND p.module = $2 AND p.action = $3`,
        [req.user.userId, permissionModule, action]
      )
      if (result.rows.length === 0) {
        return res.status(403).json({ error: { message: `Permission required: ${permissionModule}.${action}` } })
      }
      next()
    } catch {
      res.status(500).json({ error: { message: 'Unable to verify permission' } })
    }
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const role = req.user?.role
  if (role !== 'admin' && role !== 'owner') {
    return res.status(403).json({ error: { message: 'Admin access required' } })
  }

  next()
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}
