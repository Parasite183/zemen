// Schema shared by SQLite, PostgreSQL and Cloudflare D1.
// Convention: ISO-8601 TEXT timestamps, INTEGER booleans, JSON as TEXT.
import { db } from './db.js';

const TABLES = (idCol) => [
  `CREATE TABLE IF NOT EXISTS users (
    id ${idCol},
    phone TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '',
    category TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    id_verification_status TEXT DEFAULT 'none',   -- none | pending | verified | rejected
    id_doc_path TEXT DEFAULT '',
    is_moderator INTEGER DEFAULT 0,
    is_staff INTEGER DEFAULT 0,
    report_token TEXT UNIQUE,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS otp_codes (
    id ${idCol},
    phone TEXT NOT NULL,
    code TEXT NOT NULL,
    purpose TEXT DEFAULT 'login',
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS transactions (
    id ${idCol},
    ref TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,
    deliverable TEXT DEFAULT '',
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'ETB',
    deadline TEXT,
    party_a_id INTEGER NOT NULL,                  -- deal creator (and payer when escrow is used)
    party_b_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',                -- pending|agreed|in_progress|delivered|confirmed|disputed|failed
    escrow_enabled INTEGER DEFAULT 0,
    escrow_state TEXT DEFAULT 'none',             -- none|funded|released|refunded
    escrow_ref TEXT DEFAULT '',
    terms_hash TEXT DEFAULT '',
    terms_json TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    agreed_at TEXT,
    started_at TEXT,
    delivered_at TEXT,
    delivered_by INTEGER,
    confirmed_at TEXT,
    failed_at TEXT,
    disputed_at TEXT
  )`,

  // Tamper-evident append-only ledger (see src/ledger.js).
  `CREATE TABLE IF NOT EXISTS ledger (
    id ${idCol},
    entry_ref TEXT UNIQUE NOT NULL,
    tx_id INTEGER,
    user_id INTEGER,
    event TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS disputes (
    id ${idCol},
    transaction_id INTEGER NOT NULL,
    raised_by INTEGER NOT NULL,
    reason TEXT DEFAULT '',
    status TEXT DEFAULT 'open',                   -- open | resolved
    resolution TEXT DEFAULT '',                   -- confirmed | failed
    verdict TEXT DEFAULT '',                      -- party_a | party_b
    created_at TEXT NOT NULL,
    resolved_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS dispute_statements (
    id ${idCol},
    dispute_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS dispute_evidence (
    id ${idCol},
    dispute_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    file_name TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS dispute_votes (
    id ${idCol},
    dispute_id INTEGER NOT NULL,
    moderator_id INTEGER NOT NULL,
    verdict TEXT NOT NULL,                        -- party_a | party_b
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(dispute_id, moderator_id)
  )`,

  `CREATE TABLE IF NOT EXISTS reputation_scores (
    user_id INTEGER PRIMARY KEY,
    completion_rate REAL DEFAULT 0,
    on_time_rate REAL DEFAULT 0,
    dispute_rate REAL DEFAULT 0,
    total_volume REAL DEFAULT 0,
    total_completed INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    total_disputed INTEGER DEFAULT 0,
    weighted_volume REAL DEFAULT 0,
    flags_json TEXT DEFAULT '[]',
    last_updated TEXT NOT NULL
  )`,
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_tx_a ON transactions(party_a_id)',
  'CREATE INDEX IF NOT EXISTS idx_tx_b ON transactions(party_b_id)',
  'CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status)',
  'CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger(tx_id)',
  'CREATE INDEX IF NOT EXISTS idx_disputes_tx ON disputes(transaction_id)',
  'CREATE INDEX IF NOT EXISTS idx_users_category ON users(category)',
];

/** Full DDL as executable statements (used by initSchema and the D1 seed dump). */
export function schemaDdl() {
  const idCol = db.dialect === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  return { tables: TABLES(idCol), indexes: INDEXES };
}

export async function initSchema() {
  const { tables, indexes } = schemaDdl();
  for (const sql of tables) await db.run(sql);
  for (const sql of indexes) await db.run(sql);
  await migrateLedgerContent();
}

/** DBs created before the `content` column existed need it added. */
async function migrateLedgerContent() {
  if (db.dialect === 'pg') {
    await db.run(`ALTER TABLE ledger ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT ''`);
    return;
  }
  const cols = await db.all(`SELECT name FROM pragma_table_info('ledger')`);
  if (!cols.some((c) => c.name === 'content')) {
    await db.run(`ALTER TABLE ledger ADD COLUMN content TEXT NOT NULL DEFAULT ''`);
  }
}
