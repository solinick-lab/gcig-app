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

function normalizePrivateKey(raw) {
  // Render and most other dashboards don't preserve real newlines in env
  // values, so engineers typically paste the PEM with "\n" between lines.
  // Accept either form.
  return String(raw || '').replace(/\\n/g, '\n');
}

async function fetchAccessToken() {
  const integrationKey = process.env.DOCUSIGN_INTEGRATION_KEY;
  const userId = process.env.DOCUSIGN_USER_ID;
  const privateKey = normalizePrivateKey(process.env.DOCUSIGN_PRIVATE_KEY);
  if (!integrationKey || !userId || !privateKey) {
    throw Object.assign(new Error('DocuSign not configured'), { status: 503 });
  }

  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
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
