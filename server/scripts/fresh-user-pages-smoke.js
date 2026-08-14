// ─────────────────────────────────────────────────────────────────────
// Fresh-user page matrix (Puppeteer + installed Chrome).
// Regression guard for the null-reputation pitfall: a brand-new account
// has no reputation_scores row, so /api/auth/me and /api/users/:id
// return reputation: null. Pages used to treat null as "not loaded"
// (infinite spinner) or dereference it (crash). This script signs up a
// throwaway user, verifies they really have no reputation row, then
// drives EVERY page that consumes reputation and asserts each one
// renders its content with zero page errors.
//
//   Pages: Dashboard /, /deals, /disputes, /u/:id (public profile),
//          /r/:token (trust report), /profile
//
// Cleans up after itself (deletes the throwaway account + document).
// Saves screenshots to server/scripts/shots/ and prints a step log.
//
//   Requires: dev stack running (api :3001, web :5173) + seeded DB.
//
//   node server/scripts/fresh-user-pages-smoke.js
// ─────────────────────────────────────────────────────────────────────
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const FRESH_PHONE = '+251990000099';
const FRESH_NAME = 'Matrix User';
const shotsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

const log = (s) => console.log(`  ${s}`);
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; log(`${cond ? '✔' : '✖'} ${name}`); };
let shot = 0;
const snap = (page, name) => page.screenshot({ path: path.join(shotsDir, `fp-${String(++shot).padStart(2, '0')}-${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clickText = (page, label) =>
  page.waitForFunction(
    (t) => [...document.querySelectorAll('button, a, [role="button"]')].some((el) => el.textContent.includes(t)),
    { timeout: 9000 },
    label
  ).then(() =>
    page.evaluate((t) => {
      const el = [...document.querySelectorAll('button, a, [role="button"]')].find((e) => e.textContent.includes(t));
      if (el) { el.click(); return true; }
      return false;
    }, label)
  ).then((clicked) => { if (!clicked) throw new Error(`Could not click "${label}"`); });

const waitText = (page, needle, timeout = 9000) =>
  page.waitForFunction((n) => document.body.innerText.toLowerCase().includes(n.toLowerCase()), { timeout }, needle);

/** Sign in via the phone flow (fresh number), with dev OTP autofill. */
async function loginPhone(page) {
  log(`login(${FRESH_PHONE})`);
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[inputmode="tel"]', FRESH_PHONE);
  await clickText(page, 'Send code');
  await sleep(400);
  await clickText(page, 'Dev: autofill code');
  await sleep(200);
  await clickText(page, 'Verify');
  await page.waitForFunction(() => !location.pathname.includes('/login'), { timeout: 10000 });
  log(`  → ${page.url()}`);
}

/** Remove the throwaway account + document from the dev DB (idempotent). */
function cleanup() {
  const db = new Database(path.resolve('server/data/zemen.db'));
  const user = db.prepare('SELECT id FROM users WHERE phone = ?').get(FRESH_PHONE);
  if (user) {
    const doc = db.prepare('SELECT file_path FROM id_documents WHERE user_id = ?').get(user.id);
    db.prepare('DELETE FROM id_documents WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM reputation_scores WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    if (doc?.file_path) {
      const rel = String(doc.file_path).replace(/^\/+uploads\//, '');
      fs.rmSync(path.resolve('server/uploads', rel), { force: true });
    }
    log('  cleanup: removed throwaway account + document');
  }
  db.close();
}

async function main() {
  cleanup(); // pre-flight: never inherit a leftover account from an interrupted run
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--window-size=430,860'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 860 });
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err}`));

  try {
    try {
      await run(page, consoleErrors);
    } catch (e) {
      // dump page state BEFORE the browser closes so failures are diagnosable
      try {
        const url = page.url();
        const body = await page.evaluate(() => document.body.innerText.slice(0, 500).replace(/\n+/g, ' | '));
        console.error(`  page state: ${url}\n  ${body}`);
        console.error(`  console errors: ${consoleErrors.length ? consoleErrors.slice(0, 5).join(' || ') : 'none'}`);
        await page.screenshot({ path: path.join(shotsDir, 'fp-crash-state.png') });
      } catch {}
      throw e;
    }
  } finally {
    await browser.close();
    cleanup();
  }
  process.exit(fail ? 1 : 0);
}

async function run(page, consoleErrors) {
  // ── 1. Fresh signup + onboarding ──────────────────────────────────
  log('\n── Fresh signup + onboarding ──');
  await loginPhone(page);
  if (page.url().includes('/onboarding')) {
    await waitText(page, 'Welcome to Zemen');
    await page.type('input[placeholder="Abebe Kebede"]', FRESH_NAME);
    await clickText(page, 'Small trade');
    await page.type('textarea', 'fresh-user page matrix');
    await snap(page, '01-onboarding');
    await clickText(page, 'Create my profile');
  }
  await waitText(page, 'Hello, Matrix');
  ok('Fresh user signs up and completes onboarding', true);

  // Precondition: the pitfall only bites when there is NO reputation row.
  const db = new Database(path.resolve('server/data/zemen.db'), { readonly: true });
  const user = db.prepare('SELECT id, report_token FROM users WHERE phone = ?').get(FRESH_PHONE);
  const repRow = db.prepare('SELECT user_id FROM reputation_scores WHERE user_id = ?').get(user.id);
  db.close();
  ok('Fresh user has no reputation row (null via API — the pitfall precondition)', !repRow);

  // ── 2. Every reputation-consuming page must render, no page errors ──
  const matrix = [
    ['Dashboard', '/', 'Hello, Matrix'],
    ['Deals', '/deals', 'No deals yet. Start one!'],
    ['Disputes', '/disputes', 'No disputes involving you.'],
    ['Public profile', `/u/${user.id}`, FRESH_NAME],
    ['Trust report', `/r/${user.report_token}`, 'Trust report'],
    ['Profile', '/profile', 'Upload ID document'],
  ];

  for (const [label, path, needle] of matrix) {
    log(`\n── ${label} (${path}) ──`);
    const before = consoleErrors.length;
    await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle0', timeout: 20000 }).catch(() => {});
    // the content needle only appears once the page leaves its spinner
    await waitText(page, needle, 10000);
    ok(`${label} renders (${needle})`, true);
    ok(`${label} has no page errors`, consoleErrors.length === before);
    await snap(page, `02-${label.toLowerCase().replace(/\s+/g, '-')}`);
  }

  // Any page error anywhere is a failure, not just a log (non-zero exit).
  ok('No page errors across the whole flow', consoleErrors.length === 0);

  log(`\n  UI result: ${pass} passed, ${fail} failed`);
  log(`  Console errors: ${consoleErrors.length ? consoleErrors.slice(0, 8).join(' | ') : 'none'}`);
}

main().catch(async (e) => {
  console.error('Fresh-user pages smoke crashed:', e.message.slice(0, 200));
  process.exit(1);
});
