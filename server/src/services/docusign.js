// DocuSign eSignature integration.
//
// Sends a trade-confirmation envelope built from a stored template when an
// exec closes a Buy session. Auth is JWT Grant (RS256) — we sign a JWT with
// the integration key's RSA private key, exchange it for an access token,
// and reuse the token until it's near expiry.
//
// Pre-fill strategy: anchor strings. Lower DocuSign tiers don't expose the
// "Data Label" field on text tabs, so instead of overriding template tabs
// by label we add NEW text tabs at envelope-create time, positioning them
// by finding invisible anchor strings already typed onto the PDF. See
// CLAUDE.md "DocuSign integration" for the anchor strings the PDF must
// contain and how to add them.
//
// Required env vars (set on Render — see CLAUDE.md):
//   DOCUSIGN_INTEGRATION_KEY  App integration key (GUID)
//   DOCUSIGN_USER_ID          Impersonated user GUID (the "API user")
//   DOCUSIGN_ACCOUNT_ID       eSign account GUID
//   DOCUSIGN_PRIVATE_KEY      RSA private key (PEM). Newlines either real
//                             or literal "\n" — we normalize both.
//   DOCUSIGN_TEMPLATE_ID      Trade-confirmation template GUID
//
// Optional (with defaults):
//   DOCUSIGN_OAUTH_BASE       account.docusign.com (prod) or
//                             account-d.docusign.com (demo)
//   DOCUSIGN_API_BASE         https://na4.docusign.net/restapi
//   DOCUSIGN_SIGNER_ROLE_NAME Template role to attach the prefill tabs to
//                             (default "President", matching the Trading
//                             Approval template's role for Thomas). The
//                             recipient with this role gets ownership of
//                             the locked prefilled fields; everyone else
//                             just signs.

import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

const OAUTH_BASE = process.env.DOCUSIGN_OAUTH_BASE || 'account.docusign.com';
const API_BASE =
  process.env.DOCUSIGN_API_BASE || 'https://na4.docusign.net/restapi';
const ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID;
const TEMPLATE_ID = process.env.DOCUSIGN_TEMPLATE_ID;
const SIGNER_ROLE_NAME = process.env.DOCUSIGN_SIGNER_ROLE_NAME || 'President';

// Module-level token cache. JWT-grant access tokens are valid for an hour;
// we refresh five minutes early so a token never expires mid-request.
let cachedToken = null;
const TOKEN_SAFETY_BUFFER_MS = 5 * 60 * 1000;

export function isConfigured() {
  return !!(
    process.env.DOCUSIGN_INTEGRATION_KEY &&
    process.env.DOCUSIGN_USER_ID &&
    process.env.DOCUSIGN_PRIVATE_KEY &&
    ACCOUNT_ID &&
    TEMPLATE_ID
  );
}

// Tolerant PEM normalizer. PaaS env-var UIs mangle multi-line values in
// different ways:
//   • Some preserve real newlines.
//   • Some collapse them and require literal "\n" escape sequences.
//   • Some strip newlines entirely, leaving a header + base64 blob + footer
//     all run together.
//   • Some inject CRLF.
// Here we accept any of those and reconstruct a clean PEM that
// jsonwebtoken / OpenSSL will parse.
function normalizePrivateKey(raw) {
  let s = String(raw || '');
  // Expand literal "\n" escapes to newlines.
  s = s.replace(/\\n/g, '\n');

  // Whatever shape the PaaS handed us — real newlines, CRLF, runs of blank
  // lines, weird line-wrap widths, surrounding whitespace — we rebuild a
  // canonical PEM by finding the header/footer markers and rewrapping the
  // base64 body at the standard 64-char width. Bonus: this also fixes
  // copy-paste artifacts where a quote or stray character snuck in.
  const headerMatch = s.match(/-----BEGIN [A-Z 0-9]+-----/);
  const footerMatch = s.match(/-----END [A-Z 0-9]+-----/);
  if (!headerMatch || !footerMatch) {
    return s.trim();
  }
  const header = headerMatch[0];
  const footer = footerMatch[0];
  const bodyStart = s.indexOf(header) + header.length;
  const bodyEnd = s.indexOf(footer);
  // Keep only base64 characters in the body — drops every newline, space,
  // tab, quote, and any other artifact between header and footer.
  const body = s.slice(bodyStart, bodyEnd).replace(/[^A-Za-z0-9+/=]/g, '');
  const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `${header}\n${wrapped}\n${footer}`;
}

