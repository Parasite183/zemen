import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { db } from './db.js';
import { genId, genOtp, nowIso } from './crypto.js';
import { unauthorized, forbidden } from './http.js';
import smsProvider from './providers/sms.js';

export const JWT_TTL = '7d';
// Re-issue the token when less than a day of life remains (silent refresh).
const REFRESH_AFTER_SECONDS = 6 * 86400;
const ACTION_OTP_TTL_MS = 10 * 60 * 1000;

export function signToken(user, jti) {
  return jwt.sign({ sub: user.id, phone: user.phone, jti }, config.jwtSecret, { expiresIn: config.jwtTtl || JWT_TTL });
}

/**
 * Create a server-side session and mint a token for it. The JWT is
 * stateless, but its `jti` must match a live (non-revoked) session row,
 * which is what makes "sign out of all devices" actually revoke tokens.
 */
export async function issueSession(user, device = '', ip = '') {
  const jti = genId();
  await db.run(
    'INSERT INTO sessions (user_id, token_id, device_info, created_at) VALUES (?, ?, ?, ?)',
    [user.id, jti, String(device || '').slice(0, 200), nowIso()]
  );
  return { token: signToken(user, jti), jti };
}

export async function revokeSession(tokenId) {
  await db.run('UPDATE sessions SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL', [nowIso(), tokenId]);
}

export async function revokeAllSessions(userId) {
  await db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), userId]);
}

/** Attach `req.user` (fresh from the DB) + `req.session` on a valid token. */
export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.sub]);
    if (!user) return next(unauthorized('Account no longer exists'));
    const session = await db.get('SELECT * FROM sessions WHERE token_id = ?', [payload.jti]);
    if (!session || session.revoked_at) return next(unauthorized('Session revoked — sign in again'));
    req.user = user;
    req.token = payload;
    req.session = session;

    // Silent refresh: near-expiry tokens get a fresh one via response
    // header; the client swaps it in without forcing a re-login.
    if (payload.iat && Date.now() / 1000 - payload.iat > REFRESH_AFTER_SECONDS) {
      res.set('x-zemen-refresh', signToken(user, session.token_id));
    }
    // Best-effort activity stamp (a write per authed request is fine at
    // this scale and powers the session list).
    await db.run('UPDATE sessions SET last_seen_at = ? WHERE token_id = ?', [nowIso(), session.token_id]).catch(() => {});
    next();
  } catch {
    next(unauthorized('Session expired, sign in again'));
  }
}

export const requireModerator = (req, _res, next) => {
  if (!req.user?.is_moderator) return next(forbidden('Moderator role required'));
  next();
};

export const requireStaff = (req, _res, next) => {
  if (!req.user?.is_staff) return next(forbidden('Staff role required'));
  next();
};

export const requireOwner = (req, _res, next) => {
  if (!req.user?.is_owner) return next(forbidden('Owner role required'));
  next();
};

// ── one-time codes for high-stakes actions ───────────────────────────
// Distinct from login OTPs (otp_codes.purpose = 'action'): re-auth a
// user before funding escrow, confirming a large deal, or changing the
// phone number on the account.

export async function requestActionOtp(user) {
  const code = genOtp();
  await db.run('DELETE FROM otp_codes WHERE phone = ? AND purpose = ? AND used = 0', [user.phone, 'action']);
  await db.run(
    'INSERT INTO otp_codes (phone, code, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [user.phone, code, 'action', new Date(Date.now() + ACTION_OTP_TTL_MS).toISOString(), nowIso()]
  );
  await smsProvider.sendOtp(user.phone, code);
  return true;
}

/** Verify + burn an action OTP. Returns true only on a fresh valid code. */
export async function verifyActionOtp(user, code) {
  const c = String(code || '').trim();
  if (!c) return false;
  const row = await db.get(
    "SELECT * FROM otp_codes WHERE phone = ? AND purpose = 'action' AND used = 0 ORDER BY id DESC LIMIT 1",
    [user.phone]
  );
  if (!row || Date.parse(row.expires_at) < Date.now() || row.code !== c) return false;
  await db.run('UPDATE otp_codes SET used = 1 WHERE id = ?', [row.id]);
  return true;
}
