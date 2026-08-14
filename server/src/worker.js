// ─────────────────────────────────────────────────────────────────────
// Cloudflare Workers entry point.
//
// Runs the existing Express app on the edge via workerd's node:http
// server support. The static frontend is served by Cloudflare Pages,
// which rewrites /api and /uploads to this Worker (see
// scripts/deploy-cloudflare.mjs).
//
//   Deploy:  npm run deploy:api   (or: npx wrangler deploy)
//   Local:   npx wrangler dev     (emulated D1 + R2 via Miniflare)
// ─────────────────────────────────────────────────────────────────────
import './worker-env.js';
import { buildApp } from './app.js';
import { httpServerHandler } from 'cloudflare:node';

// The DB + schema are initialised lazily on the first request (see the
// `config.worker` branch in app.js) — workerd forbids async I/O (e.g.
// D1 queries) in module global scope, so it cannot run at import time.
const app = buildApp();
app.listen(3000);

export default httpServerHandler({ port: 3000 });
