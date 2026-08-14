// ─────────────────────────────────────────────────────────────────────
// Cloudflare Workers runtime bootstrap.
//
// Must be the FIRST import in server/worker.js: ESM evaluates imports
// in order, so by the time config.js / db.js / app.js run, the bindings
// are on globalThis and the string env vars are mirrored into
// process.env — exactly like a normal Node environment.
// ─────────────────────────────────────────────────────────────────────
import { env } from 'cloudflare:workers';

// Bindings (DB, UPLOADS, ...) are consumed lazily by db.js / uploads.js
// / app.js via globalThis.
globalThis.__ZEMEN_BINDINGS = env;

// Mirror string vars + secrets into process.env so config.js behaves
// identically on Workers and on Node.
for (const [k, v] of Object.entries(env)) {
  if (typeof v === 'string') process.env[k] = v;
}

// Production semantics (disables the dev OTP-peek endpoint), but static
// file serving stays off — Cloudflare Pages handles the frontend.
process.env.NODE_ENV = 'production';
process.env.ZEMEN_WORKER = '1';
