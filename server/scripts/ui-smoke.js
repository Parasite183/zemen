// ─────────────────────────────────────────────────────────────────────
// UI click-through test (Puppeteer + installed Chrome).
// Drives the REAL web UI end-to-end:
//   Sara logs in → creates an escrow deal → Abebe logs in → accepts →
//   funds escrow → starts → delivers → Sara confirms → trust report.
// Saves screenshots to server/scripts/shots/ and prints a step log.
//
//   Local:  node server/scripts/ui-smoke.js
//           (dev stack running: api :3001, web :5173)
//   Prod:   npx wrangler tail zemen-api > /tmp/zemen-tail.log 2>&1 &  (once)
//           WEB_URL=https://zemen-7xt.pages.dev OTP_LOG=/tmp/zemen-tail.log \
//             node server/scripts/ui-smoke.js
//           (OTP codes are read from the Worker's live log instead of
//           the dev-only autofill helper)
// ─────────────────────────────────────────────────────────────────────
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const API_BASE = process.env.API_BASE || 'http://localhost:3001';
// When set, OTP codes are extracted from this file (wrangler tail output)
// instead of the dev-only autofill button — required for production runs.
const OTP_LOG = process.env.OTP_LOG || null;
const DEMO_PHONE = {
  'Sara Tesfaye': '+251911000002',
  'Abebe Kebede': '+251911000001',
  'Lidya Hailu (moderator)': '+251911000004',
};
const shotsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

const log = (s) => console.log(`  ${s}`);
let pass = 0, fail = 0;
const ok = (name, cond) => {
  cond ? pass++ : fail++;
  log(`${cond ? '✔' : '✖'} ${name}`);
};
let shot = 0;
const snap = (page, name) => page.screenshot({ path: path.join(shotsDir, `${String(++shot).padStart(2, '0')}-${name}.png`) });
let PAGE = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = (page) => page.evaluate(() => document.body.innerText);

/** Open Settings via the header gear (works on all viewports). */
async function goSettings(page) {
  await page.waitForSelector('button[aria-label="settings"]', { timeout: 8000 });
  await page.click('button[aria-label="settings"]');
  await sleep(700);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((e) => e.textContent.includes('Sign out')); if (b) b.click(); });
  await sleep(800);
}

/** Wait for + click the first button/link containing `label`. */
async function clickText(page, label) {
  await page.waitForFunction(
    (t) => [...document.querySelectorAll('button, a, [role="button"]')].some((el) => el.textContent.includes(t)),
    { timeout: 9000 },
    label
  );
  const clicked = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('button, a, [role="button"]')].find((e) => e.textContent.includes(t));
    if (el) { el.click(); return true; }
    return false;
  }, label);
  if (!clicked) throw new Error(`Could not click "${label}"`);
}

const waitText = (page, needle, timeout = 9000) =>
  page.waitForFunction((n) => document.body.innerText.includes(n), { timeout }, needle);

// Read an OTP for a phone from the wrangler tail log, ignoring anything
// written before `fromBytes` (so re-runs never pick up an old code).
// NOTE: `fromBytes` comes from statSync().size (BYTES) — the file must
// be sliced as a Buffer, not a string, or the 📱 emoji in the log (4
// bytes / 2 chars) shifts offsets and the newest codes get cut off.
async function readOtp(phone, fromBytes, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const re = /OTP for (\+[0-9]+):\s*(\d{6})/g;
  while (Date.now() < deadline) {
    const buf = fs.existsSync(OTP_LOG) ? fs.readFileSync(OTP_LOG) : Buffer.alloc(0);
    const tail = buf.subarray(fromBytes).toString('utf8');
    const matches = [...tail.matchAll(re)];
    const m = matches.find((mm) => mm[1] === phone);
    if (m) return m[2];
    await sleep(400);
  }
  throw new Error(`Timed out waiting for an OTP for ${phone} in ${OTP_LOG}`);
}

