// Guard against XSS via javascript: / data: / vbscript: URIs when a user
// supplies a link that we render as <a href="...">. Allow only plain
// http(s) URLs.
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function isSafeHttpUrl(raw) {
  if (!raw) return true; // empty/null is fine — caller decides if it's required
  try {
    const u = new URL(String(raw).trim());
    return ALLOWED_PROTOCOLS.has(u.protocol);
  } catch {
    return false;
  }
}

export function assertSafeHttpUrl(raw, fieldName = 'URL') {
  if (!isSafeHttpUrl(raw)) {
    const err = new Error(`${fieldName} must be a valid http:// or https:// link`);
    err.status = 400;
    throw err;
  }
}
