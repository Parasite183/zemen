import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { serverRoot } = await import('../src/config.js');
const { readUploadedBytes, sniffMime, assertUploadContent } = await import('../src/uploads.js');

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

// ── magic-byte sniffing (launch checklist §Uploads) ─────────────────
test('sniffMime detects the real content type from magic bytes', () => {
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])), 'png');
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), 'jpeg');
  assert.equal(sniffMime(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3')), 'pdf');
  assert.equal(sniffMime(Buffer.from('GIF89a\x01\x00\x01\x00')), 'gif');
  assert.equal(sniffMime(Buffer.from('RIFF' + '\x24\x00\x00\x00' + 'WEBP')), 'webp');
  assert.equal(sniffMime(Buffer.from('not an image at all')), null);
  assert.equal(sniffMime(Buffer.alloc(0)), null);
});

test('assertUploadContent rejects content that does not match the claimed type', async () => {
  // PDF bytes pretending to be a .png image — the classic polyglot trick.
  const bytes = Buffer.from('%PDF-1.7 fake pdf inside a png filename');
  const name = `mismatch-${process.pid}-${Date.now()}.png`;
  const diskPath = path.join(serverRoot, 'uploads', 'ids', name);
  fs.mkdirSync(path.dirname(diskPath), { recursive: true });
  fs.writeFileSync(diskPath, bytes);
  try {
    await assert.rejects(
      assertUploadContent({ path: `/uploads/ids/${name}`, mimetype: 'image/png', originalname: name }),
      (e) => /does not match/.test(e.message),
      'a .png claiming file that is really a PDF is rejected'
    );
  } finally {
    fs.rmSync(diskPath, { force: true });
  }
});

test('assertUploadContent accepts a genuine file with matching bytes', async () => {
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png payload')]);
  const name = `genuine-${process.pid}-${Date.now()}.png`;
  const diskPath = path.join(serverRoot, 'uploads', 'ids', name);
  fs.mkdirSync(path.dirname(diskPath), { recursive: true });
  fs.writeFileSync(diskPath, bytes);
  try {
    const detected = await assertUploadContent({ path: `/uploads/ids/${name}`, mimetype: 'image/png', originalname: name });
    assert.equal(detected, 'png');
  } finally {
    fs.rmSync(diskPath, { force: true });
  }
});