// Inspect the env-var key. We do shape checks AND attempt Node's own
// `crypto.createPrivateKey` — which returns far more specific errors than
// jsonwebtoken's "must be an asymmetric key" wrapper. We expose the result
// via the /diagnose route so an admin can see what's wrong without ever
// surfacing the key material itself.
function inspectPrivateKey() {
  const raw = process.env.DOCUSIGN_PRIVATE_KEY;
  if (!raw) return { ok: false, reason: 'DOCUSIGN_PRIVATE_KEY is unset' };
  const key = normalizePrivateKey(raw);
  if (!/-----BEGIN .*PRIVATE KEY-----/.test(key)) {
    return { ok: false, reason: 'Missing PEM header line', key };
  }
  if (!/-----END .*PRIVATE KEY-----/.test(key)) {
    return { ok: false, reason: 'Missing PEM footer line', key };
  }
  if (key.split('\n').length < 3) {
    return { ok: false, reason: 'PEM has fewer than 3 lines', key };
  }
  try {
    const parsed = crypto.createPrivateKey(key);
    return { ok: true, key, keyType: parsed.asymmetricKeyType };
  } catch (err) {
    return {
      ok: false,
      reason: `OpenSSL rejected the key: ${err.message}`,
      key,
    };
  }
}

// Public: metadata about the configured key with no key material leaked.
// Used by the /api/docusign/diagnose admin route.
export function getKeyDiagnostics() {
  const raw = process.env.DOCUSIGN_PRIVATE_KEY;
  if (!raw) return { configured: false };
  const inspected = inspectPrivateKey();
  const key = inspected.key || '';
  return {
    configured: true,
    rawLength: raw.length,
    normalizedLength: key.length,
    rawHasRealNewlines: raw.includes('\n'),
    rawHasLiteralBackslashN: /\\n/.test(raw),
    rawHasCRLF: raw.includes('\r'),
    normalizedLineCount: key.split('\n').length,
    hasBeginMarker: /-----BEGIN .*PRIVATE KEY-----/.test(key),
    hasEndMarker: /-----END .*PRIVATE KEY-----/.test(key),
    valid: inspected.ok,
    reason: inspected.reason || null,
    keyType: inspected.keyType || null,
    // Surface a tiny fingerprint of the body so the admin can verify they
    // pasted the right key without seeing it. First/last 4 base64 chars of
    // the body — same idea as `ssh-keygen -lf`.
    bodyFingerprint: (() => {
      const key = inspected.key || '';
      const body = key
        .replace(/-----BEGIN [^-]+-----/, '')
        .replace(/-----END [^-]+-----/, '')
        .replace(/\s/g, '');
      if (body.length < 16) return null;
      return `${body.slice(0, 4)}…${body.slice(-4)} (${body.length} chars)`;
    })(),
  };
}

