import { createHash, randomBytes, randomInt } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/**
 * Deterministic, canonical serialisation for hashing objects:
 * keys sorted recursively, no whitespace — so the same object always
 * produces the same hash regardless of insertion order.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Short human-friendly unique reference, e.g. ZMN-XXXX1234 */
export function genRef(prefix = 'ZMN') {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`;
}

export const genOtp = () => String(randomInt(100000, 1000000));

/** Random hex id for session tokens / fingerprint storage. */
export const genId = () => randomBytes(16).toString('hex');

export const nowIso = () => new Date().toISOString();

/** Normalise a phone number: digits only, keep leading + */
export function normalizePhone(raw) {
  const s = String(raw || '').trim().replace(/[\s()-]/g, '');
  if (!/^\+?\d{9,15}$/.test(s)) return null;
  return s;
}
