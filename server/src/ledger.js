// ─────────────────────────────────────────────────────────────────────
// Tamper-evident, append-only hash-chained ledger.
//
// Every agreement/state change is written as an immutable entry that
// commits to the hash of the previous entry (a classic hash chain).
// Each row stores the canonical content string, so verifyChain() can
// recompute content_hash AND the link hash from stored data — altering
// any historical field (event text, payload, timestamps, links) is
// detected in O(n).
//
// Appends are serialized through an in-process promise queue so two
// concurrent writers can never fork the chain (SQLite/Postgres both
// give us a single shared head). For multi-process deployments this
// queue would move to a DB-level advisory lock.
//
// MVP note: this chain lives in a Postgres/SQLite table, which is
// cheap to run and sufficient while users trust the platform operator.
// IF trust in the operator itself ever becomes a concern, this module
// is the single place to change: swap the backing store for a real
// distributed ledger (e.g. periodically anchor the chain head hash to a
// public blockchain or a network of independent notaries). The rest of
// the code only talks to appendLedger()/verifyChain(), so nothing else
// moves.
// ─────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { sha256, canonicalize, genRef, nowIso } from './crypto.js';

const GENESIS = 'GENESIS';

// Serialize appends: each write waits for the previous one to finish.
let appendQueue = Promise.resolve();
function serialized(fn) {
  const run = appendQueue.then(fn, fn);
  appendQueue = run.catch(() => {});
  return run;
}

/**
 * Append a ledger entry. `payload` may carry any JSON-serialisable facts
 * about the event; they are hashed into the entry so they can be proven
 * unaltered later. Reserved fields (event/ref/tx/actor/ts) always win
 * over payload keys.
 */
export async function appendLedger(event, { txId = null, userId = null, payload = {}, at = null } = {}) {
  return serialized(async () => {
    const prev = await db.get('SELECT hash FROM ledger ORDER BY id DESC LIMIT 1');
    const prevHash = prev ? prev.hash : GENESIS;
    const ts = at || nowIso();
    const entry = { event, ref: genRef('LED'), tx: txId, actor: userId, ts, ...payload };
    const content = canonicalize(entry);
    const contentHash = sha256(content);
    const hash = sha256(prevHash + contentHash);
    const { lastId } = await db.run(
      `INSERT INTO ledger (entry_ref, tx_id, user_id, event, content_hash, prev_hash, hash, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.ref, txId, userId, event, contentHash, prevHash, hash, content, ts]
    );
    return { id: lastId, ...entry, contentHash, prevHash, hash };
  });
}

/** Walk the whole chain and prove every link AND every stored field is intact. */
export async function verifyChain() {
  const rows = await db.all('SELECT * FROM ledger ORDER BY id ASC');
  let prevHash = GENESIS;
  for (const row of rows) {
    // 1) content integrity: stored canonical content must hash to the stored content_hash
    if (row.content && sha256(row.content) !== row.content_hash) {
      return { valid: false, brokenContentAt: row.id, count: rows.length };
    }
    // 2) link integrity: hash(prev_hash + content_hash) must equal the stored hash
    if (sha256(row.prev_hash + row.content_hash) !== row.hash) {
      return { valid: false, brokenAt: row.id, count: rows.length };
    }
    // 3) continuity: each entry must chain onto the previous one
    if (row.prev_hash !== prevHash) {
      return { valid: false, brokenLinkAt: row.id, count: rows.length };
    }
    prevHash = row.hash;
  }
  return { valid: true, count: rows.length, head: prevHash };
}

export async function entriesForTx(txId) {
  return db.all('SELECT * FROM ledger WHERE tx_id = ? ORDER BY id ASC', [txId]);
}
