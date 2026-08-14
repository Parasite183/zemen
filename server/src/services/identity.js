// ─────────────────────────────────────────────────────────────────────
// Identity layer — unique-human binding (anti-sybil).
//
// All checks here are *gates* and *flags*: they raise the cost of
// fabricating multiple "verified" accounts and make coordinated clusters
// visible to moderators. They do NOT make identity fraud impossible —
// see README "Known limitations".
//
// Swappable by design: if a real government ID API or biometric provider
// slots in later, it replaces registerIdDocument()/assertDealEligibility()
// internals without touching the deal/ledger/reputation code.
// ─────────────────────────────────────────────────────────────────────
import { db } from '../db.js';
import { config } from '../config.js';
import { sha256 } from '../crypto.js';
import { forbidden } from '../http.js';

/** Normalize a national-ID / license number for comparison. */
export function normalizeIdNumber(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Hamming distance between two perceptual-hash strings (0 = identical). */
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// Two documents are considered the same document when their perceptual
// hashes differ by this many bits (re-photographs/scans stay close).
export const PHASH_DUPLICATE_THRESHOLD = 10;

/**
 * Coarse IP prefix for clustering (IPv4 /24, IPv6 /48-ish). This is a
 * fraud-detection signal, deliberately not precise geolocation.
 */
export function ipPrefix(rawIp) {
  const ip = String(rawIp || '').trim();
  if (!ip) return '';
  // strip IPv4-in-IPv6 and port forms
  const v4 = ip.includes(':') ? (ip.match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1] : ip;
  if (v4) return v4.split('.').slice(0, 3).join('.') + '.0/24';
  // expand :: into full 8-hextet form so positions survive, then take
  // the first 3 hextets (a /48) and compress any trailing zero hextets
  const parts = ip.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const hextets = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  const p48 = hextets.slice(0, 3);
  while (p48.length > 1 && p48[p48.length - 1] === '0') p48.pop();
  return p48.join(':') + '::/48';
}

/**
 * Total lifetime deal volume a user accrued while unverified. Deals the
 * user engaged in before verification count; everything after does not.
 */
export async function unverifiedVolumeEtb(userId, verifiedAt) {
  const row = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS v FROM transactions
     WHERE (party_a_id = ? OR party_b_id = ?)
       AND (? IS NULL OR created_at <= ?)`,
    [userId, userId, verifiedAt, verifiedAt]
  );
  return Number(row?.v || 0);
}

/**
 * Gate: may `user` create/accept a deal of `amount`?
 *   • amounts above the free threshold require a verified identity
 *   • unverified accounts are capped at a lifetime volume
 * Throws an HttpError (403) with a machine-readable code when blocked.
 */
export async function assertDealEligibility(user, amount) {
  const verified = user.id_verification_status === 'verified';
  if (verified) return;
  if (amount > config.freeDealThresholdEtb) {
    throw forbidden(
      `Verify your identity to create or accept deals above ${config.freeDealThresholdEtb} ${config.defaultCurrency}`,
      'verification_required'
    );
  }
  const used = await unverifiedVolumeEtb(user.id, user.verified_at);
  if (used + amount > config.unverifiedLifetimeVolumeEtb) {
    throw forbidden(
      `Unverified accounts are limited to ${config.unverifiedLifetimeVolumeEtb} ${config.defaultCurrency} total lifetime volume`,
      'unverified_volume_cap'
    );
  }
}

/**
 * Register an ID-document upload and check it for duplicates against all
 * other accounts. Returns { duplicate, reasons, existingUserIds }.
 *   duplicate  - false, or { code, label } for the first match
 * A match on ID number, byte hash, or perceptual hash is flagged for
 * manual review — never auto-approved, never silently accepted.
 */
export async function registerIdDocument({ userId, docType = 'national_id', idNumber = '', phash = '', fileSha256 = '', filePath = '' }) {
  const idNumHash = normalizeIdNumber(idNumber) ? sha256(normalizeIdNumber(idNumber)) : '';
  const duplicate = { code: '', label: '' };
  const existing = [];

  if (idNumHash) {
    const hits = await db.all(
      `SELECT d.user_id, u.name FROM id_documents d JOIN users u ON u.id = d.user_id
       WHERE d.id_number_hash = ? AND d.user_id <> ? ORDER BY d.id LIMIT 3`,
      [idNumHash, userId]
    );
    if (hits.length) {
      duplicate.code = 'duplicate_id_number';
      duplicate.label = 'ID number already used by another account';
      existing.push(...hits.map((h) => h.user_id));
    }
  }
  if (fileSha256) {
    const hits = await db.all(
      `SELECT d.user_id FROM id_documents d WHERE d.file_sha256 = ? AND d.user_id <> ? LIMIT 3`,
      [fileSha256, userId]
    );
    if (hits.length && !duplicate.code) {
      duplicate.code = 'duplicate_document';
      duplicate.label = 'Exact same document file uploaded by another account';
      existing.push(...hits.map((h) => h.user_id));
    }
  }
  if (phash && !duplicate.code) {
    const all = await db.all(`SELECT user_id, phash FROM id_documents WHERE phash <> '' AND user_id <> ?`, [userId]);
    const hit = all.find((r) => hamming(r.phash, phash) <= PHASH_DUPLICATE_THRESHOLD);
    if (hit) {
      duplicate.code = 'duplicate_document';
      duplicate.label = 'Document image matches another account (perceptual hash)';
      existing.push(hit.user_id);
    }
  }

  const { lastId } = await db.run(
    `INSERT INTO id_documents (user_id, doc_type, id_number_hash, phash, file_sha256, file_path, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, docType, idNumHash, phash, fileSha256, filePath, duplicate.code ? 'duplicate' : 'pending', duplicate.label, new Date().toISOString()]
  );

  return { id: lastId, duplicate, existingUserIds: existing };
}
