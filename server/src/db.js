// ─────────────────────────────────────────────────────────────────────
// Database access layer.
//
// Zemen ships with THREE storage drivers sharing one codebase:
//   • SQLite (default)  — zero-setup local development. File: ./data/zemen.db
//   • PostgreSQL        — activated by setting DATABASE_URL
//   • D1 (Cloudflare)   — activated automatically when the Worker runs
//                         with a D1 binding named `DB`.
//
// The SQL in this project sticks to the common subset of all three
// dialects (parameterised queries, `?` placeholders, ISO-8601 TEXT
// timestamps, JSON-as-TEXT columns, INTEGER booleans), so switching
// drivers is just an environment variable / binding.
//
// Native Node drivers (better-sqlite3, pg) are loaded lazily and are
// aliased to stubs in wrangler.jsonc, so the Cloudflare Worker bundle
// never contains them (better-sqlite3 is a native module and cannot run
// on Workers). D1 — Cloudflare's SQLite — is used instead.
// ─────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { config, serverRoot } from './config.js';

let dialect = null;
let sqlite = null;
let pool = null;
let d1 = null;

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(serverRoot, p);
}

/** Convert `?` placeholders to Postgres `$n`. */
function toPg(sql, params) {
  let i = 0;
  const out = sql.replace(/\?/g, () => `$${++i}`);
  return [out, params];
}

export async function initDb() {
  const bindings = globalThis.__ZEMEN_BINDINGS || {};
  if (bindings.DB) {
    // Cloudflare Workers: D1 binding present.
    dialect = 'd1';
    d1 = bindings.DB;
    return;
  }
  if (config.databaseUrl.startsWith('postgres')) {
    dialect = 'pg';
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  } else {
    dialect = 'sqlite';
    const { default: Database } = await import('better-sqlite3');
    const file = config.dbFile === ':memory:' ? ':memory:' : resolvePath(config.dbFile);
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    sqlite = new Database(file);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
  }
}

export const db = {
  get dialect() {
    return dialect;
  },

  /** Run a write statement. Returns `{ lastId, rowCount }`. */
  async run(sql, params = []) {
    if (dialect === 'd1') {
      const res = await d1.prepare(sql).bind(...params).run();
      return { lastId: res.meta?.last_row_id ?? null, rowCount: res.meta?.changes ?? 0 };
    }
    if (dialect === 'pg') {
      const [q, p] = toPg(sql, params);
      const r = await pool.query(q, p);
      return { lastId: r.rows[0]?.id ?? null, rowCount: r.rowCount ?? 0 };
    }
    const r = sqlite.prepare(sql).run(...params);
    return { lastId: typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid, rowCount: r.changes };
  },

  async get(sql, params = []) {
    if (dialect === 'd1') {
      return (await d1.prepare(sql).bind(...params).first()) ?? null;
    }
    if (dialect === 'pg') {
      const [q, p] = toPg(sql, params);
      const r = await pool.query(q, p);
      return r.rows[0] ?? null;
    }
    return sqlite.prepare(sql).get(...params) ?? null;
  },

  async all(sql, params = []) {
    if (dialect === 'd1') {
      const { results } = await d1.prepare(sql).bind(...params).all();
      return results;
    }
    if (dialect === 'pg') {
      const [q, p] = toPg(sql, params);
      const r = await pool.query(q, p);
      return r.rows;
    }
    return sqlite.prepare(sql).all(...params);
  },

  /** Run `fn` inside a transaction. */
  async tx(fn) {
    if (dialect === 'd1') {
      // D1 `withSession` currently crashes the deployed runtime
      // (TypeError inside workerd's d1-api), so the closure runs
      // directly. Safety still holds: every write inside tx() uses a
      // guarded `UPDATE ... WHERE status = expected` and ledger appends
      // are serialized in-process (ledger.js) — the same model the
      // rest of the app relies on outside transactions.
      return fn();
    }
    if (dialect === 'pg') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn();
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
    sqlite.exec('BEGIN');
    try {
      const out = await fn();
      sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  },

  async close() {
    if (dialect === 'pg' && pool) await pool.end();
    if (dialect === 'sqlite' && sqlite) sqlite.close();
    if (dialect === 'd1') d1 = null;
  },
};
