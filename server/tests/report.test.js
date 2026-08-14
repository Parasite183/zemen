import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
process.env.DB_FILE = ':memory:';

const { initDb, db } = await import('../src/db.js');
const { initSchema } = await import('../src/schema.js');
const { nowIso, sha256, canonicalize } = await import('../src/crypto.js');
const { computeReputation } = await import('../src/services/reputation.js');
const { buildReport } = await import('../src/services/reports.js');

let n = 0;
async function mkUser(name) {
  const { lastId } = await db.run(
    `INSERT INTO users (phone, name, category, bio, id_verification_status, report_token, created_at)
     VALUES (?, ?, 'trade', 'bio', 'none', ?, ?)`,
    ['+2519' + String(90000000 + ++n), name, 'RP-BR-' + n, nowIso()]
  );
  return lastId;
}

async function mkDeal({ a, b, amount, status = 'confirmed', deliveredAt, confirmedAt, deadline }) {
  await db.run(
    `INSERT INTO transactions (ref, description, deliverable, amount, currency, deadline,
       party_a_id, party_b_id, status, escrow_enabled, escrow_state, terms_json, terms_hash, created_at,
       delivered_at, delivered_by, confirmed_at)
     VALUES (?, 'd', 'd', ?, 'ETB', ?, ?, ?, ?, 0, 'none', '', '', ?, ?, ?, ?)`,
    ['ZMN-BR-' + Math.random().toString(36).slice(2), amount, deadline || null,
     a, b, status, nowIso(), deliveredAt || null, b, confirmedAt || null]
  );
}

// The UI renders report.reputation.* directly with no null guards, so
// the shape is the contract: every field must exist even when the user
// has no reputation_scores row at all (a brand-new account).
test('a fresh user\'s report always has complete zeroed fields', async () => {
  await initDb();
  await initSchema();

  const fresh = await mkUser('Fresh Face');
  const user = await db.get('SELECT * FROM users WHERE id = ?', [fresh]);
  assert.equal(await db.get('SELECT user_id FROM reputation_scores WHERE user_id = ?', [fresh]), null,
    'precondition: the fresh user has no reputation row');

  const { report, seal } = await buildReport(user);

  assert.equal(report.subject.name, 'Fresh Face');
  assert.equal(report.subject.verification, 'none');
  assert.equal(report.subject.joined, user.created_at.slice(0, 10));
  assert.deepEqual(report.reputation, {
    completionRate: 0,
    onTimeRate: 0,
    disputeRate: 0,
    totalVolume: 0,
    completed: 0,
    failed: 0,
    disputed: 0,
  }, 'every reputation field is present and zeroed');
  assert.deepEqual(report.history, [], 'empty history is an array, not null');
  assert.deepEqual(report.disputes, [], 'empty disputes is an array, not null');
  assert.equal(report.ledgerHead, 'GENESIS');
  assert.match(seal, /^[0-9a-f]{64}$/, 'seal is always a SHA-256 hash');
  assert.equal(seal, sha256(canonicalize(report)), 'seal commits to the exact report contents');
});

// The extracted builder must also pass real numbers through unchanged.
test('a user with history gets real numbers through the same builder', async () => {
  const alice = await mkUser('Alice Real');
  const bob = await mkUser('Bob Real');
  const deadline = '2026-01-20';
  await mkDeal({ a: alice, b: bob, amount: 1000, status: 'confirmed', deliveredAt: '2026-01-10T10:00:00.000Z', confirmedAt: nowIso(), deadline });
  await mkDeal({ a: alice, b: bob, amount: 2000, status: 'failed', confirmedAt: nowIso() });
  await computeReputation(alice);

  const user = await db.get('SELECT * FROM users WHERE id = ?', [alice]);
  const { report, seal } = await buildReport(user);

  assert.equal(report.reputation.completed, 1);
  assert.equal(report.reputation.failed, 1);
  assert.equal(report.reputation.completionRate, 0.5);
  // volume counts confirmed deals only (failed ones count toward `failed`)
  assert.equal(report.reputation.totalVolume, 1000);
  assert.equal(report.history.length, 2); // history includes both statuses
  assert.deepEqual(report.history.map((h) => h.status).sort(), ['confirmed', 'failed']);
  assert.match(seal, /^[0-9a-f]{64}$/);
});
