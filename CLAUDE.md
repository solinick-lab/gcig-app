# Griffin Fund — Working Context

Living context file. **I (Claude) update this as we work** — append new
facts to the relevant section when something becomes a long-term truth
about the codebase, deploy, or our shared playbook. Things that are
just one-off chatter don't belong here.

---

## What we're building

The Griffin Fund (GCIG / Grace Church School Investment Group) — a
full-stack web app for a student-led investment club managing ~$131K
AUM. Members pitch tickers, vote, manage a real portfolio, attend
meetings. The site is the system of record for everything except the
brokerage account itself (which lives at our custodian; we mirror
positions in via a Google Sheet).

**Production:**
- Client: https://thegriffinfund.org (also gcig-client.onrender.com)
- API: https://gcig-api.onrender.com
- Local LLM: https://llm.thegriffinfund.org (Cloudflare tunnel → Ollama
  qwen2.5:14b on Thomas's mac), with OpenAI fallback.

**Repo:** `~/Desktop/gcig-app` on Thomas's mac. Single git remote,
GitHub `newtheyork-pixel/gcig-app`, branch `main`. Render auto-deploys
both services on push.

---

## Stack

- **Client** (`/client`): React 18 + Vite + Tailwind. Deployed as a
  Render static site. Auth state in localStorage, axios for API.
- **Server** (`/server`): Node + Express + Prisma (PostgreSQL on
  Render). JWT auth in `Authorization: Bearer …` header. node-cron
  for scheduled jobs.
- **Storage**: OneDrive via Microsoft Graph for member-uploaded files
  (PDFs, decks, reports). Single shared account; refresh token in
  `FileProviderToken` table.
- **External APIs**: Finnhub (free tier — earnings, analyst consensus,
  news), SEC EDGAR (no key), FRED (free w/ key), Google Sheets
  (portfolio mirror), AISStream (free websocket — Persian Gulf
  tanker tracking; consumed only on the Windows server, never
  proxied through Render).
- **Off-platform pipeline (Tanker Tracker)**: `sea_tracker/` Python
  package runs on Thomas's Windows server. Collector is a 24/7 NSSM
  service; `enrich + signals + publish-signals` is a daily Task
  Scheduler entry; `publish-snapshot` runs every 2 min. All HMAC-
  signed POSTs to `gcig-api`. Setup docs at `sea_tracker/README.md`.

---

## Auth model

- JWT, 24h lifetime, signed with `JWT_SECRET`. Bearer header, NOT
  cookies — gcig-client and gcig-api are on different `onrender.com`
  subdomains (a public suffix), so cookies would be cross-site.
- Silent rotation: `verifyJwt` middleware sets `X-New-Token` response
  header when the JWT is past its 12h half-life. Client's axios
  interceptor (`/client/src/api/client.js`) writes it back to
  localStorage. Active users never hit 24h expiry; idle users do.
- `tokenVersion` claim → bump it on the user row to invalidate every
  outstanding JWT instantly (logout-everywhere, password change,
  /2fa/disable).
- CORS `exposedHeaders: ['X-New-Token']` is required or the client
  won't see the rotation header.
- `validateStatus` on axios accepts **2xx + 304** so token rotation
  fires on ETag-cached responses.
- `/auth/me` sets `Cache-Control: no-store` — last fix recovered from
  a Safari bug where 304-with-empty-body kicked freshly-logged-in
  users straight back to /login.
- After login (Google, password, 2FA), Login.jsx does
  `window.location.replace('/dashboard')` — full reload, no SPA nav,
  no React state race.
- ProtectedRoute waits on `loading` and falls back to localStorage
  before kicking to /login.

If something feels weird with auth on Safari, check that order in
`AuthContext.jsx` + `client.js` first.

---

## Roles

- **JuniorAnalyst** — default. New self-signups via Google land here.
- **PortfolioManager / SeniorPortfolioManager** — can pitch, run
  industries.
- **CIO**, **President** — execs, run meetings, mark attendance.
- **AdvisoryBoard / FacultyAdvisor** — attend advisory meetings only,
  separate roster.
