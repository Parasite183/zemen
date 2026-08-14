// ─────────────────────────────────────────────────────────────────────
// Moderator review screen click-through (Puppeteer + installed Chrome).
// Drives the REAL web UI end-to-end as Lidya (moderator & staff):
//   login → moderator page renders every section (dispute queue,
//   identity reviews, fraud clusters, flagged accounts) → open a
//   cluster member's profile → re-run fraud checks → reject then
//   approve Bekele's pending ID document → verify the queue updates.
//
// Self-sufficient: provisions its own demo data over the API first
// (an uploaded document for pending-verification Bekele + 3 fresh
// accounts sharing a device fingerprint, which the screen clusters),
// then restores the DB to the seeded state afterwards.
// Saves screenshots to server/scripts/shots/ and prints a step log.
//
//   Requires: dev stack running (api :3001, web :5173) + seeded DB.
//
//   node server/scripts/mod-review-smoke.js
// ─────────────────────────────────────────────────────────────────────
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { writeTestPng } from './lib/png.js';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const API = process.env.API_BASE || 'http://localhost:3001';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const BEKELE_PHONE = '+251911000003';       // seeded as pending verification
const SARA_PHONE = '+251911000002';         // seeded as verified — dispute fixture
const ABEBE_PHONE = '+251911000001';        // seeded as verified — dispute fixture
const FIXTURE_DEAL = 'Smoke suite dispute fixture'; // must appear in the modqueue
const CLUSTER_PHONES = ['+251990000011', '+251990000012', '+251990000013'];

// The open dispute raised in setup — tracked so cleanup can remove its
// ledger entries (newest-first) without breaking the hash chain.
let fixture = { dealId: 0, ledgerBefore: 0 };
const shotsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(shotsDir, { recursive: true });
const ID_PNG = path.join(shotsDir, 'mod-review-id.png');

const log = (s) => console.log(`  ${s}`);
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; log(`${cond ? '✔' : '✖'} ${name}`); };
let shot = 0;
const snap = (page, name) => page.screenshot({ path: path.join(shotsDir, `m-${String(++shot).padStart(2, '0')}-${name}.png`) });
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

