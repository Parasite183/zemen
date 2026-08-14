import { Router } from 'express';
import { db } from '../db.js';
import { wrap, ok, badRequest, unauthorized } from '../http.js';
import { signToken, authMiddleware } from '../auth.js';
import { genOtp, normalizePhone, genRef, nowIso } from '../crypto.js';
import smsProvider from '../providers/sms.js';
import { config } from '../config.js';

const router = Router();
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

export function publicUser(u) {
  return {
    id: u.id, phone: u.phone, name: u.name, category: u.category, bio: u.bio,
    id_verification_status: u.id_verification_status, is_moderator: u.is_moderator,
    is_staff: u.is_staff, created_at: u.created_at,
  };
}

// Step 1: request an OTP. The code is generated here, "sent" through the
// swappable SMS stub, and printed to the server console for the demo.
router.post('/request-otp', wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) throw badRequest('Enter a valid phone number', 'phone_invalid');

  await db.run('DELETE FROM otp_codes WHERE phone = ? AND used = 0', [phone]);
  const code = genOtp();
  await db.run(
    'INSERT INTO otp_codes (phone, code, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [phone, code, new Date(Date.now() + OTP_TTL_MS).toISOString(), nowIso()]
  );
  await smsProvider.sendOtp(phone, code);
  ok(res, { sent: true, expiresIn: OTP_TTL_MS / 1000 });
}));

// Step 2: verify the code → create or load the user, issue a token.
router.post('/verify-otp', wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '').trim();
  if (!phone || !code) throw badRequest('Phone and code required', 'missing_fields');

  const latest = await db.get(
    'SELECT * FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY id DESC LIMIT 1',
    [phone]
  );
  if (!latest) throw unauthorized('Invalid or expired code');
  if (Date.parse(latest.expires_at) < Date.now()) throw unauthorized('Code expired — request a new one');
  if (latest.code !== code) {
    // Brute-force guard: burn the code after a handful of wrong guesses.
    const attempts = latest.attempts + 1;
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
  if (!user) {
    isNew = true;
    const { lastId } = await db.run(
      'INSERT INTO users (phone, report_token, created_at) VALUES (?, ?, ?)',
      [phone, genRef('RP'), nowIso()]
    );
    user = await db.get('SELECT * FROM users WHERE id = ?', [lastId]);
  }
  ok(res, { token: signToken(user), user: publicUser(user), isNew });
}));

router.get('/me', authMiddleware, wrap(async (req, res) => {
  const reputation = await db.get('SELECT * FROM reputation_scores WHERE user_id = ?', [req.user.id]);
  ok(res, { user: publicUser(req.user), reputation });
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
