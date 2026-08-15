import 'dotenv/config';

const env = process.env;

export const DEV_JWT_SECRET = 'zemen-dev-secret-change-me';

export const config = {
  port: Number(env.PORT || 3001),
  databaseUrl: (env.DATABASE_URL || '').trim(),
  dbFile: env.DB_FILE || './data/zemen.db',
  // In production the JWT secret MUST come from the environment —
  // validateConfig() refuses to boot otherwise. The dev default exists
  // only so a fresh checkout can run locally with zero config.
  jwtSecret: env.JWT_SECRET || DEV_JWT_SECRET,
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
  // 'console' is the zero-config dev stub and is REJECTED in production
  // by validateConfig(). Real providers read their credentials from the
  // environment with no hardcoded fallbacks.
  smsProvider: env.SMS_PROVIDER || 'console',
  // Reject phone numbers the provider flags as VoIP/virtual. Raises the
  // cost of sybil accounts but is not perfect — VOIP detection misses
  // some numbers, so this is a deterrent, not a guarantee.
  smsVoipBlock: env.SMS_VOIP_BLOCK !== 'false',

  // ── payments provider (stub | chapa) ──────────────────────────────
  // Non-custodial by design: Zemen never holds funds. 'chapa' uses
  // Chapa's hosted checkout + HMAC-signed webhooks — Zemen records the
  // provider-confirmed state. 'stub' is the local dev stand-in and is
  // REJECTED in production by validateConfig().
  paymentProvider: env.PAYMENT_PROVIDER || 'stub',
  chapa: {
    apiUrl: env.CHAPA_API_URL || 'https://api.chapa.global',
    secretKey: env.CHAPA_SECRET_KEY || '',
    webhookSecret: env.CHAPA_WEBHOOK_SECRET || '',
  },

  // JWT session lifetime.
  jwtTtl: env.JWT_TTL || '7d',
};

/** Absolute path to the `server` package root. */
// import.meta.url is not a usable URL base on Cloudflare Workers, so
// fall back to a placeholder (only used for local disk paths there).
export const serverRoot = new URL('..', import.meta.url || 'file:///zemen/server/').pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * Startup configuration validation (workstream "secrets and env").
 *
 * Returns a list of problems ({ name, message }). An empty list means
 * the process is safe to boot. In development almost nothing is
 * required; in production every item below is mandatory so the server
 * never boots in a half-configured state — a missing key fails loudly
 * at startup with a clear list, not later with a confusing 500.
 */
export function validateConfig() {
  const problems = [];
  const isProd = env.NODE_ENV === 'production';
  if (!isProd) return problems; // dev/demo: zero-config startup

  // 1. JWT secret — never the dev default, and long enough to matter.
  const jwt = config.jwtSecret;
  if (!jwt) problems.push({ name: 'JWT_SECRET', message: 'must be set in production' });
  else if (jwt === DEV_JWT_SECRET) problems.push({ name: 'JWT_SECRET', message: 'must not be the development default' });
  else if (jwt.length < 32) problems.push({ name: 'JWT_SECRET', message: 'should be at least 32 characters' });

  // 2. SMS — a real gateway is mandatory; the console stub is a dev
  // convenience and must never reach production.
  if (config.smsProvider === 'console') {
    problems.push({ name: 'SMS_PROVIDER', message: 'must be twilio or africastalking in production (console stub is dev-only)' });
  } else if (config.smsProvider === 'africastalking') {
    if (!env.AFRICASTALKING_API_KEY) problems.push({ name: 'AFRICASTALKING_API_KEY', message: 'required when SMS_PROVIDER=africastalking' });
    if (!env.AFRICASTALKING_USERNAME) problems.push({ name: 'AFRICASTALKING_USERNAME', message: 'required when SMS_PROVIDER=africastalking' });
  } else if (config.smsProvider === 'twilio') {
    if (!env.TWILIO_ACCOUNT_SID) problems.push({ name: 'TWILIO_ACCOUNT_SID', message: 'required when SMS_PROVIDER=twilio' });
    if (!env.TWILIO_AUTH_TOKEN) problems.push({ name: 'TWILIO_AUTH_TOKEN', message: 'required when SMS_PROVIDER=twilio' });
    if (!env.TWILIO_FROM) problems.push({ name: 'TWILIO_FROM', message: 'required when SMS_PROVIDER=twilio' });
  } else {
    problems.push({ name: 'SMS_PROVIDER', message: `unknown provider "${config.smsProvider}"` });
  }

  // 3. Payments — a real provider is mandatory; the stub is dev-only.
  if (config.paymentProvider === 'stub') {
    problems.push({ name: 'PAYMENT_PROVIDER', message: 'must be chapa in production (stub is dev-only)' });
  } else if (config.paymentProvider === 'chapa') {
    if (!config.chapa.secretKey) problems.push({ name: 'CHAPA_SECRET_KEY', message: 'required when PAYMENT_PROVIDER=chapa' });
    if (!config.chapa.webhookSecret) problems.push({ name: 'CHAPA_WEBHOOK_SECRET', message: 'required when PAYMENT_PROVIDER=chapa' });
  } else {
    problems.push({ name: 'PAYMENT_PROVIDER', message: `unknown provider "${config.paymentProvider}"` });
  }

  return problems;
}

/** Throw a formatted error listing every missing/misconfigured var. */
export function assertValidConfig() {
  const problems = validateConfig();
  if (problems.length) {
    const list = problems.map((p) => `  • ${p.name} — ${p.message}`).join('\n');
    const err = new Error(`Zemen refuses to start: production configuration is incomplete.\n${list}`);
    err.status = 500;
    err.configProblems = problems;
    throw err;
  }
}
