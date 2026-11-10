import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { query, transaction } from '../db/index.js'

export const REFRESH_COOKIE = 'dlight_rt'
const REFRESH_COOKIE_PATH = '/api/auth'
// A refresh token that was rotated moments ago is still accepted, so two tabs
// refreshing at the same time do not trip token-reuse detection.
const ROTATION_GRACE_SECONDS = 60

const LOGIN_WINDOW_MINUTES = 15
const LOCKOUT_MINUTES = 15
const ACCOUNT_IP_LIMIT = 5
const IP_LIMIT = 25

function durationToMs(value: string | undefined, fallbackMs: number): number {
  const match = String(value || '').trim().match(/^(\d+)\s*([smhd])?$/i)
  if (!match) return fallbackMs
  const amount = Number(match[1])
  const unit = (match[2] || 's').toLowerCase()
  const multiplier = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1000
  return amount * multiplier
}

export function refreshTtlMs(): number {
  return durationToMs(process.env.JWT_REFRESH_EXPIRES_IN, 7 * 86_400_000)
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex')
}

function newSecret(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`
}

function parseRefreshToken(token: unknown): { sessionId: string; secret: string } | null {
  const value = String(token || '')
  const match = value.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/i)
  return match ? { sessionId: match[1], secret: match[2] } : null
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim())
      } catch {
        return null
      }
    }
  }
  return null
}

function cookieIsSecure(req: Request): boolean {
  if (process.env.COOKIE_SECURE === 'true') return true
  if (process.env.COOKIE_SECURE === 'false') return false
  return process.env.NODE_ENV === 'production' || req.secure
}

export function setRefreshCookie(req: Request, res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: cookieIsSecure(req),
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: refreshTtlMs()
  })
}

export function clearRefreshCookie(req: Request, res: Response) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: cookieIsSecure(req),
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH
  })
}

export async function createSession(userId: string, req: Request): Promise<{ sessionId: string; refreshToken: string }> {
  const secret = newSecret()
  const result = await query(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, NOW() + ($3::bigint * INTERVAL '1 millisecond'), NULLIF($4, '')::inet, $5)
     RETURNING id`,
    [userId, hashSecret(secret), refreshTtlMs(), req.ip || '', String(req.headers['user-agent'] || '').slice(0, 500) || null]
  )
  const sessionId = result.rows[0].id
  return { sessionId, refreshToken: formatRefreshToken(sessionId, secret) }
}

export type RotateResult =
  | { ok: true; sessionId: string; userId: string; refreshToken: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'reused' }

/**
 * Exchanges a refresh token for a new one (rotation). Presenting a token that
 * was already rotated away (outside the short grace window) is treated as
 * theft: the whole session is revoked.
 */
export async function rotateSession(token: unknown): Promise<RotateResult> {
  const parsed = parseRefreshToken(token)
  if (!parsed) return { ok: false, reason: 'invalid' }

  return transaction(async client => {
    const result = await client.query(
      `SELECT s.*, (s.expires_at <= NOW()) AS is_expired,
         (s.rotated_at IS NOT NULL AND s.rotated_at > NOW() - ($2::int * INTERVAL '1 second')) AS in_grace,
         u.is_active
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1
       FOR UPDATE OF s`,
      [parsed.sessionId, ROTATION_GRACE_SECONDS]
    )
    const session = result.rows[0]
    if (!session) return { ok: false, reason: 'invalid' } as RotateResult
    if (session.revoked_at) return { ok: false, reason: 'revoked' } as RotateResult
    if (session.is_expired || !session.is_active) return { ok: false, reason: 'expired' } as RotateResult

    const presentedHash = hashSecret(parsed.secret)
    const matchesCurrent = presentedHash === session.refresh_token_hash
    const matchesRecent = session.in_grace && presentedHash === session.previous_token_hash
    if (!matchesCurrent && !matchesRecent) {
      await client.query(
        `UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = 'token_reuse' WHERE id = $1`,
        [session.id]
      )
      return { ok: false, reason: 'reused' } as RotateResult
    }

    const secret = newSecret()
    await client.query(
      `UPDATE user_sessions
       SET previous_token_hash = refresh_token_hash,
           refresh_token_hash = $2,
           rotated_at = NOW(),
           last_used_at = NOW(),
           expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond')
       WHERE id = $1`,
      [session.id, hashSecret(secret), refreshTtlMs()]
    )
    return { ok: true, sessionId: session.id, userId: session.user_id, refreshToken: formatRefreshToken(session.id, secret) } as RotateResult
  })
}