// ── API helpers (demo-data provisioning) ─────────────────────────────
async function j(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function apiLogin(phone, device = '') {
  await j('/api/auth/request-otp', { method: 'POST', body: JSON.stringify({ phone }) });
  const { code } = await j(`/api/auth/dev/otp?phone=${encodeURIComponent(phone)}`);
  if (!code) throw new Error(`no dev OTP for ${phone}`);
  const { token } = await j('/api/auth/verify-otp', { method: 'POST', body: JSON.stringify({ phone, code, device }) });
  return token;
}

/** Restore the seeded state: Bekele back to pending, cluster accounts gone, fixture dispute removed. */
function cleanup() {
  const db = new Database(path.resolve('server/data/zemen.db'));
  // The fixture dispute + its deal + the 3 ledger entries we appended
  // (id > ledgerBefore are exactly ours — deleting newest rows keeps the
  // remaining chain continuous, so verifyChain stays valid).
  if (fixture.dealId) {
    db.prepare('DELETE FROM ledger WHERE id > ?').run(fixture.ledgerBefore);
    db.prepare('DELETE FROM disputes WHERE transaction_id = ?').run(fixture.dealId);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(fixture.dealId);
  }
  fixture = { dealId: 0, ledgerBefore: 0 };
  const bekele = db.prepare('SELECT id FROM users WHERE phone = ?').get(BEKELE_PHONE);
  if (bekele) {
    const docs = db.prepare('SELECT file_path FROM id_documents WHERE user_id = ?').all(bekele.id);
    db.prepare('DELETE FROM id_documents WHERE user_id = ?').run(bekele.id);
    db.prepare(`UPDATE users SET id_verification_status = 'pending', verified_at = NULL,
       id_doc_path = '', id_number_hash = '', id_phash = '', id_flag_reason = '' WHERE id = ?`).run(bekele.id);
    for (const doc of docs) {
      const rel = String(doc.file_path || '').replace(/^\/+uploads\//, '');
      if (rel) fs.rmSync(path.resolve('server/uploads', rel), { force: true });
    }
  }
  for (const phone of CLUSTER_PHONES) {
    const user = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
    if (user) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM reputation_scores WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
  }
  db.close();
}

/** Provision the demo data the review screen needs (idempotent). */
async function setup() {
  cleanup(); // never inherit leftovers from an interrupted run
  writeTestPng(ID_PNG);

  // 1) A pending-verification document WITH an image (Bekele is seeded 'pending').
  const bekeleToken = await apiLogin(BEKELE_PHONE);
  const fd = new FormData();
  fd.append('document', new Blob([fs.readFileSync(ID_PNG)], { type: 'image/png' }), 'bekele-national-id.png');
  fd.append('docType', 'national_id');
  fd.append('idNumber', `ID-${Date.now().toString(36).toUpperCase()}`); // unique per run
  fd.append('phash', '');
  const up = await fetch(`${API}/api/me/id-document`, {
    method: 'POST', headers: { authorization: `Bearer ${bekeleToken}` }, body: fd,
  });
  if (!up.ok) throw new Error(`Bekele doc upload failed: ${up.status}`);
  log('  setup: Bekele pending document uploaded');

  // 2) Three fresh accounts sharing a device fingerprint → device + IP clusters.
  for (const phone of CLUSTER_PHONES) await apiLogin(phone, 'mod-review-fp');
  log('  setup: 3 fresh accounts share a device fingerprint');

  // 3) An OPEN dispute for the queue — a fresh seed has none (the seed's
  // dispute is resolved). Raise one for real over the API: Sara creates a
  // deal with Abebe, Abebe accepts, Sara disputes it. Record the ledger
  // boundary BEFORE our appends so cleanup can unwind them safely.
  {
    const db = new Database(path.resolve('server/data/zemen.db'), { readonly: true });
    fixture.ledgerBefore = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ledger').get().m;
    db.close();
  }
  const saraToken = await apiLogin(SARA_PHONE);
  const abebeToken = await apiLogin(ABEBE_PHONE);
  const { deal } = await j('/api/deals', {
    method: 'POST', headers: { authorization: `Bearer ${saraToken}` },
    body: JSON.stringify({ phone: ABEBE_PHONE, description: FIXTURE_DEAL, deliverable: 'fixture', amount: 1500 }),
  });
  fixture.dealId = deal.id;
  await j(`/api/deals/${fixture.dealId}/respond`, {
    method: 'POST', headers: { authorization: `Bearer ${abebeToken}` },
    body: JSON.stringify({ accept: true }),
  });
  await j('/api/disputes', {
    method: 'POST', headers: { authorization: `Bearer ${saraToken}` },
    body: JSON.stringify({ transaction_id: fixture.dealId, reason: 'Smoke-suite fixture dispute' }),
  });
  log('  setup: open dispute raised for the modqueue');
}

async function login(page) {
  log('login(Lidya) → goto /login');
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle0' });
  await clickText(page, 'Lidya Hailu (moderator)');
  await clickText(page, 'Send code');
  await sleep(500);
  await clickText(page, 'Dev: autofill code');
  await sleep(300);
  await clickText(page, 'Verify');
  await page.waitForFunction(() => !location.pathname.includes('/login'), { timeout: 10000 });
  log(`  after verify: ${page.url()}`);
}

async function main() {
  await setup();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--window-size=430,860'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 860 }); // mobile-first viewport
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
        await page.screenshot({ path: path.join(shotsDir, 'm-crash-state.png') });
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
  // ── 1. Lidya logs in and opens the moderator page ─────────────────
  log('\n── Lidya: login → moderator page ──');
  await login(page);
  await page.goto(`${WEB}/moderator`, { waitUntil: 'networkidle0' });
  await waitText(page, 'Moderation');
  ok('Moderator page renders', true);
  await snap(page, '01-moderator-top');

  // Dispute queue — the fixture dispute raised in setup (Sara ↔ Abebe)
  await waitText(page, 'Moderation queue');
  await waitText(page, FIXTURE_DEAL);
  ok('Dispute queue lists the open dispute', true);

  // Identity reviews — Bekele pending with an uploaded document image
  await waitText(page, 'Identity reviews · 1');
  await waitText(page, 'Bekele Alemu');
  await waitText(page, 'Pending review');
  const imgVisible = await page.$$eval('img[src^="/uploads/ids/"]', (imgs) => imgs.length);
  ok('Identity queue shows the pending doc with an image', imgVisible >= 1);
  const hasStaffButtons = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Approve')) &&
    [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Reject'))
  );
  ok('Approve/Reject buttons visible for staff', hasStaffButtons);

  // Fraud clusters — device + IP cluster of the 3 fresh accounts
  await waitText(page, 'Fraud clusters · 2');
  await waitText(page, 'Device cluster — 3 accounts share a fingerprint');
  await waitText(page, 'IP cluster — 3 accounts share an IP range');
  const chipCount = await page.$$eval('a[href^="/u/"]', (as) => as.filter((a) => a.className.includes('rounded-full')).length);
  ok(`Cluster member chips render (${chipCount} found)`, chipCount >= 6);
  await snap(page, '02-moderator-clusters');

  // Flagged accounts — the one-sided concentration example. The exact
  // count is intentionally NOT pinned: ui-smoke runs add completed
  // Sara⇄Abebe deals, and once they cross the 3-deal threshold the seed
  // baseline grows (2 → 4). Assert the section renders its signal.
  await waitText(page, 'Flagged accounts ·');
  await waitText(page, 'concentration');
  ok('Flagged accounts section lists concentration flags', true);
  await snap(page, '03-moderator-flagged');

  // ── 2. Open a cluster member's profile from a chip ────────────────
  log('\n── Cluster member chip → profile ──');
  const clicked = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('a[href^="/u/"]')].find((a) => a.className.includes('rounded-full'));
    if (chip) { chip.click(); return chip.getAttribute('href'); }
    return null;
  });
  await page.waitForFunction(() => location.pathname.startsWith('/u/'), { timeout: 8000 });
  ok(`Chip navigates to member profile (${clicked})`, true);
  await waitText(page, 'Unnamed user');
  await snap(page, '04-member-profile');
  await page.goto(`${WEB}/moderator`, { waitUntil: 'networkidle0' });
  await waitText(page, 'Moderation');

  // ── 3. Re-run fraud checks ────────────────────────────────────────
  log('\n── Re-run fraud checks ──');
  // Baseline can be anything (see the flagged-section note above), but
  // the refresh must merge EXACTLY the 3 cluster accounts we created.
  const flaggedCount = () =>
    page.evaluate(() => {
      const h = [...document.querySelectorAll('h2')].find((e) => e.textContent.includes('Flagged accounts'));
      const m = h ? h.textContent.match(/(\d+)/) : null;
      return m ? Number(m[1]) : 0;
    });
  const countBefore = await flaggedCount();
  await clickText(page, 'Re-run fraud checks');
  await page.waitForFunction(
    (prev) => {
      const h = [...document.querySelectorAll('h2')].find((e) => e.textContent.includes('Flagged accounts'));
      const m = h ? h.textContent.match(/(\d+)/) : null;
      return m ? Number(m[1]) === prev + 3 : false;
    },
    { timeout: 12000 },
    countBefore
  );
  ok('Fraud refresh completes and merges cluster flags', countBefore >= 1);
  await snap(page, '05-after-refresh');

  // ── 4. Reject then approve Bekele's document ──────────────────────
  log('\n── Staff decision: reject → approve ──');
  await clickText(page, 'Reject');
  // doc_status flips to rejected → badge leaves "Verification pending"
  // and becomes "Not verified" ("Flagged" alone would match the heading)
  await waitText(page, 'Not verified', 9000);
  const rejectedBody = await page.evaluate(() => document.body.innerText);
  ok('Reject updates the document row to flagged', rejectedBody.includes('Pending review') === false);
  await snap(page, '06-after-reject');
  await clickText(page, 'Approve');
  await waitText(page, 'No identity documents awaiting review.', 9000);
  ok('Approve clears the review queue', true);
  await snap(page, '07-after-approve');

  ok('No page errors across the whole flow', consoleErrors.length === 0);

  log(`\n  UI result: ${pass} passed, ${fail} failed`);
  log(`  Console errors: ${consoleErrors.length ? consoleErrors.slice(0, 8).join(' | ') : 'none'}`);
}

main().catch(async (e) => {
  console.error('Mod review smoke crashed:', e.message.slice(0, 200));
  process.exit(1);
});
