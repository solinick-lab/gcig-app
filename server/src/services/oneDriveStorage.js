import prisma from '../db.js';

// OneDrive (Microsoft Graph) file storage. Single-account model: one
// super admin runs the OAuth flow once, the refresh token gets stored
// in FileProviderToken, and every member's upload lands in that admin's
// OneDrive inside a configurable folder (default: GriffinFund/Uploads).
//
// Why single-account: the app owns the files, not individual members.
// When a member leaves the club we don't lose their pitch deck. Uniform
// storage for audit + discovery + search.
//
// Auth flow:
//   1. Super admin hits GET /api/files/oauth/start
//   2. Server redirects to Microsoft authorize URL with CSRF state
//   3. User consents, Microsoft redirects back with ?code=...
//   4. Server POSTs the code to Microsoft's token endpoint, gets
//      access_token + refresh_token, saves to DB.
//   5. From here on: every upload calls getAccessToken() which
//      refreshes if the access token is close to expiry.

const AUTHORITY = 'https://login.microsoftonline.com/common';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'Files.ReadWrite offline_access User.Read';
const SMALL_UPLOAD_MAX = 4 * 1024 * 1024; // 4 MB — above this, use resumable upload session

function requireConfig() {
  const id = process.env.ONEDRIVE_CLIENT_ID;
  const secret = process.env.ONEDRIVE_CLIENT_SECRET;
  const redirect = process.env.ONEDRIVE_REDIRECT_URI;
  if (!id || !secret || !redirect) {
    const missing = [
      !id && 'ONEDRIVE_CLIENT_ID',
      !secret && 'ONEDRIVE_CLIENT_SECRET',
      !redirect && 'ONEDRIVE_REDIRECT_URI',
    ]
      .filter(Boolean)
      .join(', ');
    throw new Error(`OneDrive not configured — set: ${missing}`);
  }
  return { id, secret, redirect };
}

export function isConfigured() {
  return !!(
    process.env.ONEDRIVE_CLIENT_ID &&
    process.env.ONEDRIVE_CLIENT_SECRET &&
    process.env.ONEDRIVE_REDIRECT_URI
  );
}

