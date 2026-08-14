import 'dotenv/config';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3001),
  databaseUrl: (env.DATABASE_URL || '').trim(),
  dbFile: env.DB_FILE || './data/zemen.db',
  jwtSecret: env.JWT_SECRET || 'zemen-dev-secret-change-me',
  // Dev-only helpers (OTP peek) are NEVER active in production mode,
  // even if DEV_MODE is accidentally left on in the environment.
  devMode: env.NODE_ENV !== 'production' && env.DEV_MODE !== 'false',
  defaultCurrency: env.DEFAULT_CURRENCY || 'ETB',
  nodeEnv: env.NODE_ENV || 'development',
  // True when running as a Cloudflare Worker (see server/worker.js).
  // Static file serving and local disk uploads are disabled in that mode.
  worker: env.ZEMEN_WORKER === '1',

  // ── identity / anti-sybil limits (ETB) ────────────────────────────
  // Deals above this amount require a verified identity on both sides.
  freeDealThresholdEtb: Number(env.FREE_DEAL_THRESHOLD_ETB || 500),
  // Total lifetime deal volume an unverified account may accrue before
  // verification is mandatory.
  unverifiedLifetimeVolumeEtb: Number(env.UNVERIFIED_LIFETIME_VOLUME_ETB || 5000),

  // ── SMS provider (console | twilio | africastalking) ──────────────
  smsProvider: env.SMS_PROVIDER || 'console',
  // Reject phone numbers the provider flags as VoIP/virtual. Raises the
  // cost of sybil accounts but is not perfect — VOIP detection misses
  // some numbers, so this is a deterrent, not a guarantee.
  smsVoipBlock: env.SMS_VOIP_BLOCK !== 'false',

  // JWT session lifetime.
  jwtTtl: env.JWT_TTL || '7d',
};

/** Absolute path to the `server` package root. */
// import.meta.url is not a usable URL base on Cloudflare Workers, so
// fall back to a placeholder (only used for local disk paths there).
export const serverRoot = new URL('..', import.meta.url || 'file:///zemen/server/').pathname.replace(/^\/([A-Za-z]:)/, '$1');
