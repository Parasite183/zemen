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
};

/** Absolute path to the `server` package root. */
// import.meta.url is not a usable URL base on Cloudflare Workers, so
// fall back to a placeholder (only used for local disk paths there).
export const serverRoot = new URL('..', import.meta.url || 'file:///zemen/server/').pathname.replace(/^\/([A-Za-z]:)/, '$1');
