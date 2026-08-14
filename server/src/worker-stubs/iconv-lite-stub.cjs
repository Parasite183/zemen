// ─────────────────────────────────────────────────────────────────────
// Build-time stand-in for `iconv-lite` (transitive dep of Express's
// body-parser via raw-body).
//
// Why: iconv-lite ships a `browser` field that maps ./lib/streams and
// ./lib/extend-node to false, so esbuild (which wrangler runs with the
// browser platform) replaces them with empty modules. Under
// nodejs_compat the runtime still takes the Node code path and calls
// require("./streams")(iconv) -> "require_streams(...) is not a
// function". raw-body only needs iconv.getDecoder(), so this stub
// implements just that on top of TextDecoder. `.cjs` so raw-body's
// CommonJS require() gets module.exports directly — an ESM default
// export would land the API on `.default` and break the call site.
// ─────────────────────────────────────────────────────────────────────
'use strict';

// iconv-lite labels -> WHATWG TextDecoder labels.
const LABELS = {
  'binary': 'latin1',
  'latin1': 'latin1',
  'iso-8859-1': 'latin1',
  'iso8859-1': 'latin1',
  'ascii': 'windows-1252',
  'us-ascii': 'windows-1252',
  'utf8': 'utf-8',
  'utf-8': 'utf-8',
  'utf16le': 'utf-16le',
  'utf-16le': 'utf-16le',
  'ucs2': 'utf-16le',
  'ucs-2': 'utf-16le'
};

function labelFor (encoding) {
  const key = String(encoding || 'utf8').toLowerCase();
  return LABELS[key] || key;
}

function getDecoder (encoding) {
  let decoder;
  try {
    decoder = new TextDecoder(labelFor(encoding));
  } catch (e) {
    // Match iconv-lite's error contract so raw-body converts this to a
    // 415 "specified encoding unsupported" instead of crashing.
    const err = new Error('Encoding not recognized: ' + encoding);
    err.code = 'ENCODING_NOT_RECOGNIZED';
    throw err;
  }
  return {
    write: (chunk) => decoder.decode(chunk, { stream: true }),
    end: () => decoder.decode()
  };
}

function encodingExists (encoding) {
  try {
    new TextDecoder(labelFor(encoding));
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { getDecoder, encodingExists };
