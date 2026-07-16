import { Request, Response, NextFunction } from 'express'
import { query } from '../db/index.js'
import { logAudit } from '../utils/audit.js'

type EntityType = 'user' | 'product' | 'order' | 'supplier' | 'rider' | 'customer' | 'expense' | 'setting' | 'inventory'

export function auditMiddleware(entityType: EntityType, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const oldValues = req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE' 
      ? await getEntityValues(entityType, req.params.id || req.params.entityId)
      : null
    
    res.on('finish', async () => {
      if (req.user && res.statusCode < 400) {
        try {
          await logAudit({
            req,
            action,
            entityType,
            entityId: req.params.id || req.params.entityId || null,
            oldValues,
            newValues: req.body,
            metadata: { status_code: res.statusCode }
          })
        } catch (error) {
          console.error('Audit log error:', error)
        }
      }
    })
    
    next()
  }
}

async function getEntityValues(entityType: EntityType, id: string) {
  if (!id) return null

  const table = entityType === 'inventory' ? 'inventory' : `${entityType}s`
  const result = await query(`SELECT * FROM ${table} WHERE id = $1`, [id])
  return result.rows[0] || null
}
