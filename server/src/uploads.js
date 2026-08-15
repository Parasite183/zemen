// ─────────────────────────────────────────────────────────────────────
// File uploads (ID documents + dispute evidence).
//
// Two backing stores share one multer interface:
//   • Local disk (default)     — server/uploads/<subdir>/… (dev only)
//   • Cloudflare R2            — automatic when running on Workers with
//                                an R2 binding named `UPLOADS`.
//
// file.path is normalised to a browser-addressable /uploads/… URL in
// both cases, so routes and the frontend never care which store is
// active. The R2 object key is the same path minus the /uploads prefix.
//
// Security (launch checklist §Uploads):
//   • strict allowlist — image/PDF only, enforced by claimed MIME type
//     AND filename extension
//   • max size — 10 MB per file (multer `limits`)
//   • magic-byte sniffing — assertUploadContent() rejects any file whose
//     real bytes don't match its claimed type (see sniffMime)
//   • private by default — files are never publicly web-servable: the
//     /uploads route is access-gated (owner/staff for ID documents,
//     parties/moderators for evidence) — see requireUploadAccess().
//     On Cloudflare the R2 bucket itself is private; only the Worker
//     route (behind the gate) can read it.
//   • perceptual-hash dedup — the phash check in services/identity.js
//     runs on every ID-document upload (exact SHA-256 always, phash
//     when the client supplies it); evidence uploads are hashed for
//     dedup in the same route path.
// ─────────────────────────────────────────────────────────────────────
import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';
import { config, serverRoot } from './config.js';
import { db } from './db.js';

const UPLOAD_TYPES = /jpeg|jpg|png|gif|webp|pdf|heic|heif/;
const fileFilter = (_req, file, cb) => cb(null, UPLOAD_TYPES.test(file.mimetype) || UPLOAD_TYPES.test(file.originalname));
const limits = { fileSize: 10 * 1024 * 1024 };

