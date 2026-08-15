// ─────────────────────────────────────────────────────────────────────
// Demo seed.
// Creates realistic users, deal history (with a real hash-chained ledger
// trail), a resolved dispute, and a collusion-flag example for the
// moderator view. Safe to re-run: skips if already seeded.
//
//   npm run seed
// ─────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { initDb, db } from './db.js';
import { initSchema } from './schema.js';
import { appendLedger } from './ledger.js';
import { canonicalize, sha256, genRef } from './crypto.js';
import { computeReputation } from './services/reputation.js';

const DAY = 86400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const dateDaysAgo = (n) => daysAgo(n).slice(0, 10);

// `verified: 'verified'` users also get a verified_at so the
// unverified-lifetime-volume accounting is honest for seeded history.
const USERS = [
  { phone: '+251911000001', name: 'Abebe Kebede', category: 'freelance', bio: 'Graphic designer & web developer. Addis Ababa.', verified: 'verified', verifiedDaysAgo: 100 },
  { phone: '+251911000002', name: 'Sara Tesfaye', category: 'trade', bio: 'Small trading — coffee & spices exporter.', verified: 'verified', verifiedDaysAgo: 100 },
  { phone: '+251911000003', name: 'Bekele Alemu', category: 'agriculture', bio: 'Coffee farmer, Jimma region.', verified: 'pending' },
  { phone: '+251911000004', name: 'Lidya Hailu', category: 'services', bio: 'Platform moderator & staff.', verified: 'verified', verifiedDaysAgo: 100, moderator: true, staff: true },
  { phone: '+251911000005', name: 'Tesfaye Girma', category: 'services', bio: 'Phone repair & electronics.', verified: 'verified', verifiedDaysAgo: 100 },
  { phone: '+251911000006', name: 'Girma Haile', category: 'services', bio: 'Phone repair & electronics.', verified: 'verified', verifiedDaysAgo: 100 },
  { phone: '+251911000007', name: 'Hana Worku', category: 'agriculture', bio: 'Teff & wheat farmer, Arsi.', verified: 'verified', verifiedDaysAgo: 100 },
  { phone: '+251911000008', name: 'Meron Assefa', category: 'services', bio: 'Platform moderator & staff.', verified: 'verified', verifiedDaysAgo: 90, moderator: true, staff: true },
];

/** Same terms hashing as the live service, so hashes are honest. */
function termsOf(deal) {
  const terms = {
    ref: deal.ref,
    description: deal.description,
    deliverable: deal.deliverable,
    amount: deal.amount,
    currency: deal.currency,
    deadline: deal.deadline || null,
    party_a: deal.party_a_id,
    party_b: deal.party_b_id,
    escrow: !!deal.escrow_enabled,
  };
  return { termsJson: JSON.stringify(terms), termsHash: sha256(canonicalize(terms)) };
}

/**
 * Create the demo dataset. Expects an initialised, empty database
 * (caller runs initDb + initSchema). Exported so the Cloudflare D1 seed
 * dump (server/scripts/dump-seed-sql.mjs) can reuse the exact same
 * data and honest hash-chain timeline.
 */