// Build the Microsoft authorize URL. `state` is a random CSRF nonce
// the caller stores + verifies when Microsoft redirects back.
export function getAuthorizeUrl(state) {
  const { id, redirect } = requireConfig();
  const params = new URLSearchParams({
    client_id: id,
    response_type: 'code',
    redirect_uri: redirect,
    response_mode: 'query',
    scope: SCOPES,
    state,
    // Force the consent screen so Microsoft issues a refresh_token
    // every time — without this, a re-auth can return only an access
    // token and we lose long-term access.
    prompt: 'consent',
  });
  return `${AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function postForm(body) {
  const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Microsoft token endpoint ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

// Fetch the authenticated user's email so we can display which
// OneDrive account the tokens are bound to in the admin UI.
async function fetchMe(accessToken) {
  try {
    const r = await fetch(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.userPrincipalName || data.mail || null;
  } catch {
    return null;
  }
}

async function saveTokens(tokens, prevRefresh = null) {
  // Some refresh responses omit a new refresh_token — in that case
  // keep the existing one (refresh tokens from Microsoft typically
  // rotate but not always).
  const refreshToken = tokens.refresh_token || prevRefresh;
  if (!refreshToken) {
    throw new Error('Missing refresh_token from Microsoft — cannot persist session');
  }
  const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000);
  const email = await fetchMe(tokens.access_token);
  await prisma.fileProviderToken.upsert({
    where: { provider: 'onedrive' },
    create: {
      provider: 'onedrive',
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt,
      scope: tokens.scope || null,
      email,
    },
    update: {
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt,
      scope: tokens.scope || null,
      email,
    },
  });
}

export async function exchangeCodeForTokens(code) {
  const { id, secret, redirect } = requireConfig();
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    code,
    redirect_uri: redirect,
    grant_type: 'authorization_code',
    scope: SCOPES,
  });
  const tokens = await postForm(body);
  await saveTokens(tokens);
  return tokens;
}

async function loadTokens() {
  return prisma.fileProviderToken.findUnique({ where: { provider: 'onedrive' } });
}

// Returns a currently-valid access token, refreshing if within 30s
// of expiry (or already expired). Throws if the provider isn't
// authorized yet.
export async function getAccessToken() {
  const tokens = await loadTokens();
  if (!tokens) {
    const err = new Error('OneDrive is not authorized. A super admin must connect it first.');
    err.code = 'NOT_AUTHORIZED';
    throw err;
  }
  const now = Date.now();
  if (tokens.expiresAt.getTime() > now + 30_000) {
    return tokens.accessToken;
  }
  const { id, secret } = requireConfig();
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    refresh_token: tokens.refreshToken,
    grant_type: 'refresh_token',
    scope: SCOPES,
  });
  const fresh = await postForm(body);
  await saveTokens(fresh, tokens.refreshToken);
  return fresh.access_token;
}

export async function getStatus() {
  const tokens = await loadTokens();
  if (!tokens) {
    return { connected: false, configured: isConfigured() };
  }
  return {
    connected: true,
    configured: true,
    email: tokens.email,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
    updatedAt: tokens.updatedAt,
    folder: process.env.ONEDRIVE_FOLDER || 'GriffinFund/Uploads',
  };
}

// Disconnect — wipes the stored tokens. Super admin runs this if they
// want to re-authorize or switch accounts.
export async function disconnect() {
  await prisma.fileProviderToken.deleteMany({ where: { provider: 'onedrive' } });
}

// ── Uploads ──────────────────────────────────────────────────────────

function encodeGraphPath(segments) {
  // Each segment encoded individually so slashes between folders stay
  // literal, but the filename's special chars become %xx.
  return segments.map(encodeURIComponent).join('/');
}

// Upload a buffer to OneDrive at `{folder}/{filename}`. Uses the simple
// content-PUT for small files, or an upload session for files >4 MB.
// Returns the Microsoft Graph DriveItem (contains id, name, size, webUrl).
export async function uploadFile({ buffer, filename, contentType }) {
  const token = await getAccessToken();
  const folder = process.env.ONEDRIVE_FOLDER || 'GriffinFund/Uploads';
  const folderSegments = folder.split('/').filter(Boolean);
  const fullSegments = [...folderSegments, filename];
  const pathEncoded = encodeGraphPath(fullSegments);

  if (buffer.length <= SMALL_UPLOAD_MAX) {
    const url = `${GRAPH}/me/drive/root:/${pathEncoded}:/content?@microsoft.graph.conflictBehavior=rename`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType || 'application/octet-stream',
      },
      body: buffer,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OneDrive upload failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  // Resumable upload session for larger files. Chunk size must be a
  // multiple of 320 KiB per Graph docs; 5 MB is a safe standard.
  const sessionUrl = `${GRAPH}/me/drive/root:/${pathEncoded}:/createUploadSession`;
  const sessionRes = await fetch(sessionUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      item: { '@microsoft.graph.conflictBehavior': 'rename' },
    }),
  });
  if (!sessionRes.ok) {
    const text = await sessionRes.text().catch(() => '');
    throw new Error(
      `OneDrive upload session failed (${sessionRes.status}): ${text.slice(0, 300)}`
    );
  }
  const { uploadUrl } = await sessionRes.json();
  const CHUNK = 5 * 1024 * 1024;
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, buffer.length);
    const chunk = buffer.slice(offset, end);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${offset}-${end - 1}/${buffer.length}`,
      },
      body: chunk,
    });
    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Chunk upload failed (${res.status}) at ${offset}-${end - 1}: ${text.slice(0, 300)}`
      );
    }
    if (res.status === 200 || res.status === 201) {
      return res.json();
    }
    // 202 Accepted → more chunks expected
  }
  throw new Error('Upload session finished without a final response');
}

// Stream a file from OneDrive to an Express response. Proxies the
// Content-Type and Content-Disposition so the browser handles
// inline preview / download correctly.
//
// `options.inline` is the opt-in for the in-app PDF modal. When set
// AND the upstream content-type is application/pdf, the disposition
// header is rewritten to `inline; filename="…"` so the browser
// previews instead of saves. The original filename is taken from the
// upstream Content-Disposition; if Graph didn't give us one we fall
// back to a bare `inline` (still valid per RFC 6266). The default
// (no inline flag) preserves Graph's attachment behavior 1:1 — every
// existing download call site is unaffected.
//
// Non-PDF responses never get an inline override even when the flag
// is set: silently inlining a PPTX would surface a download prompt in
// some browsers and an unreadable XML blob in others. Honesty wins —
// embedding falls back to the modal's "open in new tab" panel.
export async function streamDownload(itemId, res, options = {}) {
  const token = await getAccessToken();
  const url = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/content`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Download failed (${r.status}): ${text.slice(0, 300)}`);
  }
  const ct = r.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  const cl = r.headers.get('content-length');
  if (cl) res.setHeader('Content-Length', cl);
  const upstreamCd = r.headers.get('content-disposition');
  const wantInline =
    options.inline === true && /^application\/pdf\b/i.test(ct);
  if (wantInline) {
    // Reuse the filename Graph reported (parsed loosely — `filename=`
    // or `filename*=` UTF-8). If neither is present we still emit
    // `inline` alone so the browser knows to preview.
    const filename = parseFilename(upstreamCd);
    res.setHeader(
      'Content-Disposition',
      filename ? `inline; filename="${filename}"` : 'inline'
    );
  } else if (upstreamCd) {
    res.setHeader('Content-Disposition', upstreamCd);
  }

  const reader = r.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

// Best-effort Content-Disposition filename extractor. Looks for a
// quoted `filename="…"` first, then an unquoted `filename=…`, then a
// URL-encoded `filename*=UTF-8''…`. Returns null when nothing's
// usable — callers should treat that as "emit `inline` with no name".
function parseFilename(header) {
  if (!header) return null;
  const quoted = header.match(/filename="([^"]+)"/i);
  if (quoted) return quoted[1];
  const bare = header.match(/filename=([^;]+)/i);
  if (bare) return bare[1].trim();
  const star = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  return null;
}

// Fetch the file's bytes into memory. Used for email attachments where
// we need the buffer + filename in one shot. Don't use this for large
// downloads to a client — use streamDownload instead so we don't buffer
// 25 MB in Node memory just to forward it.
export async function downloadBuffer(itemId) {
  const token = await getAccessToken();
  const [contentRes, meta] = await Promise.all([
    fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/content`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow',
    }),
    getMetadata(itemId),
  ]);
  if (!contentRes.ok) {
    const text = await contentRes.text().catch(() => '');
    throw new Error(`Download failed (${contentRes.status}): ${text.slice(0, 300)}`);
  }
  const arrayBuf = await contentRes.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuf),
    filename: meta.name,
    contentType: contentRes.headers.get('content-type') || 'application/octet-stream',
  };
}

