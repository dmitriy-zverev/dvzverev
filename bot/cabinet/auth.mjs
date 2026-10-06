import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getMeta, setMeta } from './db.mjs';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_LOGIN_MAX_ATTEMPTS = 5;
const DEFAULT_LOGIN_WINDOW_SEC = 900;
const DEFAULT_LOGIN_LOCKOUT_SEC = 900;
const MAX_LOCKOUT_MULTIPLIER = 8;

/** @type {Map<string, { failureCount: number, windowEndsAt: number, lockedUntil: number, lockoutStreak: number }>} */
const loginDefenseByIp = new Map();

export function requestHeader(request, name) {
  const key = name.toLowerCase();
  const value = request.headers[key] ?? request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function allowedOrigins(env = process.env) {
  return (env.BOT_CABINET_ALLOWED_ORIGINS ||
    'http://localhost:4321,http://127.0.0.1:4321,http://localhost:8787,http://127.0.0.1:8787')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function hashPassword(password, salt = randomBytes(16)) {
  const derived = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('base64')}:${derived.toString('base64')}`;
}

export function verifyPassword(password, encoded) {
  if (!encoded?.startsWith('scrypt:')) return false;
  const parts = encoded.split(':');
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const actual = scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function ensurePasswordHash(db, env = process.env) {
  const fromEnv = env.BOT_CABINET_PASSWORD_HASH?.trim();
  if (fromEnv) {
    const stored = getMeta(db, 'password_hash');
    if (stored !== fromEnv) {
      setMeta(db, 'password_hash', fromEnv);
      db.prepare('DELETE FROM sessions').run();
    }
    return fromEnv;
  }
  const stored = getMeta(db, 'password_hash');
  if (stored) return stored;
  const password = env.BOT_CABINET_PASSWORD;
  if (!password) throw new Error('Set BOT_CABINET_PASSWORD or BOT_CABINET_PASSWORD_HASH');
  const encoded = hashPassword(password);
  setMeta(db, 'password_hash', encoded);
  return encoded;
}

export function cookieFlags(env = process.env) {
  const secure = env.BOT_CABINET_SECURE_COOKIES === 'true' ? '; Secure' : '';
  return `HttpOnly; Path=/; SameSite=Lax${secure}`;
}

export function createSession(db, env = process.env) {
  purgeExpiredSessions(db);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const sessionId = randomBytes(16).toString('hex');
  db.prepare(
    'INSERT INTO sessions (session_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
  ).run(sessionId, tokenHash, expiresAt, new Date().toISOString());
  return { token, expiresAt, cookieFlags: cookieFlags(env) };
}

export function sessionFromRequest(db, cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)cabinet_session=([^;]+)/);
  if (!match) return null;
  const tokenHash = createHash('sha256').update(match[1]).digest('hex');
  const row = db.prepare('SELECT session_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash);
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(row.session_id);
    return null;
  }
  return { sessionId: row.session_id };
}

export function clearSession(db, cookieHeader) {
  const session = sessionFromRequest(db, cookieHeader);
  if (session) db.prepare('DELETE FROM sessions WHERE session_id = ?').run(session.sessionId);
}

export function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

export function clearSessionCookieHeader(env = process.env) {
  return `cabinet_session=; ${cookieFlags(env)}; Max-Age=0`;
}

export function assertOrigin(request, env = process.env) {
  const origin = requestHeader(request, 'origin');
  const allowed = allowedOrigins(env);
  if (!origin) {
    const error = new Error('Origin required');
    error.status = 403;
    throw error;
  }
  if (!allowed.includes(origin)) {
    const error = new Error('Origin not allowed');
    error.status = 403;
    throw error;
  }
}

export function loginClientIp(request) {
  return request.socket?.remoteAddress || 'unknown';
}

export function loginDefenseConfig(env = process.env) {
  const maxAttempts = Number(env.BOT_CABINET_LOGIN_MAX_ATTEMPTS ?? DEFAULT_LOGIN_MAX_ATTEMPTS);
  const windowSec = Number(env.BOT_CABINET_LOGIN_WINDOW_SEC ?? DEFAULT_LOGIN_WINDOW_SEC);
  const lockoutSec = Number(env.BOT_CABINET_LOGIN_LOCKOUT_SEC ?? DEFAULT_LOGIN_LOCKOUT_SEC);
  return {
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0
      ? Math.floor(maxAttempts)
      : DEFAULT_LOGIN_MAX_ATTEMPTS,
    windowMs: (Number.isFinite(windowSec) && windowSec > 0 ? windowSec : DEFAULT_LOGIN_WINDOW_SEC) * 1000,
    lockoutMs: (Number.isFinite(lockoutSec) && lockoutSec > 0 ? lockoutSec : DEFAULT_LOGIN_LOCKOUT_SEC) * 1000,
  };
}

function loginDefenseBucket(key, env) {
  const config = loginDefenseConfig(env);
  const now = Date.now();
  let bucket = loginDefenseByIp.get(key);
  if (!bucket) {
    bucket = {
      failureCount: 0,
      windowEndsAt: now + config.windowMs,
      lockedUntil: 0,
      lockoutStreak: 0,
    };
    loginDefenseByIp.set(key, bucket);
    return bucket;
  }
  if (now > bucket.windowEndsAt && now >= bucket.lockedUntil) {
    bucket.failureCount = 0;
    bucket.windowEndsAt = now + config.windowMs;
  }
  return bucket;
}

function lockoutDurationMs(config, lockoutStreak) {
  const multiplier = Math.min(MAX_LOCKOUT_MULTIPLIER, 2 ** Math.max(0, lockoutStreak - 1));
  return config.lockoutMs * multiplier;
}

export function getLoginLockStatus(request, env = process.env) {
  const key = loginClientIp(request);
  const bucket = loginDefenseBucket(key, env);
  const now = Date.now();
  if (bucket.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000)),
    };
  }
  return { locked: false, retryAfterSeconds: 0 };
}

export function recordLoginFailure(request, env = process.env) {
  const key = loginClientIp(request);
  const config = loginDefenseConfig(env);
  const now = Date.now();
  const bucket = loginDefenseBucket(key, env);
  if (bucket.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000)),
    };
  }
  if (now > bucket.windowEndsAt) {
    bucket.failureCount = 0;
    bucket.windowEndsAt = now + config.windowMs;
  }
  bucket.failureCount += 1;
  if (bucket.failureCount < config.maxAttempts) {
    return { locked: false, retryAfterSeconds: 0 };
  }
  bucket.lockoutStreak += 1;
  const durationMs = lockoutDurationMs(config, bucket.lockoutStreak);
  bucket.lockedUntil = now + durationMs;
  bucket.failureCount = 0;
  bucket.windowEndsAt = bucket.lockedUntil + config.windowMs;
  return {
    locked: true,
    retryAfterSeconds: Math.max(1, Math.ceil(durationMs / 1000)),
  };
}

export function resetLoginAttempts(request) {
  const key = loginClientIp(request);
  loginDefenseByIp.delete(key);
}

export function clearLoginDefenseState() {
  loginDefenseByIp.clear();
}

export function loginRateLimitError(retryAfterSeconds) {
  const error = new Error('Too many login attempts');
  error.status = 429;
  error.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  return error;
}