export async function revokeSession(sessionId: string | null | undefined, reason: string) {
  if (!sessionId) return
  await query(
    `UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason]
  )
}

export function sessionIdFromRefreshToken(token: unknown): string | null {
  return parseRefreshToken(token)?.sessionId || null
}

export async function revokeAllUserSessions(
  userId: string,
  reason: string,
  client?: { query: (text: string, values?: unknown[]) => Promise<unknown> }
) {
  const executor = client || { query }
  await executor.query(
    `UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason]
  )
}

// ---------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------

function throttleBypassed(): boolean {
  return process.env.NODE_ENV !== 'production' &&
    String(process.env.DEV_BYPASS_LOGIN_LIMIT || '').toLowerCase() === 'true'
}

function attemptKeys(ip: string, email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  return {
    accountKey: `acct:${ip}:${normalizedEmail}`,
    ipKey: `ip:${ip}`
  }
}

/** Returns the number of seconds until the caller may try again, or 0. */
export async function loginLockedFor(ip: string, email: string): Promise<number> {
  if (throttleBypassed()) return 0
  const { accountKey, ipKey } = attemptKeys(ip, email)
  const result = await query(
    `SELECT CEIL(EXTRACT(EPOCH FROM MAX(locked_until) - NOW()))::int AS seconds
     FROM login_attempts
     WHERE attempt_key = ANY($1::text[]) AND locked_until > NOW()`,
    [[accountKey, ipKey]]
  )
  return Math.max(0, Number(result.rows[0]?.seconds || 0))
}

async function bumpAttempt(key: string, limit: number) {
  await query(
    `INSERT INTO login_attempts (attempt_key, failed_count, window_started_at)
     VALUES ($1, 1, NOW())
     ON CONFLICT (attempt_key) DO UPDATE SET
       failed_count = CASE
         WHEN login_attempts.window_started_at < NOW() - ($2::int * INTERVAL '1 minute') THEN 1
         ELSE login_attempts.failed_count + 1 END,
       window_started_at = CASE
         WHEN login_attempts.window_started_at < NOW() - ($2::int * INTERVAL '1 minute') THEN NOW()
         ELSE login_attempts.window_started_at END`,
    [key, LOGIN_WINDOW_MINUTES]
  )
  await query(
    `UPDATE login_attempts
     SET locked_until = NOW() + ($3::int * INTERVAL '1 minute'), failed_count = 0, window_started_at = NOW()
     WHERE attempt_key = $1 AND failed_count >= $2`,
    [key, limit, LOCKOUT_MINUTES]
  )
}

export async function recordFailedLogin(ip: string, email: string) {
  if (throttleBypassed()) return
  const { accountKey, ipKey } = attemptKeys(ip, email)
  await bumpAttempt(accountKey, ACCOUNT_IP_LIMIT)
  await bumpAttempt(ipKey, IP_LIMIT)
  // Housekeeping: drop stale rows so the table stays small.
  await query(
    `DELETE FROM login_attempts
     WHERE window_started_at < NOW() - INTERVAL '1 day'
       AND (locked_until IS NULL OR locked_until < NOW())`
  )
}

export async function clearFailedLogins(ip: string, email: string) {
  if (throttleBypassed()) return
  const { accountKey } = attemptKeys(ip, email)
  await query('DELETE FROM login_attempts WHERE attempt_key = $1', [accountKey])
}
