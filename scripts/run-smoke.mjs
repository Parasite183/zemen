// ─────────────────────────────────────────────────────────────────────
// One-command UI regression suite.
//   npm run smoke
//
// Seeds the demo DB (no-op if already seeded), boots the dev stack
// (api :3001, web :5173) or reuses one that is already running, then
// runs every Puppeteer smoke script sequentially — failing fast on the
// first red script — and shuts down only the processes it spawned.
//
// Smoke scripts (each drives the real UI with installed Chrome):
//   server/scripts/ui-smoke.js            deal flow: Sara ⇄ Abebe + escrow + report
//   server/scripts/mod-review-smoke.js    moderator review screen
//   server/scripts/id-verify-smoke.js     fresh signup → doc upload → staff approve
//   server/scripts/fresh-user-pages-smoke.js  null-reputation page matrix
// ─────────────────────────────────────────────────────────────────────
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://localhost:3001';
const API_HEALTH = `${API}/api/health`; // the API serves no / route in dev
const WEB = 'http://localhost:5173';
const SMOKES = [
  'server/scripts/ui-smoke.js',
  'server/scripts/mod-review-smoke.js',
  'server/scripts/id-verify-smoke.js',
  'server/scripts/fresh-user-pages-smoke.js',
];
const log = (s) => console.log(`\n▸ ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(url, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* keep polling */ }
    await sleep(400);
  }
  return false;
}

function runNode(args, cwd = ROOT) {
  return spawnSync('node', args, { cwd, stdio: 'inherit' });
}

/** Kill a process and its whole tree (taskkill /T on Windows). */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

// ── 1. seed (idempotent — skips when already seeded) ────────────────
log('Seeding the demo database (no-op if already seeded)');
const seed = runNode(['src/seed.js'], path.join(ROOT, 'server'));
if (seed.status !== 0) { console.error('✖ seed failed'); process.exit(2); }

// ── 2. stack: reuse a running one, otherwise boot our own ───────────
const apiUp = await up(API_HEALTH, 3000);
const webUp = await up(WEB, 3000);
let children = [];
if (apiUp && webUp) {
  log('Dev stack already running — reusing it (leaving it up).');
} else if (apiUp || webUp) {
  console.error('✖ Only one of api/web is up — stop the partial dev stack and re-run.');
  process.exit(2);
} else {
  log('Booting dev stack (api :3001, web :5173)…');
  const serverChild = spawn('node', ['src/index.js'], {
    cwd: path.join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const viteChild = spawn('node', [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')], {
    cwd: path.join(ROOT, 'web'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  children = [serverChild, viteChild];
  let out = '';
  for (const c of children) {
    c.stdout?.on('data', (d) => { out += d; });
    c.stderr?.on('data', (d) => { out += d; });
  }
  if (!((await up(API_HEALTH)) && (await up(WEB)))) {
    console.error('✖ dev stack failed to start. Last output:\n');
    console.error(out.split('\n').slice(-25).join('\n'));
    children.forEach((c) => killTree(c.pid));
    process.exit(2);
  }
  log('Dev stack is up.');
}

// ── 3. run the smoke scripts sequentially, fail fast ────────────────
let failed = null;
for (const s of SMOKES) {
  log(`Running ${s}`);
  const r = runNode([s]);
  if (r.status !== 0) { failed = s; break; }
}

// ── 4. teardown: only shut down what we spawned ─────────────────────
if (children.length) {
  log('Shutting down the dev stack.');
  children.forEach((c) => killTree(c.pid));
  await sleep(1000);
}

if (failed) { console.error(`\n✖ smoke suite FAILED at ${failed}`); process.exit(1); }
console.log('\n✔ smoke suite passed — all 4 scripts green.');
