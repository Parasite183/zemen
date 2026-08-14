// ─────────────────────────────────────────────────────────────────────
// File uploads (ID documents + dispute evidence).
//
// Two backing stores share one multer interface:
//   • Local disk (default)     — server/uploads/<subdir>/…
//   • Cloudflare R2            — automatic when running on Workers with
//                                an R2 binding named `UPLOADS`.
//
// file.path is normalised to a browser-addressable /uploads/… URL in
// both cases, so routes and the frontend never care which store is
// active. The R2 object key is the same path minus the /uploads prefix.
// ─────────────────────────────────────────────────────────────────────
import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';
import { config, serverRoot } from './config.js';

const UPLOAD_TYPES = /jpeg|jpg|png|gif|webp|pdf|heic|heif/;
const fileFilter = (_req, file, cb) => cb(null, UPLOAD_TYPES.test(file.mimetype) || UPLOAD_TYPES.test(file.originalname));
const limits = { fileSize: 10 * 1024 * 1024 };

function safeName(file) {
  const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
  return `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safe}`;
}

/** R2-backed storage engine (Cloudflare Workers). */
function r2Storage(subdir) {
  return {
    _handleFile(req, file, cb) {
      const bucket = (globalThis.__ZEMEN_BINDINGS || {}).UPLOADS;
      if (!bucket) return cb(new Error('R2 bucket not configured'));
      file.filename = safeName(file);
      const key = `${subdir}/${file.filename}`;
      // On workerd, Node streams are web streams under the hood, so the
      // busboy file stream can be handed to R2.put directly.
      const body = typeof file.stream?.toWeb === 'function' ? file.stream.toWeb() : file.stream;
      bucket
        .put(key, body, { httpMetadata: { contentType: file.mimetype || 'application/octet-stream' } })
        .then(() => {
          file.key = key;
          cb(null, { size: file.size || 0 });
        })
        .catch((err) => cb(err));
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
