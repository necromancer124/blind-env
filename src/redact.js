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
  // text -> how it was encoded ('' means the plain value). First entry wins.
  const forms = new Map();
  const add = (text, form) => {
    if (!forms.has(text)) forms.set(text, form);
  };
  add(value, '');
  add(JSON.stringify(value).slice(1, -1), '');
  add(b64, 'base64');
  add(b64.replace(/=+$/, ''), 'base64');
  add(buf.toString('base64url'), 'base64');
  add(hex, 'hex');
  add(hex.toUpperCase(), 'hex');
  // URL encodings differ between languages and libraries: space as %20 or +,
  // whether !'()*~ are encoded, and upper or lower case hex. Cover the common ones.
  const strict = (s) => s.replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const urlForms = new Set([
    encodeURIComponent(value), // JavaScript
    strict(encodeURIComponent(value)), // RFC 3986, PHP rawurlencode
    strict(encodeURIComponent(value)).replace(/%7E/g, '~'), // Python quote
    new URLSearchParams({ v: value }).toString().slice(2), // HTML forms, URLSearchParams
    encodeURI(value),
  ]);
  for (const u of [...urlForms]) urlForms.add(u.replace(/%20/g, '+')); // Python quote_plus, PHP urlencode
  for (const u of [...urlForms]) urlForms.add(u.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()));
  for (const u of urlForms) add(u, 'url-encoded');
  return forms;
}

export function createRedactor(secrets) {
  const patterns = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length < MIN_REDACT_LENGTH) continue;
    for (const [text, form] of variants(value)) {
      if (text.length < MIN_REDACT_LENGTH) continue;
      // The label names the key, and the encoding if it was not the plain value.
      patterns.push({ text, name, mask: form ? `***${name}:${form}***` : `***${name}***` });
    }
  }
  // Key names are left alone, even when a value appears inside one: masking
  // "test" inside "$testCloadSesh" would show what the value is. Added last so
  // that, at equal length, a real value still wins.
  for (const name of Object.keys(secrets)) {
    patterns.push({ text: name, keep: true });
  }
  patterns.sort((a, b) => b.text.length - a.text.length);
  const hold = patterns.length ? patterns[0].text.length - 1 : 0;

  let buf = '';
  const hits = {}; // key name -> how many times it was hidden

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
      if (hit.keep) {
        out += buf.slice(i, at) + hit.text;
      } else {
        out += buf.slice(i, at) + hit.mask;
        hits[hit.name] = (hits[hit.name] ?? 0) + 1;
      }
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
    /** Returns everything still held back. Only for the very end of the output. */
    flush() {
      return drain(buf.length);
    },
    /**
     * For when the program goes quiet: returns what is held back, EXCEPT an
     * ending that could be the start of a secret. That part waits for more
     * output (or the end), so a value written in two parts with a pause in
     * between is still caught.
     */
    flushIdle() {
      let keepFrom = buf.length;
      for (let j = Math.max(0, buf.length - hold); j < buf.length; j++) {
        const tail = buf.slice(j);
        if (patterns.some((p) => p.text.startsWith(tail))) {
          keepFrom = j;
          break;
        }
      }
      return drain(keepFrom);
    },
    /** Redact a complete string in one go. */
    all(text) {
      return createRedactor(secrets).finish(text);
    },
    finish(text) {
      buf += text;
      return drain(buf.length);
    },
    /** Which keys were hidden so far, and how many times. */
    hits() {
      return { ...hits };
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
      // show what we are holding instead of hiding a prompt forever, but
      // never an ending that could be the first part of a secret.
      clearTimeout(timer);
      timer = setTimeout(() => emit(redactor.flushIdle()), idleMs);
    },
    end() {
      clearTimeout(timer);
      emit(redactor.finish(decoder.end()));
    },
    hits: () => redactor.hits(),
  };
}

/** Add up hit counts from several redactors. */
export function mergeHits(...all) {
  const total = {};
  for (const hits of all) {
    for (const [name, n] of Object.entries(hits)) total[name] = (total[name] ?? 0) + n;
  }
  return total;
}

/** "API_KEY (2x), DB_PASSWORD (1x)", or '' if nothing was hidden. */
export function describeHits(hits) {
  return Object.keys(hits)
    .map((n) => `${n} (${hits[n]}x)`)
    .join(', ');
}

/** A short note for whoever ran the command (often an AI), or '' if nothing was hidden. */
export function leakMessage(hits) {
  const list = describeHits(hits);
  if (!list) return '';
  return `blind-env: note: hid the value of ${list} in the output. Logs show the key name instead of the value.`;
}
