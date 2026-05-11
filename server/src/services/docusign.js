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
  let s = String(raw || '').trim();
  // Literal "\n" → real newline.
  s = s.replace(/\\n/g, '\n');
  // CRLF / CR → LF.
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Collapse blank or whitespace-only lines and trim each line. Render's UI
  // sometimes returns BOTH real newlines AND literal "\n" escapes in the
  // same value; after the replace above that produces double-newlines and
  // OpenSSL refuses to parse a PEM with empty lines in the body.
  s = s
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  // If the key has no newlines at all (everything is one blob), rebuild PEM
  // format by re-wrapping the base64 body at 64 chars between header/footer.
  if (!s.includes('\n')) {
    const headerMatch = s.match(/-----BEGIN [A-Z 0-9]+-----/);
    const footerMatch = s.match(/-----END [A-Z 0-9]+-----/);
    if (headerMatch && footerMatch) {
      const header = headerMatch[0];
      const footer = footerMatch[0];
      const body = s
        .slice(s.indexOf(header) + header.length, s.indexOf(footer))
        .replace(/\s/g, '');
      const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
      s = `${header}\n${wrapped}\n${footer}`;
    }
  }
  return s;
}

// Cheap shape check on the env var. Returns either { ok: true, key } or
// { ok: false, reason }. We expose the reason via the /diagnose route so an
// admin can see what's wrong without ever surfacing the key itself.
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
  return { ok: true, key };
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
