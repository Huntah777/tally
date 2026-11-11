-- Tally · Calorie Deficit — D1 schema
-- Run once (safe to re-run, everything is IF NOT EXISTS):
--   npx wrangler d1 execute tally-db --remote --file=./schema.sql

-- ── accounts ─────────────────────────────────────────────────────────
-- Passwords are PBKDF2-SHA256 (WebCrypto, 100k iterations — the Workers
-- runtime ceiling). The recovery code is the only way back in after a
-- forgotten password without email infrastructure; it is shown once at
-- signup and stored hashed, exactly like the password.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,           -- random, also the WebAuthn user handle
  email         TEXT NOT NULL UNIQUE,       -- lower-cased
  pw_hash       TEXT NOT NULL,              -- base64
  pw_salt       TEXT NOT NULL,              -- base64
  pw_iter       INTEGER NOT NULL,
  recovery_hash TEXT,                       -- sha-256 hex of the current recovery code
  created_at    INTEGER NOT NULL
);

-- Session tokens live in an HttpOnly cookie; only their SHA-256 is stored,
-- so a leaked database can't be replayed as logins.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  label       TEXT                          -- coarse device hint from User-Agent
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- Passkeys. The browser hands over the public key already in SPKI form
-- (AuthenticatorAttestationResponse.getPublicKey()), so the server never
-- has to parse CBOR/COSE.
CREATE TABLE IF NOT EXISTS passkeys (
  id          TEXT PRIMARY KEY,             -- credential id, base64url
  user_id     TEXT NOT NULL,
  public_key  TEXT NOT NULL,                -- SPKI, base64url
  alg         INTEGER NOT NULL,             -- COSE alg: -7 ES256, -257 RS256
  sign_count  INTEGER NOT NULL DEFAULT 0,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys (user_id);

-- Single-use WebAuthn challenges, five-minute lifetime.
CREATE TABLE IF NOT EXISTS challenges (
  id          TEXT PRIMARY KEY,
  challenge   TEXT NOT NULL,                -- base64url
  user_id     TEXT,                         -- set for registration, null for login
  expires_at  INTEGER NOT NULL
);

-- Failed sign-in attempts, for throttling password guessing.
CREATE TABLE IF NOT EXISTS login_failures (
  key         TEXT NOT NULL,                -- 'email:<addr>' or 'ip:<addr>'
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures (key, at);

-- ── app data ─────────────────────────────────────────────────────────
-- One JSON blob per user, merged server-side on every PUT (see
-- functions/api/state.js) so two devices logging at once can't clobber each
-- other. Deletes travel as timestamped tombstones in `<collection>Deleted`.
-- `updated_at` doubles as the ETag version and must stay strictly increasing.
CREATE TABLE IF NOT EXISTS state (
  user_id     TEXT PRIMARY KEY,
  data        TEXT    NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL DEFAULT 0
);
