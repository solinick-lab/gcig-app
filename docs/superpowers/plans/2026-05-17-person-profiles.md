# Clickable Person Profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` tracking.

**Goal:** Click any director/executive in MGMT → modal with a real bio (directors from the DEF 14A we already fetch; executives from the 10-K).

**Architecture:** Additive. `parseBoard` captures a `bio` from the same card/row it already parses. New `executiveBios.js` lazily parses the 10-K. New reusable `PersonModal`. Payload fields are optional/back-compatible. Never-throws everywhere; no fabrication.

**Tech Stack:** Node ESM, Express, `node-html-parser`, `node:test`; React 18 + Vite client.

---

### Task 1: `parseBoard` captures director `bio`

**Files:** Modify `server/src/services/governanceParsers.js`; Test `server/src/services/governanceParsers.realfixture.test.js` (+ `governanceParsers.test.js` if a unit case helps).

- [ ] Write the failing recall-gate assertions first: for AMZN/KO/AAPL, a named director's `bio` is a non-empty string containing a known ground-truth substring (extract the real expected substring from the committed fixture during implementation — e.g. AMZN Jassy bio mentions "Amazon Web Services"/"CEO"; KO Quincey "Career Highlights"/role text; AAPL a director's occupation). MLAB `bio` = the occupation/position line (non-empty). Confirm RED.
- [ ] Implement: in the card path capture the title + qualifications/career prose from the already-matched director card subtree (AMZN family vs KO family field grammar from the prior investigation); in the conventional path set `bio` to the occupation/position cell text. `bio` nullable; never throw; whitespace-collapsed, reasonable length cap.
- [ ] Regression bar: MLAB board still exactly 7, AAPL 8, AMZN 11, KO 11 with identical name/age/since; all comp output byte-identical; never-throws holds (null/garbage/huge → `[]`).
- [ ] Full `npm test` green; `node --check`. Commit.

### Task 2: `executiveBios.js` — 10-K exec-officer parser + real fixtures

**Files:** Create `server/src/services/executiveBios.js`, `server/src/services/executiveBios.test.js`, `server/src/services/__fixtures__/{AMZN,KO,<conventional>}-10k.html` (real, trimmed to the exec-officers section subtree + structure), update `__fixtures__/README.md`.

- [ ] Capture real 10-Ks via the app path (`getRecentFilings` newest `10-K`, raw-URL strip, `SEC_UA`); trim each to the real "Information about (our) Executive Officers" / "Executive Officers of the Registrant" section subtree preserving real HTML; commit as fixtures (10-Ks are tens of MB — trimmed-but-real, mirroring proxy-fixture rationale).
- [ ] Write failing `executiveBios.test.js`: from each fixture, assert specific officers by name with a bio substring each; assert never-throws on null/''/garbage/number; assert empty `officers` (not throw) when section absent. Confirm RED.
- [ ] Implement `getExecutiveBios(ticker, deps)` → `{ ticker, source, asOf, officers:[{name,bio}] }`: latest 10-K via `getRecentFilings`, `SEC_UA` fetch, 24h cache keyed by ticker, 12 MB size cap, signature-locate the exec-officers section, per-officer split (structure-aware where present, prose fallback), never-throws stub `{officers:[],source:null}` on any failure. `deps` injectable (`filingsFetch`,`docFetch`) for the test (no network in tests).
- [ ] Tests green; `node --check`. Commit.

### Task 3: lazy `/exec-bios` route

**Files:** Modify `server/src/routes/terminal.js`; Test alongside existing terminal route tests.

- [ ] Failing test: `GET /terminal/governance/:ticker/exec-bios` returns `{ticker,source,officers}`; never 5xx on a parse miss (200 + empty officers); same auth/limiter as sibling terminal routes.
- [ ] Implement using `getExecutiveBios`; honest empty on miss; never throw out of the handler.
- [ ] Tests green. Commit.

### Task 4: `PersonModal.jsx` reusable overlay

**Files:** Create `client/src/terminal/components/PersonModal.jsx`.

- [ ] Implement accessible terminal-styled modal: props `{ person, bio, loading, onClose }`; Esc + click-outside close; focus trap; scrollable body; shows name/title/age/since, bio when present, else structured facts + explicit "No bio disclosed in the filing." Loading state for async bio.
- [ ] `cd client && npm run build` → `✓ built`. Commit.

### Task 5: `Governance.jsx` — clickable rows, modal wiring, lazy exec bios, footer fix

**Files:** Modify `client/src/terminal/functions/Governance.jsx`.

- [ ] Board/Leadership rows become buttons opening `PersonModal`. Director → `bio` already in payload. Exec → lazy `GET …/exec-bios` once per ticker (cache in state), match officer by name, loading→bio, miss→structured fallback. Reset modal/cache on ticker change.
- [ ] Replace the now-false footer caveat ("does not yet handle … card layouts") with an accurate statement (directors parsed from DEF 14A incl. bio-card filers; exec bios best-effort from the 10-K; honest long-tail note).
- [ ] `npm run build` → `✓ built`; manual prop-flow sanity. Commit.

### Task 6: Whole-feature review + finish

- [ ] Final adversarial review (gate honesty, never-throws, no regression, no fabrication path, payload back-compat, honest caveats accurate).
- [ ] `npm test` green + client build, verified by the controller directly. finishing-a-development-branch → single merge to `main`.

---

## Self-review

- **Spec coverage:** director bios (T1), exec bios+service (T2), lazy route (T3), modal (T4), wiring+footer (T5), review/finish (T6) — every spec section maps to a task.
- **Placeholders:** ground-truth substrings are intentionally extracted from real fixtures at implementation time (not inventable up front) — each task says to capture RED first against the real fixture, which is the correct TDD discipline, not a placeholder.
- **Type consistency:** `bio` is `string|null` on directors everywhere; `executiveBios` returns `{officers:[{name,bio}]}` consumed identically by route and client; `since`/`age` types unchanged from current parser.
