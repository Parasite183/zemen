import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
process.env.DB_FILE = ':memory:';

const { initDb, db } = await import('../src/db.js');
const { initSchema } = await import('../src/schema.js');
const { buildApp } = await import('../src/app.js');
const { issueSession } = await import('../src/auth.js');
const { nowIso } = await import('../src/crypto.js');

let server;
let base;

test('setup: in-memory app', async () => {
  await initDb();
  await initSchema();
  const app = buildApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

const post = (path, body, token) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

test('OTP request is rate-limited per IP (5/min → 429 on the 6th)', async () => {
  const phone = '+251911000001';
  let last;
  for (let i = 0; i < 5; i++) last = await post('/api/auth/request-otp', { phone });
  assert.equal(last.status, 200, 'first five requests pass');
  const sixth = await post('/api/auth/request-otp', { phone });
  assert.equal(sixth.status, 429, 'sixth request is limited');
  const body = await sixth.json();
  assert.equal(body.code, 'rate_limited');
  assert.ok(sixth.headers.get('retry-after'), '429 carries Retry-After');
});

test('OTP verify is rate-limited per IP', async () => {
  let last;
  for (let i = 0; i < 10; i++) {
    last = await post('/api/auth/verify-otp', { phone: '+251911000002', code: '000000' });
  }
  assert.equal(last.status, 401, 'wrong codes are rejected (not limited yet)');
  const eleventh = await post('/api/auth/verify-otp', { phone: '+251911000002', code: '000000' });
  assert.equal(eleventh.status, 429, 'eleventh verify attempt from one IP is limited');
});

test('deal creation is rate-limited per account (20/hour → 429 on the 21st)', async () => {
  const { lastId: a } = await db.run(
    `INSERT INTO users (phone, name, report_token, created_at) VALUES (?, 'LimiterA', 'RL-A', ?)`,
    ['+251911000011', nowIso()]
  );
  const bPhone = '+251911000012';
  await db.run(
    `INSERT INTO users (phone, name, report_token, created_at) VALUES (?, 'LimiterB', 'RL-B', ?)`,
    [bPhone, nowIso()]
  );
  const { token } = await issueSession({ id: a }, 'rate-limit-test', '10.0.0.1');

  const mk = () => post('/api/deals', { phone: bPhone, description: 'd', deliverable: 'x', amount: 100, escrow: false }, token);
  let last;
  for (let i = 0; i < 20; i++) last = await mk();
  assert.equal(last.status, 201, 'twenty deals pass');
  const twentyFirst = await mk();
  assert.equal(twentyFirst.status, 429, 'twenty-first deal is limited');
});

test('dispute creation is rate-limited per account', async () => {
  const { lastId: a } = await db.run(
    `INSERT INTO users (phone, name, report_token, created_at) VALUES (?, 'Disputer', 'RL-C', ?)`,
    ['+251911000013', nowIso()]
  );
  const { lastId: b } = await db.run(
    `INSERT INTO users (phone, name, report_token, created_at) VALUES (?, 'Disputee', 'RL-D', ?)`,
    ['+251911000014', nowIso()]
  );
  const bPhone = '+251911000014';
  const { token } = await issueSession({ id: a }, 'rate-limit-test', '10.0.0.2');
  const { token: bToken } = await issueSession({ id: b }, 'rate-limit-test', '10.0.0.3');

  // One deal per dispute (a deal can only carry one open dispute), each
  // accepted so it is in a disputable state.
  let last;
  for (let i = 0; i < 20; i++) {
    const d = await post('/api/deals', { phone: bPhone, description: 'd', deliverable: 'x', amount: 100, escrow: false }, token);
    const dealId = (await d.json()).deal.id;
    await post(`/api/deals/${dealId}/respond`, { accept: true }, bToken);
    last = await post('/api/disputes', { transaction_id: dealId, reason: 'rate limit test' }, token);
  }
  assert.equal(last.status, 201, 'twenty disputes pass');

  const { lastId: tx } = await db.run(
    `INSERT INTO transactions (ref, description, deliverable, amount, currency, deadline, party_a_id, party_b_id, status, escrow_enabled, created_at)
     VALUES (?, 'd', 'x', 100, 'ETB', NULL, ?, ?, 'agreed', 0, ?)`,
    ['ZMN-RL-X', a, b, nowIso()]
  );
  const twentyFirst = await post('/api/disputes', { transaction_id: tx, reason: 'rate limit test' }, token);
  assert.equal(twentyFirst.status, 429, 'twenty-first dispute is limited');
});

test('teardown', () => server?.close());
