import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
process.env.DB_FILE = ':memory:';

const { initDb, db } = await import('../src/db.js');
const { initSchema } = await import('../src/schema.js');
const { computeReputation } = await import('../src/services/reputation.js');
const { nowIso } = await import('../src/crypto.js');

let n = 0;
async function mkUser(phone, name) {
  const { lastId } = await db.run(
    `INSERT INTO users (phone, name, report_token, created_at) VALUES (?, ?, ?, ?)`,
    [phone, name, 'RP-TEST-' + ++n, nowIso()]
  );
  return lastId;
}

async function mkDeal({ a, b, amount, status, deliveredAt, confirmedAt, deadline }) {
  await db.run(
    `INSERT INTO transactions (ref, description, deliverable, amount, currency, deadline,
       party_a_id, party_b_id, status, escrow_enabled, escrow_state, terms_json, terms_hash, created_at,
       delivered_at, delivered_by, confirmed_at)
     VALUES (?, 'd', 'd', ?, 'ETB', ?, ?, ?, ?, 0, 'none', '', '', ?, ?, ?, ?)`,
    ['ZMN-TEST-' + Math.random().toString(36).slice(2), amount, deadline || null,
     a, b, status, nowIso(), deliveredAt || null, b, confirmedAt || null]
  );
}

test('completion, on-time and volume are computed from resolved deals', async () => {
  await initDb();
  await initSchema();

  const alice = await mkUser('+251900000001', 'Alice');
  const bob = await mkUser('+251900000002', 'Bob');

  // two confirmed (one on time, one late), one failed
  const deadline = '2026-01-20';
  await mkDeal({ a: alice, b: bob, amount: 1000, status: 'confirmed', deliveredAt: '2026-01-10T10:00:00.000Z', confirmedAt: nowIso(), deadline });
  await mkDeal({ a: alice, b: bob, amount: 2000, status: 'confirmed', deliveredAt: '2026-02-10T10:00:00.000Z', confirmedAt: nowIso(), deadline });
  await mkDeal({ a: alice, b: bob, amount: 3000, status: 'failed', confirmedAt: nowIso() });

  const rep = await computeReputation(alice);
  assert.equal(rep.total_completed, 2);
  assert.equal(rep.total_failed, 1);
  assert.equal(rep.completion_rate, Math.round((2 / 3) * 10000) / 10000);
  assert.equal(rep.on_time_rate, 0.5);
  assert.equal(rep.total_volume, 3000);
});

test('one-sided concentration triggers a flag after 3+ completed deals', async () => {
  const carol = await mkUser('+251900000003', 'Carol');
  const dave = await mkUser('+251900000004', 'Dave');

  for (let i = 0; i < 4; i++) {
    await mkDeal({ a: carol, b: dave, amount: 5000, status: 'confirmed', confirmedAt: nowIso() });
  }
  const rep = await computeReputation(carol);
  const flags = JSON.parse(rep.flags_json);
  assert.ok(flags.some((f) => f.code === 'one_sided_concentration'), 'expected one-sided flag');
});

test('broad shallow network flags a hub spreading one-off deals across many spokes', async () => {
  const hub = await mkUser('+251900000010', 'Hub');
  for (let i = 0; i < 15; i++) {
    const spoke = await mkUser('+2519000000' + (11 + i), 'Spoke' + i);
    await mkDeal({ a: hub, b: spoke, amount: 1000, status: 'confirmed', confirmedAt: nowIso() });
  }
  const rep = await computeReputation(hub);
  const flags = JSON.parse(rep.flags_json);
  assert.ok(flags.some((f) => f.code === 'broad_shallow_network'), 'expected broad_shallow_network flag');
});

test('repeat-business user is not flagged as a broad shallow network', async () => {
  const vendor = await mkUser('+251900000030', 'Vendor');
  for (let i = 0; i < 3; i++) {
    const customer = await mkUser('+2519000000' + (31 + i), 'Customer' + i);
    for (let j = 0; j < 5; j++) {
      await mkDeal({ a: vendor, b: customer, amount: 1000, status: 'confirmed', confirmedAt: nowIso() });
    }
  }
  const rep = await computeReputation(vendor);
  const flags = JSON.parse(rep.flags_json);
  assert.ok(!flags.some((f) => f.code === 'broad_shallow_network'), 'repeat business must not be flagged');
});
