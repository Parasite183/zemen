// ─────────────────────────────────────────────────────────────────────
// Coarse device fingerprint — collected at signup for FRAUD DETECTION
// only (clustering new accounts that share a device/IP to catch sybil
// clusters), never for advertising or tracking. The signals are coarse
// and non-identifying on purpose; this is a low-cost deterrent, not a
// biometric.
// ─────────────────────────────────────────────────────────────────────

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function deviceFingerprint() {
  const parts = [
    navigator.userAgent,
    navigator.language,
    navigator.platform || '',
    `${screen.width}x${screen.height}`,
    navigator.hardwareConcurrency || 0,
    navigator.maxTouchPoints || 0,
    navigator.deviceMemory || 0,
    (Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone) || '',
  ];
  return fnv1a(parts.join('|'));
}