- **ChiefOfCommunication** — comms officer, attendance-exempt.
- **Super admin** — defined by email match (`isSuperAdminEmail`),
  not a role. Thomas's email. Bypasses every role gate.

`extraRoles` array on User lets one person carry multiple gates.

---

## Notable services / files

- `server/src/services/dayInReview.js` — DIR cache + LLM
  orchestration. Scheduled at "5 16 * * *" America/New_York
  (4:05pm ET, post-close). Lazy fallback if cache empty.
- `server/src/services/articleSummarizer.js` — system prompts for
  the LLM. Includes the DIR prompt; treats SEC filings as
  date-confident, news as date-cautious.
- `server/src/services/sheetPortfolio.js` — Google Sheets read of
  the live portfolio. Fall through gracefully if unreachable.
- `server/src/services/secFilings.js` — SEC EDGAR. company_tickers
  → CIK, then submissions feed. 24h ticker-map cache, 6h per-ticker
  filings cache. UA header is required by SEC. `getLatestFilingByForm`
  scans the *entire* submissions feed (not a recency window) for the
  newest filing of a form — JPMorgan buries its 10-K ~7,000 rows deep
  behind 424B note prospectuses, so any windowed lookup is a guess. It
  also resolves share-class tickers across the dot/dash convention
  (vendors say `BRK.B`, EDGAR says `BRK-B`).
- `server/src/services/secBusinessSummary.js` — DES company
  description. Pulls the latest 10-K's "Item 1. Business" and
  strips it to prose. The extractor picks the start that stands at a
  line boundary (real header, not a TOC row or a mid-sentence
  cross-reference) and the longest span to a title-form "Item 1A.
  Risk Factors" / "Item 2. Properties". Best-effort, null when there's
  no US 10-K, 7-day cache. Fully unit-tested (`*.test.js`).
- `server/src/services/fredMacro.js` — 5 FRED series (10Y yield,
  VIX, USD, oil, CPI YoY). 1h cache. Hidden if `FRED_API_KEY` unset.
- `server/src/routes/dashboard.js` — main dashboard payload, plus
  separate `/dashboard/day-in-review` (lazy LLM call) and
  `/dashboard/macro` endpoints.
- `server/src/routes/attendance.js` — `EventRosterOverride` table
  persists the super-admin × removals and + additions so they
  survive page reloads.
- `client/src/components/EventAttendance.jsx` — event roster modal.
- `client/src/pages/Dashboard.jsx` — main page. MacroStrip + DIR
  card + portfolio chart + holdings + earnings.
- `client/src/pages/MemberProfile.jsx` — `PitchRow` renders pitch
  outcome chips. Approved (vote yes, not yet held) shows as green
  "Voted Yes" pill.
- `server/src/routes/sea.js` — HMAC ingest + JWT reads for the
  Tanker Tracker. Mirrors `cpi.js`. Off-platform Python publisher
  lives in `sea_tracker/` and runs on the Windows server.
  `SEA_INGEST_SECRET` env var on Render must match the value in
  `C:\sea_tracker\.env` on the server.
- `sea_tracker/` — Persian Gulf AIS pipeline. `collect` (websocket),
  `enrich`, `signals`, `publish-signals`, `publish-snapshot` CLI
  commands. DuckDB on disk; one writer (collect), many readers.
  Setup steps + NSSM/Task-Scheduler config in `sea_tracker/README.md`.
- `client/src/pages/Tankers.jsx` + `client/src/pages/tankers/*` —
  /tankers page. Polls `/api/sea/latest` every 30s; signal panel +
  MapLibre vessel map + click-to-detail drawer.
- `server/prisma/schema.prisma` — full schema. Migrations in
  `server/prisma/migrations/`.
- `server/src/services/docusign.js` + `server/src/routes/docusign.js` —
  trade-confirmation envelope flow. JWT-grant auth, single-template
  envelopes, Connect webhook for status reconciliation. The
  `sendTradeConfirmationEnvelope` helper backs the legacy per-session
  Send button; `sendBundledTradeEnvelope` backs the multi-line
  `TradeRequest` flow.