async function fetchAccessToken() {
  const integrationKey = process.env.DOCUSIGN_INTEGRATION_KEY;
  const userId = process.env.DOCUSIGN_USER_ID;
  if (!integrationKey || !userId || !process.env.DOCUSIGN_PRIVATE_KEY) {
    throw Object.assign(new Error('DocuSign not configured'), { status: 503 });
  }
  const inspected = inspectPrivateKey();
  if (!inspected.ok) {
    throw Object.assign(
      new Error(
        `DOCUSIGN_PRIVATE_KEY is malformed (${inspected.reason}). Hit /api/docusign/diagnose for details.`
      ),
      { status: 500 }
    );
  }
  const privateKey = inspected.key;

  const now = Math.floor(Date.now() / 1000);
  let assertion;
  try {
    assertion = jwt.sign(
      {
        iss: integrationKey,
        sub: userId,
        aud: OAUTH_BASE,
        iat: now,
        exp: now + 3600,
        scope: 'signature impersonation',
      },
      privateKey,
      { algorithm: 'RS256' }
    );
  } catch (err) {
    // jsonwebtoken's "secretOrPrivateKey must be an asymmetric key" is
    // particularly opaque; surface it with a hint at the diagnose route.
    throw Object.assign(
      new Error(
        `JWT sign failed (${err.message}). Hit /api/docusign/diagnose to inspect the parsed key.`
      ),
      { status: 500 }
    );
  }

  const resp = await fetch(`https://${OAUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    // DocuSign returns `consent_required` the first time an integration key
    // tries to impersonate a user. Surface that distinctly so the caller can
    // show a useful message instead of a generic 502.
    if (body.includes('consent_required')) {
      throw Object.assign(
        new Error(
          'DocuSign consent has not been granted. Visit the consent URL in CLAUDE.md while signed in as the API user.'
        ),
        { status: 503 }
      );
    }
    throw new Error(`DocuSign token exchange failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  return {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > TOKEN_SAFETY_BUFFER_MS) {
    return cachedToken.token;
  }
  cachedToken = await fetchAccessToken();
  return cachedToken.token;
}

// Public: create + send an envelope from the trade-confirmation template.
//
// `anchorTabs` is { anchorString: value, ... }. Each entry becomes a NEW
// locked text tab positioned at the anchor string's location in the PDF.
// Anchor strings DocuSign doesn't find in the PDF are silently ignored,
// so it's safe to send a slightly fuller payload than the PDF requires.
//
// We use the compositeTemplates pattern (serverTemplate + inlineTemplate)
// so we can attach tabs to the template's existing recipient without
// having to re-specify their name + email — we only need to know the
// role name.
export async function sendTradeConfirmationEnvelope({
  anchorTabs,
  emailSubject,
  emailBlurb,
}) {
  if (!isConfigured()) {
    throw Object.assign(new Error('DocuSign not configured'), { status: 503 });
  }

  const accessToken = await getAccessToken();
  const textTabs = Object.entries(anchorTabs || {}).map(([anchor, value]) => ({
    anchorString: anchor,
    anchorMatchWholeWord: 'true',
    anchorUnits: 'pixels',
    anchorXOffset: '0',
    // Nudge slightly down — DocuSign anchors the bottom-left of the tab to
    // the anchor's bottom-left, which tends to ride too high in a table cell.
    anchorYOffset: '2',
    value: value == null ? '' : String(value),
    locked: 'true',
    font: 'Helvetica',
    fontSize: 'Size10',
    width: 90,
    height: 12,
  }));

  const body = {
    status: 'sent',
    emailSubject: emailSubject || 'Trade confirmation',
    emailBlurb: emailBlurb || undefined,
    compositeTemplates: [
      {
        serverTemplates: [
          { sequence: '1', templateId: TEMPLATE_ID },
        ],
        // Sequence here must be higher than the server template so the
        // inline payload merges *on top of* the saved template.
        inlineTemplates: [
          {
            sequence: '2',
            recipients: {
              signers: [
                {
                  roleName: SIGNER_ROLE_NAME,
                  recipientId: '1',
                  tabs: textTabs.length ? { textTabs } : undefined,
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const resp = await fetch(
    `${API_BASE}/v2.1/accounts/${ACCOUNT_ID}/envelopes`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`DocuSign envelope create failed (${resp.status}): ${errBody}`);
  }

  return resp.json();
}

// Public: create + send a BUNDLED trade-confirmation envelope spanning one
// or more line items (each line = a ticker + action + share count + price).
//
// `items` is an array of:
//   { kind: "Buy" | "Sell", ticker, shares, pricePerShare, totalCost }
//
// We expand each item into indexed anchor strings on the PDF:
//   \ticker1\, \shares1\, \buysell1\, \price1\, \total1\
//   \ticker2\, \shares2\, \buysell2\, ...
//
// Plus envelope-level anchors:
//   \decisiondate\   ISO date of send
//   \grandtotal\     Net cash flow (Buy totals minus Sell totals). Negative
//                    means the club is spending cash; positive means freeing
//                    cash. Formatted with sign so the signer sees direction.
//
// DocuSign silently drops anchors it can't find in the PDF, so a template
// supporting up to N rows works whether the request has 1 row or N rows.
// Lines beyond what the PDF supports just won't render — see CLAUDE.md
// "DocuSign integration" for the row limit + how to add more rows.
export async function sendBundledTradeEnvelope({
  items,
  decisionDate,
  emailSubject,
  emailBlurb,
}) {
  if (!isConfigured()) {
    throw Object.assign(new Error('DocuSign not configured'), { status: 503 });
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('At least one trade line is required'), {
      status: 400,
    });
  }

  const anchorTabs = {
    '\\decisiondate\\': decisionDate || new Date().toISOString().slice(0, 10),
  };

  let netCash = 0;
  items.forEach((item, idx) => {
    const n = idx + 1;
    const sign = item.kind === 'Sell' ? 1 : -1;
    netCash += sign * Number(item.totalCost || 0);
    anchorTabs[`\\ticker${n}\\`] = String(item.ticker || '');
    anchorTabs[`\\shares${n}\\`] = String(item.shares ?? '');
    anchorTabs[`\\buysell${n}\\`] = item.kind || '';
    anchorTabs[`\\price${n}\\`] = formatMoney(item.pricePerShare);
    anchorTabs[`\\total${n}\\`] = formatMoney(item.totalCost);
  });

  // Grand total displays signed cash flow. Positive = cash freed up (Sell
  // proceeds exceed Buy cost), negative = cash spent. Matches what the
  // signer expects to see at the bottom of a trade ticket.
  const grandSign = netCash >= 0 ? '+' : '-';
  anchorTabs['\\grandtotal\\'] = `${grandSign}${formatMoney(Math.abs(netCash))}`;

  const accessToken = await getAccessToken();
  const textTabs = Object.entries(anchorTabs).map(([anchor, value]) => ({
    anchorString: anchor,
    anchorMatchWholeWord: 'true',
    anchorUnits: 'pixels',
    anchorXOffset: '0',
    anchorYOffset: '2',
    value: value == null ? '' : String(value),
    locked: 'true',
    font: 'Helvetica',
    fontSize: 'Size10',
    width: 90,
    height: 12,
  }));

  const body = {
    status: 'sent',
    emailSubject: emailSubject || 'Trade confirmation',
    emailBlurb: emailBlurb || undefined,
    compositeTemplates: [
      {
        serverTemplates: [{ sequence: '1', templateId: TEMPLATE_ID }],
        inlineTemplates: [
          {
            sequence: '2',
            recipients: {
              signers: [
                {
                  roleName: SIGNER_ROLE_NAME,
                  recipientId: '1',
                  tabs: { textTabs },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const resp = await fetch(
    `${API_BASE}/v2.1/accounts/${ACCOUNT_ID}/envelopes`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`DocuSign envelope create failed (${resp.status}): ${errBody}`);
  }

  return resp.json();
}

function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return `$${v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Bank successful API calls toward DocuSign's go-live threshold. Hits a
// cheap account-info endpoint `count` times. Returns a result for each
// call so the caller can show progress. Admin-only — the route guards it.
export async function bankApiCalls(count) {
  const n = Math.min(Math.max(Number(count) || 0, 1), 50);
  const accessToken = await getAccessToken();
  const url = `${API_BASE}/v2.1/accounts/${ACCOUNT_ID}`;
  const results = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      results.push({ ok: resp.ok, status: resp.status, ms: Date.now() - t0 });
    } catch (err) {
      results.push({ ok: false, error: err.message, ms: Date.now() - t0 });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  return { requested: n, succeeded: ok, failed: n - ok, results };
}

// Optional helper: poll a single envelope's status. Mostly useful for the
// admin "refresh" button — the Connect webhook is the primary state source.
export async function getEnvelope(envelopeId) {
  const accessToken = await getAccessToken();
  const resp = await fetch(
    `${API_BASE}/v2.1/accounts/${ACCOUNT_ID}/envelopes/${encodeURIComponent(envelopeId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`DocuSign envelope fetch failed (${resp.status}): ${body}`);
  }
  return resp.json();
}
