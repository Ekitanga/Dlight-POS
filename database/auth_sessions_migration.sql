-- Server-side sessions and persistent login throttling.
--
-- user_sessions: every successful login creates one row. The refresh token is
-- an opaque secret held only in an httpOnly cookie; the database stores its
-- SHA-256 hash. Access tokens carry the session id and are rejected as soon as
-- the session is revoked (logout, password change, deactivation).
--
-- login_attempts: failed-login counters survive restarts and are keyed per
-- client IP + email and per client IP, so one person cannot lock everyone out.

CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash CHAR(64) NOT NULL,
    previous_token_hash CHAR(64),
    rotated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoked_reason VARCHAR(50),
    ip_address INET,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_active_user
    ON user_sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_key TEXT PRIMARY KEY,
    failed_count INTEGER NOT NULL DEFAULT 0,
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_until TIMESTAMPTZ
);
