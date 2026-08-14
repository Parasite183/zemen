// Minimal dependency-free PNG writer shared by the smoke scripts so they
// can fabricate a small "document scan" image for ID uploads (the repo
// installs no pixel libraries). Deterministic 24×16 RGBA noise.
import fs from 'node:fs';
import zlib from 'node:zlib';

export function writeTestPng(filePath, w = 24, h = 16) {
  const raw = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      raw[i] = (x * 7 + y * 3) % 256;
      raw[i + 1] = (y * 11 + x * 5) % 256;
      raw[i + 2] = (x * 13 + y * 7) % 256;
      raw[i + 3] = 255;
    }
  }
  const stride = w * 4 + 1; // filter byte + RGBA row
  const scan = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    scan[y * stride] = 0;
    raw.copy(scan, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const crc32 = (buf) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fs.writeFileSync(filePath, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]));
}
