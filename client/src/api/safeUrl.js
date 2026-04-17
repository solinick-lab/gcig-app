const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function isSafeHttpUrl(raw) {
  if (!raw) return true;
  try {
    const u = new URL(String(raw).trim());
    return ALLOWED_PROTOCOLS.has(u.protocol);
  } catch {
    return false;
  }
}

// Use on `href` props where the user supplied the URL — returns '#' if the
// URL is unsafe, so a malicious `javascript:` entry can never fire.
export function safeHref(url) {
  return isSafeHttpUrl(url) ? url : '#';
}
