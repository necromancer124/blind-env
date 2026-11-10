// Make a web request with secrets filled in by facedown.
//
// The caller writes {{KEY_NAME}} in a header value or in the body. Each key
// may only be sent to the hosts on its allow list, redirects are not followed,
// and the response is redacted before it is returned.

import { createRedactor, mergeHits } from './redact.js';
import { hostAllowed } from './vault.js';

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function namesIn(text) {
  return [...String(text).matchAll(PLACEHOLDER)].map((m) => m[1]);
}

export async function httpRequest(vault, { url, method = 'GET', headers = {}, body, timeoutMs = 30_000, maxChars = 50_000 }) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  if (namesIn(url).length || /%7B%7B/i.test(url)) {
    throw new Error('secrets are not allowed in the URL (URLs end up in logs). Put the key in a header or the body.');
  }
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && LOOPBACK.has(target.hostname))) {
    throw new Error('only https:// URLs are allowed (http:// only for localhost)');
  }

  const used = new Set([...Object.values(headers).flatMap(namesIn), ...(body ? namesIn(body) : [])]);
  for (const name of used) {
    if (!vault.has(name)) throw new Error(`no key named ${name}`);
    const allow = vault.trustedAllow(name);
    if (!hostAllowed(allow, target.hostname)) {
      const legacy = !allow.length && vault.entries.get(name).allow.length;
      const allowed = legacy
        ? 'none yet: its hosts were set by an older version, set them again'
        : allow.length
          ? allow.join(', ')
          : 'no hosts yet';
      throw new Error(
        `BLOCKED: ${name} may not be sent to ${target.hostname} (allowed: ${allowed}). ` +
          'Only the user can allow a new site: ask them to approve it with /allowSite ' +
          `(or the allow_hosts tool), or to run "facedown allow ${name} ${target.hostname}".`
      );
    }
  }

  const secrets = vault.reveal([...used]);
  const fill = (text) => String(text).replace(PLACEHOLDER, (_, name) => secrets[name]);

  const outHeaders = {};
  for (const [k, v] of Object.entries(headers)) outHeaders[k] = fill(v);

  const res = await fetch(target, {
    method,
    headers: outHeaders,
    body: body === undefined ? undefined : fill(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Each piece is cleaned on its own; the hit counts are added up for the note.
  const counts = [];
  const clean = (piece) => {
    const redactor = createRedactor(secrets);
    const out = redactor.finish(piece);
    counts.push(redactor.hits());
    return out;
  };
  const text = clean(await res.text());
  const resHeaders = {};
  for (const [k, v] of res.headers) resHeaders[k] = clean(v);

  return {
    leaks: mergeHits(...counts),
    status: res.status,
    headers: resHeaders,
    body: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    note:
      res.status >= 300 && res.status < 400
        ? 'Redirects are not followed. If the new address is right, request it directly.'
        : undefined,
  };
}