async function login(page, demoLabel) {
  log(`login(${demoLabel}) → goto /login`);
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle0' });
  log(`  url now: ${page.url()}`);
  await clickText(page, demoLabel);
  const fromOffset = OTP_LOG && fs.existsSync(OTP_LOG) ? fs.statSync(OTP_LOG).size : 0;
  await clickText(page, 'Send code');
  if (OTP_LOG) {
    const code = await readOtp(DEMO_PHONE[demoLabel], fromOffset);
    log(`  otp from log: ${code}`);
    await page.type('input[inputmode="numeric"]', code);
  } else {
    await sleep(500);
    await clickText(page, 'Dev: autofill code');
    // The autofill button fetches the code over the network and only
    // then fills the input — wait for it to land instead of a fixed
    // sleep, so a slow fetch can't leave Verify disabled (empty code)
    // and the login times out.
    await page.waitForFunction(
      () => (document.querySelector('input[inputmode="numeric"]')?.value || '').replace(/\D/g, '').length >= 6,
      { timeout: 8000 }
    );
  }
  await clickText(page, 'Verify');
  await page.waitForFunction(() => !location.pathname.includes('/login'), { timeout: 10000 });
  log(`  after verify: ${page.url()}`);
}

// Money-moving actions (fund escrow, confirm a large deal) trigger an
// inline re-auth card: click "Send me a code", grab the OTP (dev-only
// peek endpoint locally, wrangler tail log on production), type it, and
// Verify — the action then retries with the code attached.
async function handleActionOtp(page, phone) {
  log(`action-otp(${phone}) → modal`);
  await clickText(page, 'Send me a code');
  const fromOffset = OTP_LOG && fs.existsSync(OTP_LOG) ? fs.statSync(OTP_LOG).size : 0;
  await page.waitForSelector('input[inputmode="numeric"]', { timeout: 9000 });
  let code;
  if (OTP_LOG) {
    code = await readOtp(phone, fromOffset);
  } else {
    const peek = await fetch(`${API_BASE}/api/auth/dev/otp?phone=${encodeURIComponent(phone)}`).then((r) => r.json());
    code = peek.code;
    if (!code) throw new Error(`No dev action OTP for ${phone}`);
  }
  log(`  otp: ${code}`);
  await page.type('input[inputmode="numeric"]', code);
  await clickText(page, 'Verify');
  await sleep(600); // let the retried action settle before the next wait
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--window-size=430,860'] });
  const page = await browser.newPage();
  PAGE = page;
  await page.setViewport({ width: 430, height: 860 }); // mobile-first viewport
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('response', (r) => { if (r.status() >= 400) log(`HTTP ${r.status()} ${r.url()}`); });

  // ── 1. Sara logs in ───────────────────────────────────────────────
  log('\n── Sara Tesfaye: login + dashboard ──');
  await login(page, 'Sara Tesfaye');
  await waitText(page, 'Hello, Sara');
  ok('Sara lands on dashboard with greeting', true);
  await snap(page, '01-sara-dashboard');
  const statCards = await page.$$eval('.grid > div', (els) => els.slice(0, 4).map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  log(`     stats: ${statCards.join(' | ')}`);
  ok('4 stat cards render', statCards.length === 4);

  // ── 2. Sara creates a deal with escrow ────────────────────────────
  log('\n── Sara: create deal ──');
  const dealTitle = `Website maintenance ${Date.now()}`; // unique per run
  await clickText(page, 'New deal');
  await page.waitForSelector('input[placeholder*="+251"]', { timeout: 8000 });
  await page.type('input[placeholder*="+251"]', '+251911000001');
  await page.type('input[placeholder="What is this deal about?"]', dealTitle);
  await page.type('input[placeholder="What will be delivered?"]', '3 pages updated + training');
  await page.type('input[placeholder="15000"]', '4000');
  await snap(page, '02-new-deal-form');
  await clickText(page, 'Create deal');
  await waitText(page, 'waiting for the other party');
  ok('Deal created — waiting for acceptance', true);
  await snap(page, '03-deal-created');
  await clickText(page, 'View');
  await waitText(page, 'Awaiting response');
  ok('Deal detail shows status', true);

  // ── 3. Abebe accepts the terms ────────────────────────────────────
  log('\n── Abebe Kebede: accept terms ──');
  await goSettings(page);
  await login(page, 'Abebe Kebede');
  await waitText(page, 'Hello, Abebe');
  await waitText(page, 'Needs your attention');
  await snap(page, '04-abebe-dashboard-attention');
  await clickText(page, dealTitle);
  await waitText(page, 'Accept terms');
  await snap(page, '05-abebe-deal-pending');
  await clickText(page, 'Accept terms');
  await waitText(page, 'Start work');
  ok('Terms accepted (escrow funding is the payer\'s job)', true);

  // ── 4. Sara (payer) funds escrow ──────────────────────────────────
  log('\n── Sara: fund escrow ──');
  await goSettings(page);
  await login(page, 'Sara Tesfaye');
  await waitText(page, 'Hello, Sara');
  await waitText(page, 'Needs your attention');
  await clickText(page, dealTitle);
  await waitText(page, 'Fund escrow');
  await clickText(page, 'Fund escrow');
  await handleActionOtp(page, '+251911000002');
  await waitText(page, 'Funds held');
  ok('Escrow funded (funds held)', true);
  await snap(page, '06-escrow-funded');

  // ── 5. Abebe (provider) starts and delivers ───────────────────────
  log('\n── Abebe Kebede: start → deliver ──');
  await goSettings(page);
  await login(page, 'Abebe Kebede');
  await waitText(page, 'Hello, Abebe');
  await clickText(page, dealTitle);
  await waitText(page, 'Start work');
  await clickText(page, 'Start work');
  await waitText(page, 'Mark delivered');
  await clickText(page, 'Mark delivered');
  await waitText(page, 'Delivered');
  ok('Delivered → confirmation available', true);
  await snap(page, '07-delivered');

  // ── 6. Sara confirms → escrow released ────────────────────────────
  log('\n── Sara: confirm completion ──');
  await goSettings(page);
  await login(page, 'Sara Tesfaye');
  await waitText(page, 'Hello, Sara');
  await waitText(page, 'Needs your attention');
  await clickText(page, dealTitle);
  await waitText(page, 'Confirm completion');
  await clickText(page, 'Confirm completion');
  await handleActionOtp(page, '+251911000002');
  // 'Completed' is also a timeline step label, so wait for 'Released'
  // instead — it only appears after the confirm + escrow release render.
  await waitText(page, 'Released', 15000);
  ok('Deal completed and escrow released', true);
  await snap(page, '08-completed');

  // ── 5. Trust report ───────────────────────────────────────────────
  log('\n── Trust report ──');
  await clickText(page, 'Profile');
  await page.waitForSelector('a[href^="/r/"]', { timeout: 15000 });
  const reportHref = await page.$eval('a[href^="/r/"]', (a) => a.getAttribute('href'));
  await page.goto(`${WEB}${reportHref}`, { waitUntil: 'networkidle0' });
  await waitText(page, 'Print / save as PDF');
  await sleep(800);
  const reportHasHistory = (await bodyText(page)).includes('Sara Tesfaye') && (await bodyText(page)).toLowerCase().includes('completed');
  ok('Public trust report renders with history', reportHasHistory);
  await snap(page, '09-trust-report');

  // ── 6. Directory ──────────────────────────────────────────────────
  log('\n── Directory ──');
  await page.goto(`${WEB}/directory`, { waitUntil: 'networkidle0' });
  await waitText(page, 'Abebe Kebede');
  ok('Directory lists users', true);
  await snap(page, '10-directory');

  // ── 7. Amharic mode ───────────────────────────────────────────────
  log('\n── Amharic locale ──');
  await page.goto(`${WEB}/settings`, { waitUntil: 'networkidle0' });
  await clickText(page, 'አማርኛ (Amharic)');
  await sleep(500);
  const amShown = (await bodyText(page)).includes('ቋንቋ');
  ok('Amharic UI active', amShown);
  await snap(page, '11-amharic-settings');

  log(`\n  UI result: ${pass} passed, ${fail} failed`);
  log(`  Console errors: ${consoleErrors.length ? consoleErrors.slice(0, 5).join(' | ') : 'none'}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('UI smoke crashed:', e.message.slice(0, 200));
  if (PAGE) {
    try {
      const url = PAGE.url();
      const body = await PAGE.evaluate(() => document.body.innerText.slice(0, 400).replace(/\n+/g, ' | '));
      console.error(`  page state: ${url}\n  ${body}`);
      await PAGE.screenshot({ path: path.join(shotsDir, 'crash-state.png') });
    } catch {}
  }
  process.exit(1);
});
