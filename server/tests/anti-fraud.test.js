import test from 'node:test';
import assert from 'node:assert/strict';

// Fresh in-memory database for this test process.
process.env.DATABASE_URL = '';
process.env.DB_FILE = ':memory:';

const { initDb, db } = await import('../src/db.js');
const { initSchema } = await import('../src/schema.js');
const { nowIso } = await import('../src/crypto.js');
const {
  detectCliques,
  detectHubSpokes,
  hubSpokeGroups,
  fraudClustersForReview,
} = await import('../src/services/anti-fraud.js');

let n = 0;
// Each user gets a unique fingerprint so fraudClustersForReview resolves
// real names without forming device clusters.
async function mkUser(name) {
  const { lastId } = await db.run(
    `INSERT INTO users (phone, name, report_token, device_fingerprint, signup_ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['+2519' + String(70000000 + ++n), name, 'AF-' + n, 'fp-af-' + n, '', nowIso()]
  );
  return lastId;
}

async function mkDeal({ a, b, amount = 1000, status = 'confirmed', confirmedAt }) {
  await db.run(
    `INSERT INTO transactions (ref, description, deliverable, amount, currency, deadline,
       party_a_id, party_b_id, status, escrow_enabled, escrow_state, terms_json, terms_hash, created_at,
       delivered_at, delivered_by, confirmed_at)
     VALUES (?, 'd', 'd', ?, 'ETB', NULL, ?, ?, ?, 0, 'none', '', '', ?, NULL, ?, ?)`,
    ['ZMN-AF-' + Math.random().toString(36).slice(2), amount, a, b, status, nowIso(), b, confirmedAt || nowIso()]
  );
}

// One hub + six spokes, each spoke trading exactly once with the hub and
// never with another spoke — the shape that defeats the clique detector
// (density 6/21 ≈ 0.29 < 0.5) and per-counterparty concentration.
function hubSpokeDeals(hub, spokes) {
  return spokes.map((s) => ({ party_a_id: hub, party_b_id: s }));
}

test('the clique detector does not flag a hub-and-spoke ring (the gap)', () => {
  const hub = 101;
  const spokes = [111, 112, 113, 114, 115, 116];
  const flags = detectCliques(hubSpokeDeals(hub, spokes));
  assert.equal(flags.size, 0, 'clique detector must NOT flag a wide hub-and-spoke ring');
});

test('the hub-spoke detector flags the hub and only the hub', () => {
  const hub = 201;
  const spokes = [211, 212, 213, 214, 215, 216];
  const deals = hubSpokeDeals(hub, spokes);

  const flags = detectHubSpokes(deals);
  assert.equal(flags.size, 1, 'one flag for the ring, on the hub only');
  assert.equal(flags.get(hub).code, 'hub_spoke_pattern');
  assert.match(flags.get(hub).label, /hub/i);
  for (const s of spokes) assert.ok(!flags.has(s), `spoke ${s} must not be flagged`);

  const groups = hubSpokeGroups(deals);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.hub, hub);
  assert.equal(g.members.length, 7);
  assert.ok(g.density < 0.5, 'low density — the gap the clique check misses');
  assert.ok(g.hubShare >= 0.8, 'one node touches most edges');
});

test('the hub-spoke detector does not flag a dense organic network', () => {
  // Normal user with a comparable deal count (6) but real repeat business
  // in an interconnected network: A trades 6 times (2 each with B and C,
  // 1 each with D and E) and the counterparties also trade among
  // themselves, so the component is dense and no single node dominates.
  const a = 1, b = 2, c = 3, d = 4, e = 5;
  const deals = [
    { party_a_id: a, party_b_id: b }, { party_a_id: a, party_b_id: b },
    { party_a_id: a, party_b_id: c }, { party_a_id: a, party_b_id: c },
    { party_a_id: a, party_b_id: d },
    { party_a_id: a, party_b_id: e },
    { party_a_id: b, party_b_id: c }, { party_a_id: c, party_b_id: d },
    { party_a_id: d, party_b_id: e }, { party_a_id: b, party_b_id: d },
  ];
  assert.equal(detectHubSpokes(deals).size, 0, 'organic network must not be flagged');
});

test('fraudClustersForReview returns hub-spoke groups with member names', async () => {
  await initDb();
  await initSchema();

  const hub = await mkUser('HubReview');
  const spokes = [];
  for (let i = 0; i < 6; i++) spokes.push(await mkUser('SpokeReview' + i));
  for (const s of spokes) await mkDeal({ a: hub, b: s });

  const { hubSpokes } = await fraudClustersForReview();
  const group = hubSpokes.find((g) => g.hub.id === hub);
  assert.ok(group, 'hub-and-spoke ring shows up as a hub-spoke group');
  assert.equal(group.hub.name, 'HubReview');
  assert.equal(group.members.length, 7);
  assert.ok(group.members.every((m) => m.id && m.name), 'members carry id + name');
  assert.ok(group.density < 0.5);
  assert.ok(group.hubShare >= 0.8);
});
