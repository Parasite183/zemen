import test from 'node:test';
import assert from 'node:assert/strict';

// Fresh in-memory database for this test process.
process.env.DATABASE_URL = '';
process.env.DB_FILE = ':memory:';

const { initDb, db } = await import('../src/db.js');
const { initSchema } = await import('../src/schema.js');
const { nowIso } = await import('../src/crypto.js');
const {
  castVote, requestAppeal, moderatorStats,
  staffPropose, staffConfirm, staffStats,
  HIGH_VALUE_THRESHOLD_ETB, STAFF_OVERRIDE_RATE_LIMIT,
} = await import('../src/services/disputes.js');

let n = 0;
async function mkUser({ name, moderator = false, staff = false, fingerprint = '', ip = '' }) {
  const { lastId } = await db.run(
    `INSERT INTO users (phone, name, report_token, device_fingerprint, signup_ip, is_moderator, is_staff, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['+2519' + String(90000000 + ++n), name, 'DP-' + n, fingerprint, ip, moderator ? 1 : 0, staff ? 1 : 0, nowIso()]
  );
  return lastId;
}

async function mkDeal({ a, b, amount = 1000 }) {
  const { lastId } = await db.run(
    `INSERT INTO transactions (ref, description, deliverable, amount, currency, deadline,
       party_a_id, party_b_id, status, escrow_enabled, escrow_state, terms_json, terms_hash, created_at,
       delivered_at, delivered_by)
     VALUES (?, 'd', 'd', ?, 'ETB', NULL, ?, ?, 'delivered', 0, 'none', '', '', ?, ?, ?)`,
    ['ZMN-DP-' + Math.random().toString(36).slice(2), amount, a, b, nowIso(), nowIso(), b]
  );
  return lastId;
}

/** Insert a dispute row directly (raise flow is covered elsewhere). */
async function mkDispute({ txId, raisedBy, status = 'open', verdict = '', appealOf = null }) {
  const { lastId } = await db.run(
    `INSERT INTO disputes (transaction_id, raised_by, reason, status, verdict, appeal_of, created_at)
     VALUES (?, ?, 'test dispute', ?, ?, ?, ?)`,
    [txId, raisedBy, status, verdict, appealOf, nowIso()]
  );
  return lastId;
}

const isForbidden = (err) => err?.status === 403;
const isConflict = (err) => err?.status === 409;

test('a moderator who previously transacted with a party is blocked from voting', async () => {
  await initDb();
  await initSchema();

  const partyA = await mkUser({ name: 'PartyA' });
  const partyB = await mkUser({ name: 'PartyB' });
  const conflicted = await mkUser({ name: 'ConflictedMod', moderator: true });

  // The moderator dealt with party A before — that is a conflict.
  await mkDeal({ a: conflicted, b: partyA, amount: 500 });
  const disputedTx = await mkDeal({ a: partyA, b: partyB, amount: 3000 });
  const disputeId = await mkDispute({ txId: disputedTx, raisedBy: partyA });

  await assert.rejects(
    castVote(disputeId, { id: conflicted }, 'party_a', 'should be blocked'),
    isForbidden
  );

  // Dispute stays open and the attempt is on the permanent audit log.
  const d = await db.get('SELECT * FROM disputes WHERE id = ?', [disputeId]);
  assert.equal(d.status, 'open', 'a blocked vote must not resolve or count');
  const log = await db.get('SELECT * FROM dispute_moderator_log WHERE dispute_id = ?', [disputeId]);
  assert.equal(log.moderator_id, conflicted);
  assert.equal(log.reason, 'prior_transaction');
});

test('a moderator sharing a device fingerprint with a party is blocked from voting', async () => {
  const partyA = await mkUser({ name: 'PartyA2' });
  const partyB = await mkUser({ name: 'PartyB2' });
  const clustered = await mkUser({ name: 'ClusteredMod', moderator: true, fingerprint: 'fp-shared' });
  // Party A shares the moderator's device fingerprint — a cluster overlap.
  await db.run(`UPDATE users SET device_fingerprint = 'fp-shared' WHERE id = ?`, [partyA]);

  const disputedTx = await mkDeal({ a: partyA, b: partyB, amount: 3000 });
  const disputeId = await mkDispute({ txId: disputedTx, raisedBy: partyA });

  await assert.rejects(
    castVote(disputeId, { id: clustered }, 'party_a'),
    isForbidden
  );
  const log = await db.get('SELECT * FROM dispute_moderator_log WHERE dispute_id = ?', [disputeId]);
  assert.equal(log.reason, 'device_ip_cluster');
});

test('a high-value dispute cannot resolve with a sub-quorum vote (2 of 3)', async () => {
  const partyA = await mkUser({ name: 'PartyA3' });
  const partyB = await mkUser({ name: 'PartyB3' });
  const m1 = await mkUser({ name: 'Mod1', moderator: true });
  const m2 = await mkUser({ name: 'Mod2', moderator: true });
  const m3 = await mkUser({ name: 'Mod3', moderator: true });

  const disputedTx = await mkDeal({ a: partyA, b: partyB, amount: HIGH_VALUE_THRESHOLD_ETB + 1 });
  const disputeId = await mkDispute({ txId: disputedTx, raisedBy: partyA });

  // Two unanimous votes are still below the 3-moderator quorum.
  await castVote(disputeId, { id: m1 }, 'party_a');
  await castVote(disputeId, { id: m2 }, 'party_a');
  let d = await db.get('SELECT * FROM disputes WHERE id = ?', [disputeId]);
  assert.equal(d.status, 'open', '2 votes must not resolve a high-value dispute');

  // The third independent vote creates a majority and resolves it.
  await castVote(disputeId, { id: m3 }, 'party_b');
  d = await db.get('SELECT * FROM disputes WHERE id = ?', [disputeId]);
  assert.equal(d.status, 'resolved');
  assert.equal(d.verdict, 'party_a', 'majority (2-1) decides');
});

test('a low-value dispute resolves on a single moderator vote', async () => {
  const partyA = await mkUser({ name: 'PartyA4' });
  const partyB = await mkUser({ name: 'PartyB4' });
  const solo = await mkUser({ name: 'SoloMod', moderator: true });

  const disputedTx = await mkDeal({ a: partyA, b: partyB, amount: 300 });
  const disputeId = await mkDispute({ txId: disputedTx, raisedBy: partyA });

  await castVote(disputeId, { id: solo }, 'party_a');
  const d = await db.get('SELECT * FROM disputes WHERE id = ?', [disputeId]);
  assert.equal(d.status, 'resolved', 'small disputes are cheap: one vote is enough');
  assert.equal(d.verdict, 'party_a');
});

test('a single staff override call never resolves a dispute and a reason is required', async () => {
  const partyA = await mkUser({ name: 'PartyA6' });
  const partyB = await mkUser({ name: 'PartyB6' });
  const staff1 = await mkUser({ name: 'Staff1', staff: true });
  const tx = await mkDeal({ a: partyA, b: partyB, amount: 500 });
  const dId = await mkDispute({ txId: tx, raisedBy: partyA });

  // No empty justification: whitespace-only reason is rejected.
  await assert.rejects(staffPropose(dId, { id: staff1 }, 'party_a', '   '), (e) => e?.status === 400);
  await staffPropose(dId, { id: staff1 }, 'party_a', 'Clear breach of the agreed terms');

  const d = await db.get('SELECT * FROM disputes WHERE id = ?', [dId]);
  assert.equal(d.status, 'open', 'a proposal must not resolve anything');
  const rows = await db.all('SELECT * FROM dispute_staff_overrides WHERE dispute_id = ?', [dId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'propose');
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].required_signoffs, 2);
});

test('a second staff account confirming the same verdict applies the override', async () => {
  const partyA = await mkUser({ name: 'PartyA7' });
  const partyB = await mkUser({ name: 'PartyB7' });
  const staff1 = await mkUser({ name: 'Staff1b', staff: true });
  const staff2 = await mkUser({ name: 'Staff2', staff: true });
  const tx = await mkDeal({ a: partyA, b: partyB, amount: 500 });
  const dId = await mkDispute({ txId: tx, raisedBy: partyA });

  await staffPropose(dId, { id: staff1 }, 'party_a', 'Evidence favours A');
  let d = await db.get('SELECT * FROM disputes WHERE id = ?', [dId]);
  assert.equal(d.status, 'open');

  // The proposer cannot confirm their own override.
  await assert.rejects(staffConfirm(dId, { id: staff1 }, 'party_a', 'Self-confirm'), isForbidden);

  await staffConfirm(dId, { id: staff2 }, 'party_a', 'Agreed — evidence favours A');
  d = await db.get('SELECT * FROM disputes WHERE id = ?', [dId]);
  assert.equal(d.status, 'resolved');
  assert.equal(d.verdict, 'party_a');
  const rows = await db.all('SELECT * FROM dispute_staff_overrides WHERE dispute_id = ?', [dId]);
  assert.ok(rows.every((r) => r.status === 'applied'));

  // Overrides are as visible as votes: staffStats tracks both accounts.
  const stats = await staffStats();
  const s1 = stats.find((s) => s.staff_id === staff1);
  const s2 = stats.find((s) => s.staff_id === staff2);
  assert.equal(s1.overrides_proposed, 1);
  assert.equal(s2.overrides_confirmed, 1);
  assert.equal(s1.overrides_participated, 1);
  assert.equal(s2.overrides_participated, 1);

  // An override that gets appealed and flipped shows up as overturned.
  await requestAppeal(dId, { id: partyB });
  const appeal = await db.get('SELECT * FROM disputes WHERE appeal_of = ?', [dId]);
  const freshMod = await mkUser({ name: 'FreshMod', moderator: true });
  await castVote(appeal.id, { id: freshMod }, 'party_b');
  const overturned = await staffStats();
  const s1o = overturned.find((s) => s.staff_id === staff1);
  const s2o = overturned.find((s) => s.staff_id === staff2);
  assert.equal(s1o.overturned_on_appeal, 1, 'proposer record shows the appeal reversal');
  assert.equal(s2o.overturned_on_appeal, 1, 'confirmer record shows the appeal reversal');
});

test('a mismatched second staff verdict sends the dispute back to the moderator panel', async () => {
  const partyA = await mkUser({ name: 'PartyA8' });
  const partyB = await mkUser({ name: 'PartyB8' });
  const staff1 = await mkUser({ name: 'Staff1c', staff: true });
  const staff2 = await mkUser({ name: 'Staff2c', staff: true });
  const m1 = await mkUser({ name: 'Mod1c', moderator: true });
  const m2 = await mkUser({ name: 'Mod2c', moderator: true });
  const m3 = await mkUser({ name: 'Mod3c', moderator: true });
  const tx = await mkDeal({ a: partyA, b: partyB, amount: 3000 }); // high value → 3-vote panel
  const dId = await mkDispute({ txId: tx, raisedBy: partyA });

  await staffPropose(dId, { id: staff1 }, 'party_a', 'Favours A');
  await staffConfirm(dId, { id: staff2 }, 'party_b', 'Disagree — the evidence favours B');
  const d = await db.get('SELECT * FROM disputes WHERE id = ?', [dId]);
  assert.equal(d.status, 'open', 'a disagreement must not silently pick a side');
  assert.equal(d.verdict, '');
  const rows = await db.all('SELECT * FROM dispute_staff_overrides WHERE dispute_id = ?', [dId]);
  assert.ok(rows.every((r) => r.status === 'disagreed'));

  // The override path is closed for this dispute — the panel decides.
  await assert.rejects(staffPropose(dId, { id: staff2 }, 'party_a', 'try again'), isConflict);
  await castVote(dId, { id: m1 }, 'party_b');
  await castVote(dId, { id: m2 }, 'party_b');
  await castVote(dId, { id: m3 }, 'party_a');
  const after = await db.get('SELECT * FROM disputes WHERE id = ?', [dId]);
  assert.equal(after.status, 'resolved');
  assert.equal(after.verdict, 'party_b', 'the panel majority decides after the override fails');
});

test('a conflicted staff account is blocked from the override exactly like a moderator', async () => {
  const partyA = await mkUser({ name: 'PartyA9' });
  const partyB = await mkUser({ name: 'PartyB9' });
  const staffParty = await mkUser({ name: 'StaffParty', staff: true });
  const staffCluster = await mkUser({ name: 'StaffCluster', staff: true, fingerprint: 'fp-shared-9' });
  const staffPrior = await mkUser({ name: 'StaffPrior', staff: true });
  await db.run(`UPDATE users SET device_fingerprint = 'fp-shared-9' WHERE id = ?`, [partyA]);

  // A staff member who is a party to the dispute is blocked and logged.
  const tx1 = await mkDeal({ a: staffParty, b: partyB, amount: 500 });
  const d1 = await mkDispute({ txId: tx1, raisedBy: staffParty });
  await assert.rejects(staffPropose(d1, { id: staffParty }, 'party_a', 'x'), isForbidden);
  assert.ok(await db.get("SELECT id FROM dispute_moderator_log WHERE dispute_id = ? AND reason = 'is_party'", [d1]));

  // A staff member sharing a device fingerprint with a party is blocked.
  const tx2 = await mkDeal({ a: partyA, b: partyB, amount: 500 });
  const d2 = await mkDispute({ txId: tx2, raisedBy: partyA });
  await assert.rejects(staffPropose(d2, { id: staffCluster }, 'party_a', 'x'), isForbidden);
  assert.ok(await db.get("SELECT id FROM dispute_moderator_log WHERE dispute_id = ? AND reason = 'device_ip_cluster'", [d2]));

  // A staff member who previously transacted with a party is blocked.
  await mkDeal({ a: staffPrior, b: partyA, amount: 300 });
  const tx3 = await mkDeal({ a: partyA, b: partyB, amount: 500 });
  const d3 = await mkDispute({ txId: tx3, raisedBy: partyA });
  await assert.rejects(staffPropose(d3, { id: staffPrior }, 'party_a', 'x'), isForbidden);
  assert.ok(await db.get("SELECT id FROM dispute_moderator_log WHERE dispute_id = ? AND reason = 'prior_transaction'", [d3]));
});

test('a heavy override user needs three sign-offs instead of two', async () => {
  const staffA = await mkUser({ name: 'StaffHeavy', staff: true });
  const staffB = await mkUser({ name: 'StaffB', staff: true });
  const staffC = await mkUser({ name: 'StaffC', staff: true });

  // staffA leans on the override path 6 times (> 5) inside the window.
  for (let i = 0; i < STAFF_OVERRIDE_RATE_LIMIT + 1; i++) {
    const pA = await mkUser({ name: 'PA' + i });
    const pB = await mkUser({ name: 'PB' + i });
    const tx = await mkDeal({ a: pA, b: pB, amount: 500 });
    const dId = await mkDispute({ txId: tx, raisedBy: pA });
    await staffPropose(dId, { id: staffA }, 'party_a', 'override ' + i);
  }

  const pA = await mkUser({ name: 'PAx' });
  const pB = await mkUser({ name: 'PBx' });
  const tx = await mkDeal({ a: pA, b: pB, amount: 500 });
  const dId = await mkDispute({ txId: tx, raisedBy: pA });
  await staffPropose(dId, { id: staffA }, 'party_b', 'heavy user override');
  const proposal = await db.get('SELECT * FROM dispute_staff_overrides WHERE dispute_id = ?', [dId]);
  assert.equal(proposal.required_signoffs, 3, 'heavy use escalates to three sign-offs');

  await staffConfirm(dId, { id: staffB }, 'party_b', 'agree');
  let d = await db.get('SELECT * FROM disputes WHERE id = ?', [dId]);
  assert.equal(d.status, 'open', 'two sign-offs are not enough for a heavy user');

  await staffConfirm(dId, { id: staffC }, 'party_b', 'also agree');
  d = await db.get('SELECT * FROM disputes WHERE id = ?', [dId]);
  assert.equal(d.status, 'resolved');
  assert.equal(d.verdict, 'party_b');
});

test('an appeal excludes the original voters and records both outcomes', async () => {
  const partyA = await mkUser({ name: 'PartyA5' });
  const partyB = await mkUser({ name: 'PartyB5' });
  const m1 = await mkUser({ name: 'OrigMod1', moderator: true });
  const m2 = await mkUser({ name: 'OrigMod2', moderator: true });
  const m3 = await mkUser({ name: 'OrigMod3', moderator: true });
  const f1 = await mkUser({ name: 'AppealMod1', moderator: true });
  const f2 = await mkUser({ name: 'AppealMod2', moderator: true });
  const f3 = await mkUser({ name: 'AppealMod3', moderator: true });

  const disputedTx = await mkDeal({ a: partyA, b: partyB, amount: 5000 });
  const disputeId = await mkDispute({ txId: disputedTx, raisedBy: partyA });

  // Original panel resolves 2-1 for party_a.
  await castVote(disputeId, { id: m1 }, 'party_a');
  await castVote(disputeId, { id: m2 }, 'party_a');
  await castVote(disputeId, { id: m3 }, 'party_b');
  const original = await db.get('SELECT * FROM disputes WHERE id = ?', [disputeId]);
  assert.equal(original.status, 'resolved');
  assert.equal(original.verdict, 'party_a');

  // Only the losing party (party_b) may appeal; the winner cannot.
  await assert.rejects(requestAppeal(disputeId, { id: partyA }), isForbidden);
  const appeal = await requestAppeal(disputeId, { id: partyB });
  assert.ok(appeal.appeal_of, 'appeal references the original dispute');
  assert.equal(appeal.appeal_of, disputeId);
  assert.equal(appeal.status, 'open');
  assert.equal(appeal.original.verdict, 'party_a', 'appeal carries the original outcome');

  // A second appeal is capped at one.
  await assert.rejects(requestAppeal(disputeId, { id: partyB }), isConflict);

  // An original voter cannot judge the appeal.
  await assert.rejects(
    castVote(appeal.id, { id: m1 }, 'party_b'),
    isForbidden
  );
  const blockLog = await db.get(
    'SELECT * FROM dispute_moderator_log WHERE dispute_id = ? AND reason = ?',
    [appeal.id, 'appeal_original_voter']
  );
  assert.ok(blockLog, 'excluded appeal attempt is logged');

  // A fresh panel flips the outcome 2-1 for party_b.
  await castVote(appeal.id, { id: f1 }, 'party_b');
  await castVote(appeal.id, { id: f2 }, 'party_b');
  await castVote(appeal.id, { id: f3 }, 'party_a');
  const appealResolved = await db.get('SELECT * FROM disputes WHERE id = ?', [appeal.id]);
  assert.equal(appealResolved.status, 'resolved');
  assert.equal(appealResolved.verdict, 'party_b', 'appeal flips the original decision');

  // The appeal panel contains none of the original voters.
  const appealVoters = await db.all('SELECT moderator_id FROM dispute_votes WHERE dispute_id = ?', [appeal.id]);
  assert.deepEqual(
    appealVoters.map((v) => v.moderator_id).sort(),
    [f1, f2, f3].sort(),
    'original voters must be excluded from the appeal panel'
  );

  // Track record: the original voters who backed the overturned decision
  // show up as having been overturned on appeal.
  const stats = await moderatorStats();
  const m1Stats = stats.find((s) => s.moderator_id === m1);
  assert.equal(m1Stats.disputes_handled, 1);
  assert.equal(m1Stats.majority_match_rate, 1, 'voted with the original majority');
  assert.equal(m1Stats.appealed_cases, 1);
  assert.equal(m1Stats.overturned_on_appeal, 1, 'their resolution was overturned on appeal');
});
