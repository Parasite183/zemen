import { Router } from 'express';
import { db } from '../db.js';
import { wrap, ok, badRequest, unauthorized } from '../http.js';
import { authMiddleware, issueSession, revokeSession, revokeAllSessions, requestActionOtp } from '../auth.js';
import { genOtp, normalizePhone, genRef, nowIso } from '../crypto.js';
import { ipPrefix } from '../services/identity.js';
import smsProvider from '../providers/sms.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { AUTH_LIMITS } from '../rate-limit.js';

const router = Router();
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

/** Coarse client-IP for fraud detection (CF header on Workers, req.ip otherwise). */
function clientIp(req) {
  return ipPrefix(req.headers['cf-connecting-ip'] || req.ip || '');
}

export function publicUser(u) {
  return {
    id: u.id, phone: u.phone, name: u.name, category: u.category, bio: u.bio,
    id_verification_status: u.id_verification_status, is_moderator: u.is_moderator,
    is_staff: u.is_staff, is_owner: u.is_owner, created_at: u.created_at,
  };
}

// Step 1: request an OTP. The code is generated here and delivered
// through the swappable SMS provider. When the provider can validate the
// line, VoIP/virtual numbers are rejected up front (anti-sybil: they are
// the cheapest way to fabricate many accounts).
// Brute-force OTP protection: rate-limited per IP and per phone number
// (in-memory window — see rate-limit.js for the Workers caveat).
router.post('/request-otp', AUTH_LIMITS.requestOtpIp, AUTH_LIMITS.requestOtpPhone, wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) throw badRequest('Enter a valid phone number', 'phone_invalid');

  const check = await smsProvider.validateNumber(phone);
  if (config.smsVoipBlock && check?.isVoip) {
    throw badRequest('This number looks like a VoIP/virtual line — use a real phone number', 'voip_number');
  }

  await db.run('DELETE FROM otp_codes WHERE phone = ? AND purpose = ? AND used = 0', [phone, 'login']);
  const code = genOtp();
  await db.run(
    'INSERT INTO otp_codes (phone, code, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [phone, code, 'login', new Date(Date.now() + OTP_TTL_MS).toISOString(), nowIso()]
  );
  await smsProvider.sendOtp(phone, code);
  ok(res, { sent: true, expiresIn: OTP_TTL_MS / 1000 });
}));

// Step 2: verify the code → create or load the user, issue a token.
router.post('/verify-otp', AUTH_LIMITS.verifyOtpIp, AUTH_LIMITS.verifyOtpPhone, wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '').trim();
  if (!phone || !code) throw badRequest('Phone and code required', 'missing_fields');

  const latest = await db.get(
    "SELECT * FROM otp_codes WHERE phone = ? AND purpose = 'login' AND used = 0 ORDER BY id DESC LIMIT 1",
    [phone]
  );
  if (!latest) {
    logger.warn('auth_failed', { reason: 'no_code', phone, ip: clientIp(req) });
    throw unauthorized('Invalid or expired code');
  }
  if (Date.parse(latest.expires_at) < Date.now()) {
    logger.warn('auth_failed', { reason: 'expired', phone, ip: clientIp(req) });
    throw unauthorized('Code expired — request a new one');
  }
  if (latest.code !== code) {
    // Brute-force guard: burn the code after a handful of wrong guesses.
    const attempts = latest.attempts + 1;
    logger.warn('auth_failed', { reason: 'wrong_code', phone, attempt: attempts, ip: clientIp(req) });
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await db.run('UPDATE otp_codes SET used = 1 WHERE id = ?', [latest.id]);
      throw unauthorized('Too many attempts — request a new code');
    }
    await db.run('UPDATE otp_codes SET attempts = ? WHERE id = ?', [attempts, latest.id]);
    throw unauthorized('Invalid or expired code');
  }
  const row = latest;

  await db.run('UPDATE otp_codes SET used = 1 WHERE id = ?', [row.id]);

  let user = await db.get('SELECT * FROM users WHERE phone = ?', [phone]);
  let isNew = false;
  const device = String(req.body?.device || '').slice(0, 200);
  const ip = clientIp(req);
  if (!user) {
    isNew = true;
    const { lastId } = await db.run(
      'INSERT INTO users (phone, report_token, device_fingerprint, signup_ip, last_ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [phone, genRef('RP'), device, ip, ip, nowIso()]
    );
    user = await db.get('SELECT * FROM users WHERE id = ?', [lastId]);
  } else {
    // Keep the first-seen fingerprint; refresh the last-seen IP.
    await db.run(
      `UPDATE users SET last_ip = ?,
              device_fingerprint = CASE WHEN device_fingerprint = '' THEN ? ELSE device_fingerprint END
       WHERE id = ?`,
      [ip, device, user.id]
    );
    user = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
  }
  const { token } = await issueSession(user, device, ip);
  ok(res, { token, user: publicUser(user), isNew });
}));

// Server-side session endpoints (the JWT is stateless but its jti must
// match a live sessions row — these revoke tokens server-side).
router.post('/signout', authMiddleware, wrap(async (req, res) => {
  await revokeSession(req.token.jti);
  ok(res, { signedOut: true });
}));

router.post('/sessions/revoke-all', authMiddleware, wrap(async (req, res) => {
  await revokeAllSessions(req.user.id);
  ok(res, { revoked: true });
}));

// Send a one-time code to the CURRENT phone for a high-stakes action
// (funding escrow, confirming a large deal, changing the phone number).
router.post('/action-otp', authMiddleware, AUTH_LIMITS.actionOtpUser, wrap(async (req, res) => {
  await requestActionOtp(req.user);
  ok(res, { sent: true, expiresIn: 600 });
}));

router.get('/me', authMiddleware, wrap(async (req, res) => {
  const reputation = await db.get('SELECT * FROM reputation_scores WHERE user_id = ?', [req.user.id]);
  ok(res, {
    user: publicUser(req.user),
    reputation,
    // Identity limits the UI surfaces (e.g. New deal / Profile hints).
    limits: {
      freeDealThresholdEtb: config.freeDealThresholdEtb,
      unverifiedLifetimeVolumeEtb: config.unverifiedLifetimeVolumeEtb,
    },
  });
}));

// Dev-only: peek at the latest unused OTP for a phone so demos stay
// clickable without digging through the console. Never exposed in prod.
if (config.devMode) {
  router.get('/dev/otp', wrap(async (req, res) => {
    const phone = normalizePhone(req.query.phone);
    const row = await db.get(
      'SELECT code FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY id DESC LIMIT 1',
      [phone]
    );
    ok(res, { phone, code: row?.code ?? null });
  }));
}

export default router;
