import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { serverRoot, config } from './config.js';
import { initDb } from './db.js';
import { initSchema } from './schema.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import dealRoutes from './routes/deals.js';
import disputeRoutes from './routes/disputes.js';
import reportRoutes from './routes/reports.js';

// Upload middleware (multer) lives in uploads.js: local disk by
// default, Cloudflare R2 on Workers.

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Cloudflare Workers only: workerd forbids async I/O (like D1
  // queries) in module global scope, so the DB + schema must be
  // initialised lazily inside a request handler. Plain Node inits at
  // startup (server/src/index.js) and skips this middleware.
  if (config.worker) {
    let dbInitPromise = null;
    const ensureDb = () => {
      dbInitPromise ??= (async () => {
        await initDb();
        await initSchema();
      })().catch((err) => {
        dbInitPromise = null; // allow a retry on the next request
        throw err;
      });
      return dbInitPromise;
    };
    app.use(async (req, res, next) => {
      try {
        await ensureDb();
        next();
      } catch (err) {
        next(err);
      }
    });
  }

  // Local dev only: serve uploaded files from disk.
  if (!config.worker) {
    app.use('/uploads', express.static(path.join(serverRoot, 'uploads'), { maxAge: '7d' }));
  }

  // Cloudflare Workers: uploads live in R2. The object key is the path
  // after /uploads/ (e.g. /uploads/ids/x.jpg → key ids/x.jpg).
  if (config.worker) {
    app.use('/uploads', async (req, res, next) => {
      const bucket = (globalThis.__ZEMEN_BINDINGS || {}).UPLOADS;
      if (!bucket) return next();
      try {
        const key = decodeURIComponent(req.path.replace(/^\/+/, ''));
        const obj = await bucket.get(key);
        if (!obj) return res.status(404).json({ error: 'Not found', code: 'not_found' });
        res.set('content-type', obj.httpMetadata?.contentType || 'application/octet-stream');
        res.set('cache-control', 'public, max-age=604800');
        if (obj.httpEtag) res.set('etag', obj.httpEtag);
        res.send(Buffer.from(await obj.arrayBuffer()));
      } catch (err) {
        next(err);
      }
    });
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'zemen-api' }));
  app.use('/api/auth', authRoutes);
  // Public (token-addressable) routes must be mounted before the authed
  // /api routers so they are not shadowed by their auth middleware.
  app.use('/api', reportRoutes);    // /public/report/:token, /ledger/verify
  app.use('/api', userRoutes);      // /me, /users/:id, /directory
  app.use('/api/deals', dealRoutes);
  app.use('/api/disputes', disputeRoutes);

  // Serve the built frontend in production on plain Node (not on
  // Workers — Cloudflare Pages handles the static site there).
  if (config.nodeEnv === 'production' && !config.worker) {
    const dist = path.join(serverRoot, '..', 'web', 'dist');
    app.use(express.static(dist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message, code: 'upload_error' });
    console.error('[zemen] unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', code: 'internal' });
  });

  return app;
}
