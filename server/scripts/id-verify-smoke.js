// ─────────────────────────────────────────────────────────────────────
// Full identity verification click-through (Puppeteer + installed Chrome).
// Drives the REAL web UI end-to-end:
//   fresh signup (+251990000099) → onboarding → uploads an ID document
//   from /profile → staff (Lidya) approves it in the moderator review
//   queue → the fresh user's profile flips to Verified.
// Also guards the null-reputation regression: a brand-new account's
// profile must render (stats + upload card), not spin or crash.
// Cleans up after itself (deletes the throwaway account + document).
// Saves screenshots to server/scripts/shots/ and prints a step log.
//
//   Requires: dev stack running (api :3001, web :5173) + seeded DB.
//
//   node server/scripts/id-verify-smoke.js
// ─────────────────────────────────────────────────────────────────────
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { writeTestPng } from './lib/png.js';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const FRESH_PHONE = '+251990000099';
const FRESH_NAME = 'New User Test';
const shotsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(shotsDir, { recursive: true });
// A small but non-trivial PNG (8×6 gradient-ish noise) as the "scan".
const ID_PNG = path.join(shotsDir, 'fresh-user-id.png');

const log = (s) => console.log(`  ${s}`);
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; log(`${cond ? '✔' : '✖'} ${name}`); };
let shot = 0;
const snap = (page, name) => page.screenshot({ path: path.join(shotsDir, `id-${String(++shot).padStart(2, '0')}-${name}.png`) });
let PAGE = null;
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

/** Sign in via the phone flow (fresh number or existing), with dev OTP autofill. */
async function loginPhone(page, phone) {
  log(`login(${phone})`);
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[inputmode="tel"]', phone);
  await clickText(page, 'Send code');
  await sleep(400);
  await clickText(page, 'Dev: autofill code');
  await sleep(200);
  await clickText(page, 'Verify');
  await page.waitForFunction(() => !location.pathname.includes('/login'), { timeout: 10000 });
  log(`  → ${page.url()}`);
}

/** Sign out via Settings (gear in the header). */
async function signOut(page) {
  await page.waitForSelector('button[aria-label="settings"]', { timeout: 8000 });
  await page.click('button[aria-label="settings"]');
  await sleep(700);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => e.textContent.includes('Sign out')); if (b) b.click(); });
  await sleep(800);
}

