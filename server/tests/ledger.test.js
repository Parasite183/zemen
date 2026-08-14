import test from 'node:test';
import assert from 'node:assert/strict';

// Fresh in-memory database for this test process.
process.env.DATABASE_URL = '';
process.env.DB_FILE = ':memory:';

const { initDb, db } = await import('../src/db.js');
const { initSchema } = await import('../src/schema.js');
const { appendLedger, verifyChain, entriesForTx } = await import('../src/ledger.js');

test('ledger appends entries and verifies a clean chain', async () => {
  await initDb();
  await initSchema();

  await appendLedger('terms_agreed', { txId: 1, userId: 2, payload: { termsHash: 'abc123' } });
  await appendLedger('deal_started', { txId: 1, userId: 2 });
  await appendLedger('deal_confirmed', { txId: 1, userId: 3 });

  const res = await verifyChain();
  assert.equal(res.valid, true);
  assert.equal(res.count, 3);
  assert.match(res.head, /^[0-9a-f]{64}$/);

  const entries = await entriesForTx(1);
  assert.equal(entries.length, 3);
  // each entry chains onto the previous hash
  assert.equal(entries[1].prev_hash, entries[0].hash);
});

test('ledger detects any tampering', async () => {
  // flip one character of the first entry's stored hash
  await db.run(`UPDATE ledger SET hash = '0' || substr(hash, 2) WHERE id = 1`);
  const res = await verifyChain();
  assert.equal(res.valid, false);
});