- `server/src/routes/tradeRequests.js` + `client/src/pages/TradeRequests.jsx` —
  bundled trade-confirmation envelopes. Composer at
  `/trade-requests` (executive-only) picks N closed Buy sessions and
  optionally adds a Sell line (default SPY, sized by shares or cover
  amount) → one envelope. Sessions claimed by a `TradeRequestItem` are
  filtered out of the picker.
- `server/src/routes/presidentReview.js` + `client/src/pages/PresidentReview.jsx` —
  end-of-year president performance review. Members rate each
  President 1-5 on a short list of statements (Strongly Disagree →
  Strongly Agree) with an optional free-form comment. Current set is
  four statements covering overall experience, efficiency, effort, and
  whether the club is well-managed under their leadership. One row per reviewer × president
  × cycle (academic year e.g. `2025-2026`); resubmits upsert. Question
  list lives in the route file as `QUESTIONS` and is shipped to the
  client via `GET /api/president-review/config`. `GET /results` is
  super-admin only and returns aggregated averages + distributions per
  president, plus the full set of individual responses (reviewer name,
  their nine ratings, optional comment, submitted date). Self-review
  is blocked.

---

## DocuSign integration

Two flows that both produce a trade-confirmation envelope from the
same DocuSign template:

**A. Single-session flow** (legacy, still wired on the Votes page).
   Exec clicks "Send trade confirmation" on a closed Buy session →
   server recomputes the tally, derives shares from
   `Math.round(avg_buy_amount / live_quote)`, posts an envelope with
   the legacy anchors filled. State is mirrored on
   `VotingSession.docusign*`.

**B. Bundled `TradeRequest` flow** (`/trade-requests`). Exec picks
   N closed Buy sessions in the composer, optionally adds a Sell
   line (typically SPY to free up cash), previews totals, sends one
   envelope. State lives on the new `TradeRequest` row + items. The
   composer ties each Buy line back to its `VotingSession` so a
   session can't be claimed twice. Sell lines have no
   `votingSessionId`. Cap is 8 lines per envelope (the PDF carries a
   9th row of anchors but it's reserved; raise `MAX_ITEMS` in
   `routes/tradeRequests.js` if you want to expose it).

Both flows hit `POST /api/docusign/webhook` on completion. The
webhook tries `VotingSession` first, then `TradeRequest`, then acks
silently if neither matches. Envelope status walks
`sent` → `delivered` → `completed` / `declined` / `voided`. A frozen
snapshot of what was sent lives on
`VotingSession.docusignTradeContext` (legacy) or
`TradeRequest.tradeContext` (bundled) so audits don't drift with
later quote changes.

**Auth shape:** JWT Grant. The integration key + impersonated user
must have one-time consent granted in a browser before the server can
mint tokens. Consent URL pattern (prod):

```
https://account.docusign.com/oauth/auth?response_type=code
  &scope=signature%20impersonation
  &client_id=<DOCUSIGN_INTEGRATION_KEY>
  &redirect_uri=https://thegriffinfund.org
```

Sign in as the API user, click Allow, ignore the redirect.

**Env vars (Render):**

| Var | Notes |
|-----|-------|
| `DOCUSIGN_INTEGRATION_KEY` | App's integration key GUID |
| `DOCUSIGN_USER_ID` | API user GUID (the impersonated user) |
| `DOCUSIGN_ACCOUNT_ID` | eSign account GUID — Thomas's account is `c52c39eb-294c-4527-8bde-bd75c3cf7a2b` |
| `DOCUSIGN_PRIVATE_KEY` | RSA private key (PEM). Newlines may be real or `\n` — the service normalizes |
| `DOCUSIGN_TEMPLATE_ID` | Trade-confirmation template GUID |
| `DOCUSIGN_SIGNER_ROLE_NAME` | Template role that owns the prefilled anchor tabs. Default `President` — matches Thomas's role on the Trading Approval template. Roles on the template are `Facility Advisory` (Nicholas), `President` (Thomas), `President.` (Sander — note trailing period) |
| `DOCUSIGN_OAUTH_BASE` | `account.docusign.com` (prod) or `account-d.docusign.com` (demo) |
| `DOCUSIGN_API_BASE` | Default `https://na4.docusign.net/restapi`. Confirm via `/oauth/userinfo` if the account ever migrates data centers |
| `DOCUSIGN_WEBHOOK_HMAC_KEY` | Connect HMAC secret. Same string as configured on the Connect listener |