// ── magic-byte sniffing ──────────────────────────────────────────────
// Canonical type detected from a file's actual content, not its
// claimed MIME type. A mismatch means the upload is lying about what
// it is (the classic way to smuggle executables/HTML past a filter).
const MAGIC = [
  // [name, matcher(bytes)]
  ['pdf', (b) => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46],            // %PDF
  ['png', (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['jpeg', (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],                               // \xFF\xD8\xFF
  ['gif', (b) => b.length >= 6 && b.subarray(0, 6).toString('ascii') === 'GIF87a' || (b.length >= 6 && b.subarray(0, 6).toString('ascii') === 'GIF89a')],
  ['webp', (b) => b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP'],
  // HEIC/HEIF — ISO BMFF box with an ftyp brand. Phone ID photos are
  // often HEIC on iOS, so accept it but never treat it as anything else.
  ['heic', (b) => {
    if (b.length < 12 || b.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
    const brand = b.subarray(8, 12).toString('ascii');
    return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
  }],
];

/** Detect the real type of `bytes` from magic bytes, or null. */
export function sniffMime(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  for (const [name, match] of MAGIC) if (match(b)) return name;
  return null;
}

// Claimed MIME type / extension → canonical type (same vocabulary as
// sniffMime). Anything outside the allowlist is rejected outright.
const MIME_TO_TYPE = {
  'image/jpeg': 'jpeg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heic',
  'application/pdf': 'pdf',
};
const EXT_TO_TYPE = {
  '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.gif': 'gif',
  '.webp': 'webp', '.heic': 'heic', '.heif': 'heic', '.pdf': 'pdf',
};

/**
 * Verify an uploaded file's real content matches its claimed type.
 * Reads the file back from wherever it landed (R2 or disk) and rejects
 * on: unrecognised bytes, a claimed MIME outside the allowlist, or a
 * claimed type that disagrees with the sniffed bytes.
 */
export async function assertUploadContent(file, { badRequest } = {}) {
  const bytes = await readUploadedBytes(file);
  if (!bytes || bytes.length === 0) {
    throw badRequest ? badRequest('Uploaded file is empty', 'file_empty') : new Error('Uploaded file is empty');
  }
  const detected = sniffMime(bytes);
  if (!detected) {
    throw badRequest ? badRequest('File type not allowed — images and PDF only', 'file_type_unsupported') : new Error('File type not allowed — images and PDF only');
  }
  const claimedMime = String(file.mimetype || '').toLowerCase();
  const claimedExt = String(path.extname(file.originalname || '')).toLowerCase();
  const claimedType = MIME_TO_TYPE[claimedMime] || EXT_TO_TYPE[claimedExt] || null;
  if (!claimedType) {
    throw badRequest ? badRequest('File type not allowed — images and PDF only', 'file_type_unsupported') : new Error('File type not allowed — images and PDF only');
  }
  if (claimedType !== detected) {
    throw badRequest ? badRequest('File content does not match its declared type', 'file_type_mismatch') : new Error('File content does not match its declared type');
  }
  return detected;
}

function safeName(file) {
  const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
  return `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safe}`;
}

/** R2-backed storage engine (Cloudflare Workers). */
export function r2Storage(subdir) {
  return {
    async _handleFile(req, file, cb) {
      const bucket = (globalThis.__ZEMEN_BINDINGS || {}).UPLOADS;
      if (!bucket) return cb(new Error('R2 bucket not configured'));
      try {
        file.filename = safeName(file);
        const key = `${subdir}/${file.filename}`;
        // R2.put requires a real web body (ReadableStream / ArrayBuffer /
        // string / Blob) — a Node stream is rejected even under
        // nodejs_compat ("parameter 2 is not of type ..."). Buffer the
        // whole file into memory (multer already caps it at 10 MB) and
        // hand R2 the exact bytes.
        const chunks = [];
        for await (const chunk of file.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        await bucket.put(key, body, { httpMetadata: { contentType: file.mimetype || 'application/octet-stream' } });
        file.key = key;
        cb(null, { size: body.length });
      } catch (err) {
        cb(err);
      }
    },
    _removeFile(req, file, cb) {
      const bucket = (globalThis.__ZEMEN_BINDINGS || {}).UPLOADS;
      if (!bucket || !file.key) return cb(null);
      bucket.delete(file.key).then(() => cb(null)).catch((err) => cb(err));
    },
  };
}

/** Local-disk storage engine (default). */
function diskStorage(subdir) {
  const dir = path.join(serverRoot, 'uploads', subdir);
  fs.mkdirSync(dir, { recursive: true });
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => cb(null, safeName(file)),
  });
}

/** Normalise file.path to a /uploads/<subdir>/<filename> URL. */
function withPath(subdir, middleware) {
  return (req, res, next) =>
    middleware(req, res, (err) => {
      if (!err && req.file) req.file.path = `/uploads/${subdir}/${req.file.filename}`;
      next(err);
    });
}

function makeUploads() {
  const bindings = globalThis.__ZEMEN_BINDINGS || {};
  const useR2 = config.worker && bindings.UPLOADS;
  const storageFor = (subdir) => (useR2 ? r2Storage(subdir) : diskStorage(subdir));

  return {
    uploadId: withPath('ids', multer({ storage: storageFor('ids'), fileFilter, limits }).single('document')),
    uploadEvidence: withPath('evidence', multer({ storage: storageFor('evidence'), fileFilter, limits }).single('file')),
  };
}

export const { uploadId, uploadEvidence } = makeUploads();

// ── access control for serving uploads ───────────────────────────────
// Uploads are private data: ID documents are sensitive PII, evidence
// belongs to a dispute. The /uploads route (R2-backed on Workers) is
// mounted behind this gate in app.js — nothing under /uploads is ever
// publicly web-servable.
//   /uploads/ids/…      → the document's owner, or staff/moderators
//   /uploads/evidence/… → a party to the dispute, or staff/moderators
export function requireUploadAccess() {
  return async (req, res, next) => {
    try {
      const key = decodeURIComponent(req.path.replace(/^\/+/, ''));
      if (!key) return next();
      if (!req.user) return res.status(401).json({ error: 'Not authenticated', code: 'unauthorized' });
      // Staff and moderators can review anything (their queues surface
      // document paths for manual verification).
      if (req.user.is_staff || req.user.is_moderator) return next();

      const url = `/uploads/${key}`;
      const kind = key.split('/')[0];
      if (kind === 'ids') {
        const doc = await db.get('SELECT user_id FROM id_documents WHERE file_path = ? LIMIT 1', [url]);
        if (doc && doc.user_id === req.user.id) return next();
      } else if (kind === 'evidence') {
        const row = await db.get(
          `SELECT t.party_a_id, t.party_b_id FROM dispute_evidence e
           JOIN disputes d ON d.id = e.dispute_id
           JOIN transactions t ON t.id = d.transaction_id
           WHERE e.file_path = ? LIMIT 1`,
          [url]
        );
        if (row && (row.party_a_id === req.user.id || row.party_b_id === req.user.id)) return next();
      }
      return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Delete an uploaded file by its /uploads/... path (R2 on Workers,
 * disk otherwise). Best-effort: a missing object is not an error.
 */
export async function deleteUploadedFile(uploadPath) {
  const urlPath = String(uploadPath || '').replaceAll('\\', '/');
  if (!urlPath.startsWith('/uploads/')) return;
  const key = urlPath.replace(/^\/+uploads\//, '');
  if (!key) return;
  const bucket = (globalThis.__ZEMEN_BINDINGS || {}).UPLOADS;
  if (config.worker && bucket) {
    await bucket.delete(key).catch(() => {});
    return;
  }
  // Local disk (dev only): map /uploads/<subdir>/<name> back to disk.
  const rel = key.replace(/^\//, '');
  const diskPath = path.join(serverRoot, 'uploads', rel);
  fs.rmSync(diskPath, { force: true });
}

/**
 * Read an uploaded file's bytes back from whatever store it landed in
 * (R2 on Workers, disk otherwise) — used for exact-duplicate hashing of
 * ID documents.
 */
export async function readUploadedBytes(file) {
  if (file.key) {
    const bucket = (globalThis.__ZEMEN_BINDINGS || {}).UPLOADS;
    const obj = await bucket.get(file.key);
    if (!obj) return Buffer.alloc(0);
    return Buffer.from(await obj.arrayBuffer());
  }
  // withPath normalised file.path to a /uploads/... URL — map it back to
  // the on-disk location under serverRoot before reading.
  const rel = String(file.path || '').replace(/^\/+uploads\//, '');
  return fs.readFileSync(path.join(serverRoot, 'uploads', rel));
}
