import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { serverRoot } = await import('../src/config.js');
const { readUploadedBytes } = await import('../src/uploads.js');

// Regression test for the ID-document upload flow.
//
// multer writes the file to disk under serverRoot/uploads/<subdir>, then
// withPath (uploads.js) rewrites req.file.path into a browser-addressable
// /uploads/<subdir>/<name> URL before the route ever runs. The route
// calls readUploadedBytes(req.file) to hash the exact bytes, so the
// reader must map that URL-form path back to the on-disk location.
// It used to read the URL verbatim, which ENOENT'd on every platform and
// made ID-document uploads 500 with no document ever stored.
test('readUploadedBytes resolves a /uploads URL path back to disk', async () => {
  const bytes = Buffer.from('fake national ID scan — bytes that must round-trip exactly');
  const name = `test-${process.pid}-${Date.now()}.png`;
  const diskPath = path.join(serverRoot, 'uploads', 'ids', name);
  fs.mkdirSync(path.dirname(diskPath), { recursive: true });
  fs.writeFileSync(diskPath, bytes);
  try {
    // exactly the file object shape withPath leaves behind:
    //   { path: '/uploads/ids/<name>' } and no R2 `key`
    const out = await readUploadedBytes({ path: `/uploads/ids/${name}` });
    assert.deepEqual(out, bytes, 'bytes read back from the URL-normalised path');
  } finally {
    fs.rmSync(diskPath, { force: true });
  }
});

// A missing on-disk file must still throw (a real ENOENT is better than
// silently hashing empty bytes, which would defeat duplicate detection).
test('readUploadedBytes throws when the resolved file does not exist', async () => {
  await assert.rejects(
    readUploadedBytes({ path: '/uploads/ids/does-not-exist.png' }),
    (e) => e.code === 'ENOENT'
  );
});
