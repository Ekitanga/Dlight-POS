import { query } from '../db/index.js'

export async function emitNotification({
  title,
  message,
  type,
  entityType,
  entityId
}: {
  title: string
  message: string
  type: string
  entityType?: string
  entityId?: string
}) {
  const usersResult = await query(
    `SELECT id FROM users WHERE role IN ('admin', 'owner') AND is_active = true`
  )
  for (const user of usersResult.rows) {
    await query(
      `INSERT INTO notifications (user_id, title, message, type, entity_type, entity_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, title, message, type, entityType || null, entityId || null]
    )
  }
}