export async function getMetadata(itemId) {
  const token = await getAccessToken();
  const url = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Metadata fetch failed (${r.status}): ${text.slice(0, 300)}`);
  }
  return r.json();
}

// Ask Microsoft Graph for a short-lived embed URL that renders the file
// in the Office Online viewer. Works for PDF, PPTX, DOCX, XLSX — anything
// Office can render. Returns { url, postParameters? } where url is meant
// to be loaded in an <iframe> and postParameters (if present) describes a
// form post that produces the same render. We only need `url`.
export async function getPreviewUrl(itemId) {
  const token = await getAccessToken();
  const url = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/preview`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    // Empty body — defaults are fine. zoom=1, allowEdit=false implied.
    body: '{}',
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Preview URL fetch failed (${r.status}): ${text.slice(0, 300)}`);
  }
  const json = await r.json();
  // Graph returns { getUrl, postUrl, postParameters }. getUrl is suitable
  // for direct iframe src.
  if (!json?.getUrl) {
    throw new Error('Preview URL missing from Graph response');
  }
  return { url: json.getUrl };
}

export async function deleteFile(itemId) {
  const token = await getAccessToken();
  const url = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404 means already gone — idempotent.
  if (!r.ok && r.status !== 404) {
    const text = await r.text().catch(() => '');
    throw new Error(`Delete failed (${r.status}): ${text.slice(0, 300)}`);
  }
}