**Pre-fill strategy: anchor strings.** Lower DocuSign tiers don't
expose the "Data Label" field on text tabs, so we attach text tabs
to invisible anchor strings already present on the PDF instead of
binding by label. The PDF embedded in the template must contain these
literal strings (rendered in ~2pt white text so signers don't see
them).

Both flows share a single indexed anchor scheme. The single-session
"Send trade confirmation" flow just fills row 1; the bundled flow
fills rows 1..N. The PDF table runs 9 rows of anchors but `MAX_ITEMS`
caps the bundled flow at 8 — the 9th row is reserved.

| Anchor | Filled with |
|--------|-------------|
| `\\decisiondate{N}\\` | ISO date of the send. Indexed per row so empty rows stay blank — earlier we used a single `\\decisiondate\\` that DocuSign stamped in every row. Each row's Date cell must carry its own `\\decisiondateN\\` anchor. |
| `\\grandtotal\\` | (Bundled only) Net cash flow, signed: `+$3,210.00` (Sells outweigh Buys) or `-$8,250.00` (Buys outweigh Sells) |
| `\\ticker{N}\\` | Row N's ticker (`AIT`, `SPY`, …) |
| `\\buysell{N}\\` | Row N's action — `Buy` or `Sell` |
| `\\shares{N}\\` | Whole-share count |
| `\\price{N}\\` | Per-share price |
| `\\total{N}\\` | Row's dollar total |

N is 1-based. The first selected line lands in row 1, second in row
2, and so on. The Sell-to-cover line (SPY by default) is always one
of the rows — there's no separate "sell" anchor block.

DocuSign ignores anchors it can't find in the PDF, so leaving any
out is safe — they just don't get filled.

**Adding anchors to the PDF (Word / Pages workflow):**
1. Open the source doc (not the PDF — re-export afterward).
2. Type the anchor string at the position you want the value to
   render (inside the table cell, just left-aligned).
3. Select that string only, set font size to **2pt**, font color
   to **white**. It collapses to a near-invisible smear.
4. Export to PDF and re-upload to the DocuSign template.
5. In the template editor, **delete the existing green text tabs**
   from the table cells — our integration creates fresh tabs at
   send time, so any tabs sitting there would just collide.

**`DOCUSIGN_SIGNER_ROLE_NAME` env var** specifies which template
recipient owns the prefilled tabs. Defaults to `President`. The
owner doesn't have to be one of the actual signers — the tabs are
locked read-only, so they look the same to everyone — but DocuSign
requires each tab to belong to a recipient.

**Connect listener config (DocuSign Admin → Integrations → Connect):**
JSON v2 format, URL `https://gcig-api.onrender.com/api/docusign/webhook`,
HMAC enabled, events: envelope sent/delivered/completed/declined/voided.

---

## Pitch outcome inference (the AIT bug fix)

`/users/:id/profile` and `/pitches/outcomes/mine` both layer this:

1. `Pitch.votedOutcome` — explicit override, always wins.
2. Most recent **closed** `VotingSession` for the ticker:
   - majority Buy + held → `Buy`
   - majority Buy + not held → `Approved` ("Voted Yes")
   - majority not-Buy → `NoBuy`
3. Future-dated → `Scheduled`.
4. Held with no vote on file → `Buy` (legacy inference).
5. Otherwise → `Pending`.

Hit-rate stats count `Approved` toward Voted Yes too.

---

## Conventions

- **Comments**: editorial / book-jacket voice. Explain *why*, not
  *what*. No banner blocks, no emoji, no "this function does X" —
  the user's prose taste is "what would a senior engineer want to
  read at 2am". Comments are wrapped at ~70 cols.
- **Commit messages**: lowercase imperative for the title, blank
  line, then prose paragraphs. Always end with the
  `Co-Authored-By: Claude Opus 4.7 (1M context)` trailer.
- **No new docs files** unless explicitly asked. (This file is the
  one exception.)
- **No emojis** in code or commits unless asked.
- **Build before push** — `npm run build` in `/client` to catch
  Vite/JSX errors. Server: `node --check <file>` for quick syntax
  validation.

