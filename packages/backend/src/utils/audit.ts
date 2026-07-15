import type { Request } from 'express'
import { query } from '../db'

type AuditValues = Record<string, unknown> | unknown[] | null | undefined

interface AuditOptions {
  req?: Request
  client?: { query: (text: string, values?: unknown[]) => Promise<unknown> }
  userId?: string | null
  action: string
  entityType?: string | null
  entityId?: string | null
  oldValues?: AuditValues
  newValues?: AuditValues
  metadata?: Record<string, unknown>
}

function cleanObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''))
}

function requestIp(req?: Request) {
  const forwarded = req?.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim()
  }
  return req?.ip || req?.socket?.remoteAddress || null
}

function safeJson(value: AuditValues) {
  if (value === undefined) return null
  return value
}

function summarize(value: AuditValues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value as Record<string, unknown>).slice(0, 12)
  return keys.length ? keys : null
}

export async function logAudit({
  req,
  client,
  userId,
  action,
  entityType,
  entityId,
  oldValues,
  newValues,
  metadata = {}
}: AuditOptions) {
  const actor = req?.user
  const requestMetadata = cleanObject({
    method: req?.method,
    path: req?.originalUrl || req?.url,
    status_code: metadata.status_code,
    actor_email: actor?.email,
    actor_role: actor?.role,
    old_fields: summarize(oldValues),
    new_fields: summarize(newValues),
    ...metadata
  })

  const executor = client || { query }
  await executor.query(
    `INSERT INTO audit_logs
      (user_id, action, entity_type, entity_id, old_values, new_values, metadata, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, '')::inet, $9)`,
    [
      userId || actor?.userId || null,
      action,
      entityType || null,
      entityId || null,
      safeJson(oldValues),
      safeJson(newValues),
      requestMetadata,
      requestIp(req),
      req?.headers['user-agent'] || null
    ]
  )
}