/** Click the Approve button on the identity-review card for `name`. */
async function approveCard(page, name) {
  const clicked = await page.evaluate((n) => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes(n));
    const btn = card && [...card.querySelectorAll('button')].find((b) => b.textContent.includes('Approve'));
    if (btn) { btn.click(); return true; }
    return false;
  }, name);
  if (!clicked) throw new Error(`No Approve button on ${name}'s card`);
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
  writeTestPng(ID_PNG);
  cleanup(); // pre-flight: never inherit a leftover account from an interrupted run
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--window-size=430,860'] });
  const page = await browser.newPage();
  PAGE = page;
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
        await page.screenshot({ path: path.join(shotsDir, 'id-crash-state.png') });
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
    // ── 1. Fresh signup + onboarding ────────────────────────────────
    log('\n── Fresh signup → onboarding ──');
    await loginPhone(page, FRESH_PHONE);
    log('    step: onboarding rendered');
    await waitText(page, 'Welcome to Zemen');
    log('    step: filled name');
    await page.type('input[placeholder="Abebe Kebede"]', FRESH_NAME);
    log('    step: picked category');
    await clickText(page, 'Small trade');
    await page.type('textarea', 'Fresh signup for the identity flow test.');
    await snap(page, '01-onboarding');
    log('    step: submitting');
    await clickText(page, 'Create my profile');
    log('    step: awaiting dashboard');
    await waitText(page, 'Hello, New'); // greeting uses the first name only
    ok('Fresh user signs up and completes onboarding', true);

    // ── 1b. Fresh profile renders with a null reputation (regression) ──
    // A brand-new account has no reputation_scores row, so /api/auth/me
    // returns reputation: null. The profile page used to treat null as
    // "not loaded" and spin forever (`if (!rep) return <Spinner/>`), then
    // crashed on `rep.completion_rate`. Assert the page actually renders:
    // upload card visible (spinner gone) and the stats grid null-safe.
    log('\n── Fresh profile renders (null reputation regression) ──');
    const errsBeforeProfile = consoleErrors.length;
    await page.goto(`${WEB}/profile`, { waitUntil: 'networkidle0' });
    await waitText(page, 'Upload ID document', 10000); // would never appear while stuck on the spinner
    await waitText(page, 'Not verified');
    await waitText(page, 'Trust record');
    const statsText = await page.evaluate(() =>
      [...document.querySelectorAll('.grid > div')].slice(0, 4).map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join(' | ')
    );
    ok('Fresh profile renders stats without crashing', statsText.includes('0 completed') && statsText.includes('—'));
    ok('No page errors on the fresh profile', consoleErrors.length === errsBeforeProfile);
    await snap(page, '02-fresh-profile-renders');

    // ── 2. Upload an ID document from /profile ──────────────────────
    log('\n── Upload ID document ──');
    await page.goto(`${WEB}/profile`, { waitUntil: 'networkidle0' });
    await waitText(page, 'Not verified');
    await page.type('input[placeholder="e.g. 1234567890"]', 'ID-9988-0011');
    // puppeteer-core v25 removed page.setInputFiles — upload via the element handle
    const fileInput = await page.$('input[type="file"]');
    await fileInput.uploadFile(ID_PNG); // triggers upload
    await waitText(page, 'Document uploaded — under manual review', 15000);
    await waitText(page, 'Verification pending');
    ok('Document upload flips the profile to pending review', true);
    await snap(page, '02-profile-pending');

    // ── 3. Staff approves it in the moderator queue ─────────────────
    log('\n── Lidya approves the document ──');
    await signOut(page);
    await loginPhone(page, '+251911000004'); // Lidya
    await page.goto(`${WEB}/moderator`, { waitUntil: 'networkidle0' });
    await waitText(page, 'Identity reviews · 2'); // Bekele (pending) + fresh user
    await waitText(page, FRESH_NAME);
    const imgOk = await page.$$eval('img[src^="/uploads/ids/"]', (imgs) => imgs.length);
    ok('Review queue shows the fresh user with a document image', imgOk >= 1);
    await snap(page, '03-queue-before-approve');
    await approveCard(page, FRESH_NAME);
    await waitText(page, 'Identity reviews · 1', 12000); // fresh user approved → only Bekele left
    const bodyAfter = await page.evaluate(() => document.body.innerText);
    ok('Approve removes the user from the review queue', !bodyAfter.includes(FRESH_NAME));
    await snap(page, '04-queue-after-approve');

    // ── 4. Fresh user is now Verified ───────────────────────────────
    log('\n── Fresh user re-checks their profile ──');
    await signOut(page);
    await loginPhone(page, FRESH_PHONE);
    await page.goto(`${WEB}/profile`, { waitUntil: 'networkidle0' });
    await waitText(page, 'Verified', 10000);
    const body = await page.evaluate(() => document.body.innerText);
    ok('Profile now shows Verified (and no upload prompt)', body.includes('Verified') && !body.includes('Upload ID document'));
    await snap(page, '05-profile-verified');

    // Any page error anywhere in the flow is a failure, not just a log
    // (this is what catches a Profile crash regression with a non-zero exit).
    ok('No page errors across the whole flow', consoleErrors.length === 0);

    log(`\n  UI result: ${pass} passed, ${fail} failed`);
    log(`  Console errors: ${consoleErrors.length ? consoleErrors.slice(0, 8).join(' | ') : 'none'}`);
}

main().catch(async (e) => {
  console.error('ID verify smoke crashed:', e.message.slice(0, 200));
  process.exit(1);
});