---

## Deploy workflow

- `git push` → Render rebuilds both services. ~1 min for the static
  site, longer if the server has migrations to run.
- Migrations run automatically on server boot via the build command
  in Render's settings (`npx prisma migrate deploy`).
- Render's static-site CDN can serve stale code briefly. After a
  push, hard reload (`⌘ + Shift + R`) on Safari, and if needed,
  Develop → Empty Caches.

---

## Things NOT to do

- Don't add login flows that use SPA `navigate('/dashboard')` — use
  `window.location.replace`. SPA nav races AuthProvider's mount.
- Don't put ETag-cacheable responses on auth-bootstrap endpoints
  without thinking about the 304-empty-body trap.
- Don't write to `localStorage.gcig_user` without `JSON.stringify`
  — the parse on next mount will throw.
- Don't drop the `tokenVersion` check in verifyJwt. It's how
  logout-everywhere works.
- Don't add features through a brand-new role gate without checking
  every existing route — easier to use `extraRoles`.
- Don't reach for paid APIs. We've stayed on free tiers (Finnhub
  free, SEC EDGAR, FRED) deliberately. The exception is DocuSign,
  which we use because Thomas already pays for an account; never
  fall back to a second e-sign vendor.
- Don't auto-send the trade-confirmation envelope on vote close.
  The Send button is manual on purpose — gives the exec a chance to
  eyeball the share count against the live quote before the
  envelope goes out.

---

## Known issues (open)

- **GSAM Daily Rates PDF returns HTTP 403 from Render (May '26)**: the
  scraper in `server/src/services/gsamRates.js` works fine from a
  laptop (with `Accept: application/pdf` + a realistic User-Agent) but
  fails with 403 when called from the deployed API on Render. GSAM is
  rate-limiting / geo-filtering datacenter egress IPs. The dashboard's
  "Refresh today's yield" button surfaces the error inline. SEC N-MFP3
  backfill is the working historical source and is unaffected.
  Possible fixes when you get to it: route the request through an
  Akamai or Cloudflare worker, send a fuller browser-like header set,
  or scrape an alternate downstream mirror. Cron schedule will keep
  retrying and failing nightly until this is resolved.

## Recent fixes / playbook notes

- **DES had no company description (May '26)**: Finnhub free tier
  carries no business summary and Yahoo's profile endpoint is
  429/401-blocked from Render datacenter IPs (same wall as the GSAM
  scraper — don't reach for Yahoo profile data from the API). Now
  sourced from EDGAR's 10-K Item 1 via `secBusinessSummary.js`. The
  first cut at this used a windowed `getRecentFilings` lookup that
  silently missed the 10-K for prolific filers; the fix was a
  full-feed scan by form type. Lesson: to find an *annual* filing,
  never scan a fixed recency window — filers like JPM file tens of
  thousands of interim documents between 10-Ks.
- **Safari "click anywhere kicks me out" (May '26)**: root cause was
  Express's auto-ETag on `/auth/me` + axios's 304-as-success →
  `setUser(undefined)`. Fixed with `Cache-Control: no-store` +
  defensive guards. See section `Auth model`.
- **Pending pitch outcomes (May '26)**: closed-vote yes wasn't
  reflected until lots showed up in the sheet. Added `Approved`
  effective outcome layer on top of `votedOutcome`.
- **Roster removals didn't stick (May '26)**: × button only
  deleted the Attendance row, but the user came back via the role-
  based default audience query. Added `EventRosterOverride` table.
- **Dashboard slow (Apr '26)**: DIR LLM call was awaited inside
  the dashboard handler. Split to `/dashboard/day-in-review` and
  added a node-cron pre-generation at 4:05pm ET so the cache is
  warm by the time members open the page.

---

## Updating this file

When something becomes a stable fact about the codebase or our
playbook, edit the relevant section above. Don't pile a
chronological journal at the bottom — fold the lesson into where it
belongs (Auth model, Conventions, Things NOT to do, etc.). The
"Recent fixes" section is the only chronological one and should
stay short — when an entry isn't being referenced anymore, retire
it.
