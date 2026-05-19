# Terminal — FIL (SEC Filings Feed Panel)

- **Date:** 2026-05-18
- **Status:** Approved (user approved the batch + "build everything";
  lead-dev autonomy; sub-project 1 of 7).
- **Scope:** A new `FIL` terminal function: lists a ticker's recent
  SEC filings (8-K/10-Q/10-K/DEF 14A/Form 4 …) with links to the SEC
  doc + an AI one-liner on what's notable. Pure reuse of existing
  EDGAR plumbing; additive; own branch + PR.

## Why

`secFilings.js` already fetches the full EDGAR submissions feed
(`getRecentFilings`, used by `holdings.js`). Surfacing it as an
analyst-facing terminal panel is near-zero new data work and high
value for a research workflow.

## Locked decisions

1. Reuse `getRecentFilings(ticker,{limit})` — do NOT add a new SEC
   fetch path.
2. Filings rows link **out** to the SEC document (external new tab) —
   they are not internal functions, so no `onOpen`/DES wiring.
3. AI BRIEF via the existing `/terminal/annotate` with a new
   `FN_PROMPTS.FIL` (filings-analyst prompt + the shared
   `GROUNDING_RULES`), mirroring the other panels' brief blocks.
4. Never-throws/never-5xx server contract; honest empty/loading/error
   states; no fabricated filings. `requires: 'ticker'`.

## Architecture

### Server — `server/src/routes/terminal.js` (modified)
- `GET /terminal/filings/:ticker` → `{ ticker, filings: [{ form,
  filingDate, description, accessionNumber, url }] }` via
  `getRecentFilings(ticker,{limit:40})`. Inherits the module-scope
  `verifyJwt → requireExecutive → aiLimiter` chain (no per-route
  auth, like the sibling terminal routes). Extracted
  `filingsHandler(req,res,deps={})` with `deps.getRecentFilings`
  injectable for tests. try/catch → 200 `{ ticker, filings: [] }`
  (never 5xx). Ticker validated/uppercased per the existing
  `^[A-Z0-9.\-]{1,12}$` convention.
- Add `FN_PROMPTS.FIL`: a concise "filings analyst" system prompt
  (flag material 8-Ks, a fresh 10-K/10-Q, DEF 14A, clustered Form 4s;
  note staleness if nothing recent) + the existing `GROUNDING_RULES`.

### Client — `client/src/terminal/functions/Filings.jsx` (new) + `registry.js`
- Registry: `{ id:'FIL', label:'Filings', help:'Recent SEC filings
  (8-K/10-Q/10-K/DEF 14A/Form 4) with an AI read.', requires:'ticker',
  component: Filings }`.
- On mount (and ticker change) `GET /terminal/filings/:ticker`.
  Render the established `term-panel`/`term-table`: columns **Form ·
  Filed · Description**, newest first. Each row links to `url`
  (`<a target="_blank" rel="noopener noreferrer">` or a keyboard-
  accessible row that opens it) — opens the SEC doc in a new tab.
  AI BRIEF block (the shared pattern): POST `/terminal/annotate`
  `{ ticker, function:'FIL', context:<compact filing list> }`, with
  the established confab-safe guard (no annotate call when there are
  no filings; honest "No recent filings" message instead). Honest
  loading/empty/error states mirroring `Peers.jsx`/`InsiderActivity.jsx`.
- Uses the shared `api` axios instance (JWT auto-attached). No live-
  quote polling (filings aren't quotes). No change to other panels.

## Data flow

```
open FIL <ticker> → GET /terminal/filings/:ticker → getRecentFilings (EDGAR, cached in secFilings.js)
   → table (Form/Filed/Description, row → SEC url new tab)
   → /terminal/annotate (FN_PROMPTS.FIL) → one-line AI read (only if filings present)
```

## Error handling

`getRecentFilings` already degrades gracefully (returns []); the route
try/catch → 200 honest-empty, never 5xx. Client shows honest
empty/error; AI brief suppressed on empty (no confabulation). EDGAR
fetch from Render only fully prod-confirmable (standing limitation;
same path INSDR/MGMT already use successfully).

## Testing

- Server: `terminal.filings.test.js` mirroring `terminal.quotes.test.js`
  (injected `getRecentFilings` dep, no network): returns shape; caps
  at 40; uppercases/validates ticker; never 5xx if the service
  rejects (→ 200 `{filings:[]}`); inherits the same global auth chain
  as `/governance` (structural assertion, exec-bios/quotes precedent).
- Client: `npm run build` green; reasoned walkthrough (no client
  harness, consistent): loads filings, row opens SEC doc new tab,
  AI brief present when filings exist / honest message when none,
  empty/error states. Full server `npm test` stays green.

## Build

Branch `feat/fil-panel` off latest main, TDD, subagent-driven, one
PR. Tasks fold into a single focused implementer (route+prompt+test,
then panel+registry) given the small precedent-following scope.
