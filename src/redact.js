// Replace secret values in program output with ***NAME***.
//
// Catches the plain value and its common encodings (base64, hex, URL-encoded).
// It works on a stream, so a secret split across two chunks is still caught.
// It cannot catch a value that the program transformed in some other way.

import { StringDecoder } from 'node:string_decoder';

/** Values shorter than this are not redacted: they would match ordinary text. */
export const MIN_REDACT_LENGTH = 4;

function variants(value) {
  const buf = Buffer.from(value, 'utf8');
  const b64 = buf.toString('base64');
  const hex = buf.toString('hex');
  return new Set([
    value,
    b64,
    b64.replace(/=+$/, ''),
    buf.toString('base64url'),
    hex,
    hex.toUpperCase(),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]);
}

export function createRedactor(secrets) {
  const patterns = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length < MIN_REDACT_LENGTH) continue;
    for (const text of variants(value)) {
      if (text.length >= MIN_REDACT_LENGTH) patterns.push({ text, mask: `***${name}***` });
    }
  }
  patterns.sort((a, b) => b.text.length - a.text.length);
  const hold = patterns.length ? patterns[0].text.length - 1 : 0;

  let buf = '';

  // Redact buf up to `limit`. A match that starts before the limit is always
  // consumed whole. Text after the limit stays in buf, untouched, for later.
  function drain(limit) {
    let out = '';
    let i = 0;
    while (i < limit) {
      let at = -1;
      let hit = null;
      for (const p of patterns) {
        const idx = buf.indexOf(p.text, i);
        if (idx !== -1 && (at === -1 || idx < at)) {
          at = idx;
          hit = p;
        }
      }
      if (!hit || at >= limit) {
        out += buf.slice(i, limit);
        i = limit;
        break;
      }
      out += buf.slice(i, at) + hit.mask;
      i = at + hit.text.length;
    }
    buf = buf.slice(i);
    return out;
  }

  return {
    /** Feed text; returns what is safe to show now. */
    push(text) {
      buf += text;
      return drain(buf.length - hold);
    },
    /** Returns everything still held back. */
    flush() {
      return drain(buf.length);
    },
    /** Redact a complete string in one go. */
    all(text) {
      return createRedactor(secrets).finish(text);
    },
    finish(text) {
      buf += text;
      return drain(buf.length);
    },
  };
}

/** Redacts a byte stream (handles multi-byte characters split across chunks). */
export function createStreamRedactor(secrets, write, idleMs = 100) {
  const redactor = createRedactor(secrets);
  const decoder = new StringDecoder('utf8');
  let timer = null;

  const emit = (text) => {
    if (text) write(text);
  };

  return {
    write(chunk) {
      emit(redactor.push(decoder.write(chunk)));
      // If the program goes quiet (for example it is waiting for input),
      // show what we are holding instead of hiding a prompt forever.
      clearTimeout(timer);
      timer = setTimeout(() => emit(redactor.flush()), idleMs);
    },
    end() {
      clearTimeout(timer);
      emit(redactor.finish(decoder.end()));
    },
  };
}
