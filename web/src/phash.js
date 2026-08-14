// ─────────────────────────────────────────────────────────────────────
// Perceptual image hashing for ID-document dedup.
//
// dHash (difference hash): downscale to a coarse greyscale grid and
// encode whether each pixel is lighter than its right neighbour. Two
// photos of the same document (different lighting/angle/camera) end up
// with hashes a few bits apart; two different documents are far apart.
//
// Pure functions (no DOM) so server-side tests can import this file
// directly. The browser helper below runs on a canvas.
// ─────────────────────────────────────────────────────────────────────

/** dHash over an RGBA bitmap: returns a 64-char binary string. */
export function dHash(data, width, height) {
  const gw = 9; // 9×8 grid → 8×8 = 64 differences
  const gh = 8;
  const g = new Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) / gw) * width));
      const sy = Math.min(height - 1, Math.floor(((y + 0.5) / gh) * height));
      const i = (sy * width + sx) * 4;
      g[y * gw + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  let bits = '';
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw - 1; x++) {
      bits += g[y * gw + x] >= g[y * gw + x + 1] ? '1' : '0';
    }
  }
  return bits;
}

/** Hamming distance between two hash strings (0 = identical). */
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** Compute the dHash of an image File in the browser (canvas-based). */
export async function imagePhash(file) {
  const SIZE = 32; // decode to a small bitmap for stable sampling
  const bmp = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, SIZE, SIZE);
    const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
    return dHash(data, SIZE, SIZE);
  } finally {
    bmp.close?.();
  }
}