export async function runSeed() {
  // ── users ─────────────────────────────────────────────────────────
  const ids = {};
  for (const u of USERS) {
    const { lastId } = await db.run(
      `INSERT INTO users (phone, name, category, bio, id_verification_status, is_moderator, is_staff, report_token, verified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.phone, u.name, u.category, u.bio, u.verified, u.moderator ? 1 : 0, u.staff ? 1 : 0, genRef('RP'), u.verifiedDaysAgo ? daysAgo(u.verifiedDaysAgo) : null, daysAgo(120)]
    );
    ids[u.phone] = lastId;
  }
  const [abebe, sara, bekele, lidya, tesfaye, girma, hana] = USERS.map((u) => ids[u.phone]);

  // ── history timeline ──────────────────────────────────────────────
  // Every entry is [offsetInDaysAgo, event, payloadFactory]. They are
  // applied in chronological order so the hash chain is honest.
  const timeline = [];
  const EV = (offset, event, fn) => timeline.push([offset, event, fn]);

  function dealDef(aPhone, bPhone, { description, deliverable, amount, escrow = false, createdOffset, deadlineDaysAfter = 10 }) {
    return {
      ref: genRef(), description, deliverable, amount, currency: 'ETB',
      deadline: dateDaysAgo(createdOffset - deadlineDaysAfter),
      party_a_id: ids[aPhone], party_b_id: ids[bPhone],
      escrow_enabled: escrow ? 1 : 0, createdOffset,
    };
  }
  const txRefs = {};
  const withTx = (def, at) => ({ ref: def.ref, at });

  // 1) Sara ⇄ Abebe — completed logo design with escrow, delivered on time
  const d1 = dealDef('+251911000002', '+251911000001', {
    description: 'Brand logo design for Sera Coffee export', deliverable: '3 logo concepts + final files',
    amount: 8500, escrow: true, createdOffset: 55, deadlineDaysAfter: 15,
  });
  EV(55, 'deal_created', () => d1);
  EV(54, 'terms_agreed', () => withTx(d1, daysAgo(54)));
  EV(52, 'escrow_funded', () => withTx(d1, daysAgo(52)));
  EV(50, 'deal_started', () => withTx(d1, daysAgo(50)));
  EV(41, 'delivered', () => withTx(d1, daysAgo(41)));
  EV(40, 'deal_confirmed', () => withTx(d1, daysAgo(40)));

  // 2) Tesfaye ⇄ Girma — repair job that ended in a dispute (payer wins → refund)
  const d4 = dealDef('+251911000005', '+251911000006', {
    description: 'Laptop motherboard repair', deliverable: 'Working laptop, 1 week warranty',
    amount: 12000, escrow: true, createdOffset: 35,
  });
  EV(35, 'deal_created', () => d4);
  EV(34, 'terms_agreed', () => withTx(d4, daysAgo(34)));
  EV(33, 'escrow_funded', () => withTx(d4, daysAgo(33)));
  EV(32, 'deal_started', () => withTx(d4, daysAgo(32)));
  EV(30, 'delivered', () => withTx(d4, daysAgo(30)));
  EV(29, 'dispute_raised', () => withTx(d4, daysAgo(29)));
  EV(28, 'dispute_resolved', () => withTx(d4, daysAgo(28)));

  // 3) Tesfaye ⇄ Girma — three small confirmed deals → one-sided flag
  const smallDefs = [];
  for (let i = 0; i < 3; i++) {
    const off = 26 - i * 3;
    const sd = dealDef('+251911000005', '+251911000006', {
      description: `Phone screen replacement #${i + 1}`, deliverable: 'Screen replaced & tested',
      amount: 3000 + i * 1000, createdOffset: off,
    });
    smallDefs.push(sd);
    EV(off, 'deal_created', () => sd);
    EV(off - 0.4, 'terms_agreed', () => withTx(sd, daysAgo(off - 0.4)));
    EV(off - 1.2, 'deal_started', () => withTx(sd, daysAgo(off - 1.2)));
    EV(off - 2.1, 'delivered', () => withTx(sd, daysAgo(off - 2.1)));
    EV(off - 2.5, 'deal_confirmed', () => withTx(sd, daysAgo(off - 2.5)));
  }

  // 4) Bekele ⇄ Hana — completed teff trade, on time
  const d5 = dealDef('+251911000003', '+251911000007', {
    description: 'Teff purchase — 500 kg', deliverable: '500 kg teff delivered to Adama',
    amount: 15000, escrow: true, createdOffset: 21, deadlineDaysAfter: 14,
  });
  EV(21, 'deal_created', () => d5);
  EV(20, 'terms_agreed', () => withTx(d5, daysAgo(20)));
  EV(19, 'escrow_funded', () => withTx(d5, daysAgo(19)));
  EV(18, 'deal_started', () => withTx(d5, daysAgo(18)));
  EV(13, 'delivered', () => withTx(d5, daysAgo(13)));
  EV(11, 'deal_confirmed', () => withTx(d5, daysAgo(11)));

  // 5) Sara ⇄ Bekele — coffee beans, IN PROGRESS with funded escrow
  const d2 = dealDef('+251911000002', '+251911000003', {
    description: 'Washed arabica coffee — 80 kg', deliverable: '80 kg green beans, grade 1, Addis warehouse',
    amount: 24000, escrow: true, createdOffset: 6, deadlineDaysAfter: 20,
  });
  EV(6, 'deal_created', () => d2);
  EV(5, 'terms_agreed', () => withTx(d2, daysAgo(5)));
  EV(4, 'escrow_funded', () => withTx(d2, daysAgo(4)));
  EV(3, 'deal_started', () => withTx(d2, daysAgo(3)));

  // 6) Abebe → Sara — pending request awaiting acceptance
  const d3 = dealDef('+251911000001', '+251911000002', {
    description: 'Online shop landing page tweaks', deliverable: 'Updated landing page + 2h support',
    amount: 3000, createdOffset: 2, deadlineDaysAfter: 14,
  });
  EV(2, 'deal_created', () => d3);

  // ── apply timeline oldest → newest (largest offset first) ────────
  timeline.sort((a, b) => b[0] - a[0]);

  for (const [_offset, event, fn] of timeline) {
    const data = fn();

    if (event === 'deal_created') {
      const { termsJson, termsHash } = termsOf(data);
      const { lastId } = await db.run(
        `INSERT INTO transactions
           (ref, description, deliverable, amount, currency, deadline, party_a_id, party_b_id,
            status, escrow_enabled, escrow_state, escrow_ref, terms_json, terms_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'none', '', ?, ?, ?)`,
        [data.ref, data.description, data.deliverable, data.amount, data.currency, data.deadline,
         data.party_a_id, data.party_b_id, data.escrow_enabled, termsJson, termsHash, daysAgo(data.createdOffset)]
      );
      txRefs[data.ref] = lastId;
      await appendLedger(event, {
        txId: lastId, userId: data.party_a_id,
        payload: { ref: lastId, description: data.description, deliverable: data.deliverable, amount: data.amount, currency: data.currency, deadline: data.deadline, partyB: data.party_b_id, escrow: !!data.escrow_enabled },
        at: daysAgo(data.createdOffset),
      });
    } else {
      const txId = txRefs[data.ref];
      if (!txId) throw new Error(`seed: tx ${data.ref} not found for ${event}`);
      await appendLedger(event, { txId, at: data.at });
    }
  }

  // ── finalize row states ───────────────────────────────────────────
  const d1Id = txRefs[d1.ref];
  await db.run(
    `UPDATE transactions SET status = 'confirmed', agreed_at = ?, started_at = ?, delivered_at = ?, delivered_by = ?, confirmed_at = ?, escrow_state = 'released', escrow_ref = 'TBR-SEED-01' WHERE id = ?`,
    [daysAgo(54), daysAgo(50), daysAgo(41), abebe, daysAgo(40), d1Id]
  );

  const d4Id = txRefs[d4.ref];
  await db.run(
    `UPDATE transactions SET status = 'failed', agreed_at = ?, started_at = ?, delivered_at = ?, delivered_by = ?, failed_at = ?, disputed_at = ?, escrow_state = 'refunded', escrow_ref = 'TBR-SEED-02' WHERE id = ?`,
    [daysAgo(34), daysAgo(32), daysAgo(30), girma, daysAgo(28), daysAgo(29), d4Id]
  );
  await db.run(
    `INSERT INTO disputes (transaction_id, raised_by, reason, status, resolution, verdict, created_at, resolved_at)
     VALUES (?, ?, ?, 'resolved', 'failed', 'party_a', ?, ?)`,
    [d4Id, tesfaye, 'Laptop returned still broken — no refund offered.', daysAgo(29), daysAgo(28)]
  );
  await db.run(
    `INSERT INTO dispute_votes (dispute_id, moderator_id, verdict, note, created_at)
     VALUES ((SELECT id FROM disputes WHERE transaction_id = ?), ?, 'party_a', 'Evidence shows device still faulty; refund the payer.', ?)`,
    [d4Id, lidya, daysAgo(28)]
  );

  // small deals: finalize with their real timeline timestamps
  for (const sd of smallDefs) {
    const off = sd.createdOffset;
    await db.run(
      `UPDATE transactions SET status = 'confirmed', agreed_at = ?, started_at = ?, delivered_at = ?, delivered_by = ?, confirmed_at = ? WHERE id = ?`,
      [daysAgo(off - 0.4), daysAgo(off - 1.2), daysAgo(off - 2.1), girma, daysAgo(off - 2.5), txRefs[sd.ref]]
    );
  }

  const d5Id = txRefs[d5.ref];
  await db.run(
    `UPDATE transactions SET status = 'confirmed', agreed_at = ?, started_at = ?, delivered_at = ?, delivered_by = ?, confirmed_at = ?, escrow_state = 'released', escrow_ref = 'TBR-SEED-03' WHERE id = ?`,
    [daysAgo(20), daysAgo(18), daysAgo(13), hana, daysAgo(11), d5Id]
  );

  const d2Id = txRefs[d2.ref];
  await db.run(
    `UPDATE transactions SET status = 'in_progress', agreed_at = ?, started_at = ?, escrow_state = 'funded', escrow_ref = 'TBR-SEED-04' WHERE id = ?`,
    [daysAgo(5), daysAgo(3), d2Id]
  );

  // ── reputation for everyone ────────────────────────────────────────
  for (const id of Object.values(ids)) await computeReputation(id);

  console.log('\n  ✔ Zemen demo data seeded.');
  console.log('\n  Demo accounts (OTP appears in the server console on request):');
  console.log('    Abebe Kebede   +251 911 000 001  (freelance, verified)');
  console.log('    Sara Tesfaye   +251 911 000 002  (trade, verified)');
  console.log('    Bekele Alemu   +251 911 000 003  (agriculture, pending verification)');
  console.log('    Lidya Hailu    +251 911 000 004  (moderator & staff)');
  console.log('    Tesfaye Girma  +251 911 000 005  (flag example: one-sided pattern)');
  console.log('    Girma Haile    +251 911 000 006  (flag example)');
  console.log('    Hana Worku     +251 911 000 007  (agriculture, verified)');
  console.log('    Meron Assefa   +251 911 000 008  (moderator & staff)\n');
}

async function main() {
  await initDb();
  await initSchema();

  const existing = await db.get('SELECT id FROM users WHERE phone = ?', ['+251911000001']);
  if (existing) {
    console.log('  Zemen is already seeded — skipping. (Delete server/data/zemen.db to reseed.)');
    process.exit(0);
  }

  await runSeed();
  await db.close();
}

// Only run the CLI path when seed.js is executed directly (imports from
// scripts must not trigger a seed).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
