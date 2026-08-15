// ─────────────────────────────────────────────────────────────────────
// Basic abuse protection: fixed-window rate limiting.
//
//   rateLimit({ name, windowMs, max, keyFn })  → middleware
//
// Returns 429 with Retry-After when a client exceeds the window, and
// logs every refusal (auth_rate_limited) so abuse is visible.
//
// Keyers provided:
//   ipKey(req)      — client IP (Cloudflare header on Workers, req.ip
//                     otherwise). Coarse and NAT-tolerant by design.
//   accountKey(req) — authed user id (null when anonymous).
//
// ⚠️ Honest limitation: on Cloudflare Workers the counter is per-isolate
//    (in-memory Map), so a distributed attacker spread across isolates
//    can exceed the limit. This is a deliberate baseline, not a full
//    DDoS defense — Cloudflare's edge (WAF / rate limiting rules) is
//    the operator-level layer for that. LAUNCH_CHECKLIST.md §Abuse
//    covers enabling the edge rules. A D1-backed limiter is the
//    documented follow-up if per-account limits must be global.
// ─────────────────────────────────────────────────────────────────────
import { logger } from './logger.js';

/** Coarse client IP (Cloudflare header on Workers, req.ip otherwise). */
export function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.ip || '').trim();
}

export function ipKey(req) {
  return clientIp(req) ? `ip:${clientIp(req)}` : null;
}

export function accountKey(req) {
  return req.user?.id ? `acct:${req.user.id}` : null;
}

export function rateLimit({ name, windowMs, max, keyFn }) {
  if (!name || !windowMs || !max || !keyFn) throw new Error('rateLimit requires { name, windowMs, max, keyFn }');
  const hits = new Map();

  return (req, res, next) => {
    const key = keyFn(req);
    if (!key) return next();
    const now = Date.now();
    const bucket = hits.get(key);

    if (!bucket || bucket.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      // Opportunistic cleanup so memory stays bounded under bursts.
      if (hits.size > 10000) {
        for (const [k, b] of hits) if (b.resetAt <= now) hits.delete(k);
      }
      res.set('ratelimit-limit', String(max));
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set('ratelimit-limit', String(max));
      res.set('retry-after', String(retryAfter));
      logger.warn('auth_rate_limited', { limiter: name, key });
      return res.status(429).json({ error: 'Too many requests — try again shortly', code: 'rate_limited' });
    }
    return next();
  };
}

// ── preconfigured limiters ───────────────────────────────────────────
export const AUTH_LIMITS = {
  requestOtpIp: rateLimit({ name: 'request-otp-ip', windowMs: 60_000, max: 5, keyFn: ipKey }),
  requestOtpPhone: rateLimit({ name: 'request-otp-phone', windowMs: 15 * 60_000, max: 10, keyFn: (req) => (req.body?.phone ? `phone:${String(req.body.phone).trim()}` : null) }),
  verifyOtpIp: rateLimit({ name: 'verify-otp-ip', windowMs: 60_000, max: 10, keyFn: ipKey }),
  verifyOtpPhone: rateLimit({ name: 'verify-otp-phone', windowMs: 60_000, max: 15, keyFn: (req) => (req.body?.phone ? `phone:${String(req.body.phone).trim()}` : null) }),
  actionOtpUser: rateLimit({ name: 'action-otp-user', windowMs: 10 * 60_000, max: 5, keyFn: accountKey }),
};

export const CREATE_LIMITS = {
  deals: [
    rateLimit({ name: 'deal-create-user', windowMs: 60 * 60_000, max: 20, keyFn: accountKey }),
    rateLimit({ name: 'deal-create-ip', windowMs: 60 * 60_000, max: 60, keyFn: ipKey }),
  ],
  disputes: [
    rateLimit({ name: 'dispute-create-user', windowMs: 60 * 60_000, max: 20, keyFn: accountKey }),
    rateLimit({ name: 'dispute-create-ip', windowMs: 60 * 60_000, max: 60, keyFn: ipKey }),
  ],
};
