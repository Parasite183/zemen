// ─────────────────────────────────────────────────────────────────────
// One-command Cloudflare deploy:
//   1. deploy the Express API as a Worker (wrangler deploy)
//   2. build the React app (vite build)
//   3. upload web/dist to Cloudflare Pages
//
//   /api/* and /uploads/* are proxied to the Worker by a Pages Function
//   (functions/_middleware.js at the repo root — wrangler resolves the
//   Functions directory as <cwd>/functions) — Cloudflare Pages
//   `_redirects` cannot proxy to external domains, so a Function is
//   required. Everything else is served as static assets with Pages'
//   native SPA fallback.
//
//   Prereqs:  npx wrangler login  (once)
//             D1 + R2 created and referenced in wrangler.jsonc
//
//   Usage:  npm run deploy
// ─────────────────────────────────────────────────────────────────────
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT = 'zemen';
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
const runCapture = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' });

// 1. API worker
console.log('\n── 1/4 Deploying API worker ─────────────────────────');
const deployOut = runCapture('npx wrangler deploy 2>&1');
console.log(deployOut);

// Find the worker's public URL (e.g. https://zemen-api.<account>.workers.dev).
// Match multi-segment hostnames: workers.dev subdomains are
// <name>.<account>.workers.dev, and account slugs can contain digits/dots.
const m = deployOut.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/);
const workerUrl = m ? m[0] : null;
if (!workerUrl) {
  console.error('✖ Could not determine the Worker URL. Deploy the Pages site with');
  console.error('  `npx wrangler pages deploy web/dist --project-name zemen` after');
  console.error('  updating the WORKER constant in functions/_middleware.js.');
  process.exit(1);
}
console.log(`  Worker URL: ${workerUrl}`);

// 2. Build the frontend
console.log('\n── 2/4 Building web app ──────────────────────────────');
run('npm run build -w web');

// 3. Pages
console.log('\n── 3/4 Ensuring Pages project exists ────────────────');
try {
  runCapture(`npx wrangler pages project create ${PROJECT} --production-branch main`);
} catch {
  console.log('  (project already exists)');
}
console.log('\n── 4/4 Deploying to Pages ────────────────────────────');
run(`npx wrangler pages deploy web/dist --project-name ${PROJECT}`);

console.log('\n✅ Deployed. Frontend on Pages (SPA fallback), API proxied to the Worker.');
