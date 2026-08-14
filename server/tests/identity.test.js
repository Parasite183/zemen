import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = '';
process.env.DB_FILE = ':memory:';

const { initDb, db } = await import('../src/db.js');
const { initSchema } = await import('../src/schema.js');
const { nowIso, sha256 } = await import('../src/crypto.js');
const {
  normalizeIdNumber,
  hamming,
  ipPrefix,
  PHASH_DUPLICATE_THRESHOLD,
  assertDealEligibility,
  registerIdDocument,
  unverifiedVolumeEtb,
} = await import('../src/services/identity.js');
const {
  detectCliques,
  detectVelocity,
  detectClusters,
} = await import('../src/services/anti-fraud.js');

let n = 0;
async function mkUser({ name, verified = false, fingerprint = '', ip = '', createdAt }) {
  const { lastId } = await db.run(
    `INSERT INTO users (phone, name, report_token, id_verification_status, verified_at,
       device_fingerprint, signup_ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      '+2519' + String(90000000 + ++n),
      name,
      'RP-ID-' + n,
      verified ? 'verified' : 'none',
      verified ? nowIso() : null,
      fingerprint,
      ip,
      createdAt || nowIso(),
    ]
  );
  return lastId;
}

async function mkDeal({ a, b, amount, status = 'confirmed', confirmedAt }) {
  await db.run(
    `INSERT INTO transactions (ref, description, deliverable, amount, currency, deadline,
       party_a_id, party_b_id, status, escrow_enabled, escrow_state, terms_json, terms_hash, created_at,
       delivered_at, delivered_by, confirmed_at)
     VALUES (?, 'd', 'd', ?, 'ETB', NULL, ?, ?, ?, 0, 'none', '', '', ?, NULL, ?, ?)`,
    ['ZMN-ID-' + Math.random().toString(36).slice(2), amount, a, b, status, nowIso(), b, confirmedAt || nowIso()]
  );
}

test('normalizeIdNumber strips separators and lowercases', () => {
  assert.equal(normalizeIdNumber('ET-1234 5678'), 'ET12345678');
  assert.equal(normalizeIdNumber('et-1234/5678'), 'ET12345678');
  assert.equal(normalizeIdNumber(''), '');
});

test('hamming distance counts differing bits and caps at length', () => {
  assert.equal(hamming('1010', '1010'), 0);
  assert.equal(hamming('1010', '1111'), 2);
  assert.equal(hamming('1010', '10'), 64); // different lengths
  assert.equal(hamming('', ''), 64);
  assert.equal(hamming('abc', 'abc'), 0);
  assert.ok(hamming('a'.repeat(64), 'b'.repeat(64)) === 64);
});

test('ipPrefix reduces IPv4 to /24 and IPv6 to /48', () => {
  assert.equal(ipPrefix('203.0.113.7'), '203.0.113.0/24');
  assert.equal(ipPrefix('::ffff:203.0.113.9'), '203.0.113.0/24');
  assert.equal(ipPrefix('2001:db8:1234:5678:9abc:def0::1'), '2001:db8:1234::/48');
  assert.equal(ipPrefix('2001:db8::1'), '2001:db8::/48');
  assert.equal(ipPrefix(''), '');
});

test('unverified users are gated above the free threshold and by lifetime volume', async () => {
  await initDb();
  await initSchema();

  const alice = await mkUser({ name: 'Alice' });
  const bob = await mkUser({ name: 'Bob' });

  // small deal below threshold: allowed
  await assertDealEligibility({ id: alice, id_verification_status: 'none', verified_at: null }, 300);
  // above threshold: blocked with a machine-readable code
  await assert.rejects(
    assertDealEligibility({ id: alice, id_verification_status: 'none', verified_at: null }, 501),
    (e) => e.status === 403 && e.code === 'verification_required'
  );
  // accumulate unverified volume then hit the cap (amount stays under the threshold so the cap check runs)
  await mkDeal({ a: alice, b: bob, amount: 4600, status: 'confirmed' });
  await assert.rejects(
    assertDealEligibility({ id: alice, id_verification_status: 'none', verified_at: null }, 500),
    (e) => e.status === 403 && e.code === 'unverified_volume_cap'
  );
  // exactly at the cap boundary is allowed
  await assertDealEligibility({ id: alice, id_verification_status: 'none', verified_at: null }, 400);
  // once verified, no gate
  await assertDealEligibility({ id: alice, id_verification_status: 'verified', verified_at: nowIso() }, 100000);
});

test('unverifiedVolumeEtb sums all deals an unverified user engaged in', async () => {
  const carol = await mkUser({ name: 'Carol' });
  const dave = await mkUser({ name: 'Dave' });
  await mkDeal({ a: carol, b: dave, amount: 900, status: 'confirmed' });
  await mkDeal({ a: carol, b: dave, amount: 1100, status: 'pending' });
  const v = await unverifiedVolumeEtb(carol, null);
  assert.equal(v, 2000);
});

test('registerIdDocument rejects a duplicate ID number and flags the doc', async () => {
  const u1 = await mkUser({ name: 'Uno' });
  const u2 = await mkUser({ name: 'Dos' });

  await registerIdDocument({ userId: u1, idNumber: 'ET-1111', phash: '0'.repeat(64), fileSha256: 'abc' });
  const res = await registerIdDocument({ userId: u2, idNumber: 'et1111', phash: '1'.repeat(64), fileSha256: 'def' });

  assert.equal(res.duplicate.code, 'duplicate_id_number');
  assert.deepEqual(res.existingUserIds, [u1]);

  const doc = await db.get('SELECT status, reason FROM id_documents WHERE user_id = ?', [u2]);
  assert.equal(doc.status, 'duplicate');
  assert.match(doc.reason, /ID number/);
});

test('registerIdDocument flags a perceptual-hash near-match', async () => {
  const u3 = await mkUser({ name: 'Tres' });
  const u4 = await mkUser({ name: 'Cuatro' });

  // distinctive hashes so earlier tests' documents don't collide
  const a = 'a'.repeat(64);
  const b = 'a'.repeat(64 - PHASH_DUPLICATE_THRESHOLD) + 'b'.repeat(PHASH_DUPLICATE_THRESHOLD);
  assert.ok(hamming(a, b) === PHASH_DUPLICATE_THRESHOLD);

  await registerIdDocument({ userId: u3, idNumber: 'X-1', phash: a });
  const res = await registerIdDocument({ userId: u4, idNumber: 'X-2', phash: b });
  assert.equal(res.duplicate.code, 'duplicate_document');
  assert.deepEqual(res.existingUserIds, [u3]);
});

test('identical file bytes are flagged as a duplicate', async () => {
  const u5 = await mkUser({ name: 'Cinco' });
  const u6 = await mkUser({ name: 'Seis' });
  await registerIdDocument({ userId: u5, idNumber: 'F-1', phash: 'c'.repeat(64), fileSha256: sha256('same-bytes') });
  const res = await registerIdDocument({ userId: u6, idNumber: 'F-2', phash: 'd'.repeat(64), fileSha256: sha256('same-bytes') });
  assert.equal(res.duplicate.code, 'duplicate_document');
});

test('detectCliques flags a dense closed loop of 3+ accounts', async () => {
  const a = await mkUser({ name: 'CliqueA' });
  const b = await mkUser({ name: 'CliqueB' });
  const c = await mkUser({ name: 'CliqueC' });
  // fully-connected triangle: A-B, B-C, A-C
  await mkDeal({ a, b, amount: 1000 });
  await mkDeal({ a: b, b: c, amount: 1000 });
  await mkDeal({ a, b: c, amount: 1000 });
  // plus a lone outside deal so A isn't exclusively in the clique
  const out = await mkUser({ name: 'Outside' });
  await mkDeal({ a, b: out, amount: 1000 });

  const flags = detectCliques([
    { party_a_id: a, party_b_id: b },
    { party_a_id: b, party_b_id: c },
    { party_a_id: a, party_b_id: c },
    { party_a_id: a, party_b_id: out },
  ]);
  assert.ok(flags.has(b), 'expected B in the clique');
  assert.ok(flags.has(c), 'expected C in the clique');
  assert.equal(flags.get(b).code, 'closed_loop_clique');
  assert.match(flags.get(b).label, /closed trading clique/);
});

test('detectCliques does not flag a long open chain (low density)', async () => {
  const a = await mkUser({ name: 'ChainA' });
  const b = await mkUser({ name: 'ChainB' });
  const c = await mkUser({ name: 'ChainC' });
  const d = await mkUser({ name: 'ChainD' });
  const e = await mkUser({ name: 'ChainE' });
  // path of 5: 4 edges out of 10 possible => density 0.4 < 0.5
  const flags = detectCliques([
    { party_a_id: a, party_b_id: b },
    { party_a_id: b, party_b_id: c },
    { party_a_id: c, party_b_id: d },
    { party_a_id: d, party_b_id: e },
  ]);
  assert.equal(flags.size, 0);
});

test('detectVelocity flags implausibly fast confirmations', async () => {
  const a = await mkUser({ name: 'Speed', createdAt: '2026-01-01T00:00:00.000Z' });
  const b = await mkUser({ name: 'Bystander' });
  const t0 = Date.parse('2026-01-01T12:00:00.000Z');
  for (let i = 0; i < 11; i++) {
    await mkDeal({ a, b, amount: 100, confirmedAt: new Date(t0 + i * 3600e3).toISOString() });
  }
  const flags = await detectVelocity();
  assert.equal(flags.get(a).code, 'velocity_suspicious');
  assert.match(flags.get(a).label, /11 confirmed deals/);
});

test('detectVelocity ignores slow, organic history', async () => {
  const a = await mkUser({ name: 'Slow', createdAt: '2026-01-01T00:00:00.000Z' });
  const b = await mkUser({ name: 'Bystander2' });
  for (let i = 0; i < 11; i++) {
    const t = new Date(Date.parse('2026-01-01T12:00:00.000Z') + i * 5 * 86400e3).toISOString(); // 5 days apart
    await mkDeal({ a, b, amount: 100, confirmedAt: t });
  }
  const flags = await detectVelocity();
  assert.ok(!flags.has(a));
});

test('detectClusters flags 3+ fresh accounts sharing a device or IP', async () => {
  const now = Date.now();
  const day = 86400e3;
  const dev1 = await mkUser({ name: 'Dev1', fingerprint: 'fp-xyz', ip: '203.0.113.0/24', createdAt: new Date(now - 1 * day).toISOString() });
  const dev2 = await mkUser({ name: 'Dev2', fingerprint: 'fp-xyz', ip: '203.0.113.0/24', createdAt: new Date(now - 2 * day).toISOString() });
  const dev3 = await mkUser({ name: 'Dev3', fingerprint: 'fp-xyz', ip: '198.51.100.0/24', createdAt: new Date(now - 3 * day).toISOString() });
  const solo = await mkUser({ name: 'Solo', fingerprint: 'fp-other', ip: '192.0.2.0/24', createdAt: new Date(now - 1 * day).toISOString() });

  const flags = await detectClusters();
  assert.equal(flags.get(solo), undefined);
  for (const id of [dev1, dev2, dev3]) {
    const f = flags.get(id);
    assert.ok(f, `expected cluster flag on user ${id}`);
    assert.ok(['device_cluster', 'ip_cluster'].includes(f.code));
  }
});
