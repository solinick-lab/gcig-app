# MGMT — Management, Board & Governance (DEF 14A)

- **Date:** 2026-05-16
- **Status:** Approved design — pending spec review, then implementation plan
- **Scope:** Sub-projects #2–#5 of the `MGMT` governance umbrella, built as one
  feature on a shared DEF 14A spine. (#1 Insider/Form 4 = `INSDR`, already shipped.)

## Context

The governance umbrella was decomposed during brainstorming into five
sub-projects. #1 (`INSDR`, insider Form 4) shipped. The user asked for
"both requests" / "do everything": CEO + leadership, board + bios,
plus the compensation and connections pieces. #2–#5 all derive from the
**same source the user explicitly endorsed** — the SEC **DEF 14A proxy
statement** ("vetted, includes other directorships, has age/tenure",
better than LinkedIn) — so they are built as one feature over a single
shared proxy fetch+parse service rather than four independent pipelines.

## Goal

A new ticker-scoped terminal function, `MGMT`, with four tabbed sections
backed by one DEF 14A service:

- **Leadership** — CEO + named executive officers: bio, tenure, prior
  roles, total compensation.
- **Board** — directors: age, tenure, committees, *other public
  directorships*.
- **Comp** — pay mix from the Summary Compensation Table: % salary vs
  stock vs option vs other (alignment read).
- **Network** — interlocking directorates, **scoped to the fund's own
  holdings** (who sits on the boards of two names the fund holds).

## Non-goals (YAGNI)

- No paid data providers. SEC EDGAR only (CLAUDE.md: free-tier).
- No historical proxy diffing / multi-year trend (latest DEF 14A only).
- No full org chart; no non-public/private-company board data.
- Network is bounded to fund holdings — not a global directorship graph.
- `INSDR` stays its own function; `MGMT` links to it, not merges it.

## Locked decisions

1. **DEF 14A is the canonical spine.** One `proxyStatement.js` service:
   `ticker → CIK` (reuse `services/secFilings.js getCikForTicker`) →
   newest `DEF 14A` filing → fetch the primary HTML document → split
   into named sections. 24h cache (proxies are annual). Never throws;
   every section independently nullable. (`DEFA14A` is supplementary
   soliciting material that usually lacks the bio/comp tables — do NOT
   fall back to it; absent `DEF 14A` → null sections, panel says so.)
2. **Best-effort, per-field graceful degradation.** DEF 14A is
   semi-structured HTML that varies by filer, counsel, and year. Each
   parser extracts what it can and returns `null` for fields it cannot
   confidently find. The panel renders "—" rather than guessing. This
   limitation is stated honestly in the UI and in verification — no
   faked completeness (same discipline as the WEI/SEC work).
3. **One route, one panel.** `GET /api/terminal/governance/:ticker` →
   `{ ticker, asOf, source, ceo, execs, board, comp, network }`. New
   client `MGMT` panel, tabbed, registered like `INSDR`, AI brief per
   the house pattern, auth/rate-limit inherited from the terminal router.
4. **Build order = 5 reviewed slices** (TDD, subagent-driven, feature
   branch → PR — identical rigor to INSDR):
   1. `proxyStatement.js` — fetch + section-split + cache + tests
   2. Leadership parser + `MGMT` panel shell + Leadership tab
   3. Board parser + Board tab
   4. Comp parser + Comp tab
   5. Network builder (holdings cross-ref) + Network tab

## Architecture

### Server — `services/proxyStatement.js` (new, the spine)

- `getProxyStatement(ticker)` →
  `{ ticker, filedAt, url, sections: { board, comp, execBios, ... }, _source }`
  or a stub when no proxy is found. Never throws (contract identical to
  `services/worldIndices.js` / `insiderTx.js`).
- `getCikForTicker` (existing) → submissions feed → newest filing whose
  `form` is `DEF 14A` (fallback `DEFA14A`). Fetch its primary document
  (apply the same raw-vs-`/xsl…/` lesson learned in INSDR — request the
  primary HTML/`.htm`, not a rendered viewer wrapper).
- Section split: locate proxy sections by heading patterns ("Election of
  Directors", "Director Compensation", "Executive Officers", "Summary
  Compensation Table", "Security Ownership", committee tables). Defensive
  regex/text extraction — no new XML/HTML-parser dependency unless the
  plan justifies one; if a lightweight HTML-to-text pass is needed,
  decide that in the plan.
- 24h in-process cache keyed by ticker.

### Server — four pure parser layers (read the cached proxy sections)

- `parseLeadership(sections)` → `{ ceo, execs[] }`,
  `exec = { name, title, age, since, priorRoles[], totalComp }`.
- `parseBoard(sections)` →
  `director[] = { name, age, since, independent, committees[], otherBoards[] }`.
- `parseComp(sections)` →
  `{ rows: [{ name, salaryPct, stockPct, optionPct, otherPct, total }] }`
  from the Summary Compensation Table.
- `buildNetwork(board, holdings)` — `holdings` from
  `services/sheetPortfolio.js`; emit edges where a director's
  `otherBoards` names another fund holding:
  `{ nodes: [...tickers/people], edges: [{ person, a, b }] }`.

Each parser is pure (section text in → structured/nullable out),
unit-tested with real-proxy HTML fixtures, and never throws.

### Server — route (in `routes/terminal.js`)

`GET /api/terminal/governance/:ticker` — same `verifyJwt` +
`requireExecutive` + limiter + ticker regex as `/chart` & `/insiders`.
Calls the spine once, runs the four parsers, returns the combined
payload; `200` with null sections when the proxy or a section is
unavailable; `502` only on a hard unexpected failure. Add `MGMT` to
`KNOWN_FUNCTIONS`.

### Client — `functions/Governance.jsx` (new) + registry + theme

Tabbed panel (Leadership · Board · Comp · Network), default Leadership.
Reuses `term-panel`/`term-table`/`term-ai-block`/loading-error states.
Network tab: a compact adjacency/edge list first (terminal-dense, low
risk); a force/graph visual only if it fits the aesthetic and effort —
decide in the plan, list-first is acceptable for v1. AI brief via
`/terminal/annotate` (`function:'MGMT'`). Register `MGMT`
(`requires:'ticker'`); cross-link to `INSDR`.

## Data flow

```
ticker → getProxyStatement (CIK → newest DEF 14A → primary HTML → sections, 24h cache)
      → parseLeadership / parseBoard / parseComp        (pure, nullable)
      → buildNetwork(board, sheetPortfolio holdings)    (bounded to fund)
      → { ceo, execs, board, comp, network } → MGMT panel tabs → AI brief
```

## Error handling

Per-layer try/catch in the route; the spine and parsers never throw.
No proxy found → `200`, all sections null → panel shows
"No recent DEF 14A on file." A parser that can't find its section →
that section null, others still render. Network with no overlaps → empty
state ("No shared boards among current holdings"). Mirrors the
never-throws contract of `worldIndices.js`/`insiderTx.js`.

## Testing & verification

- Server: `node --test` unit tests for each pure parser using committed
  **real DEF 14A HTML fixtures** (a few representative filers — large-cap
  clean, mid-cap messy) to exercise variance and the null-field paths.
- Spine smoke test against live SEC EDGAR (no key) for a known filer.
- **Honest caveat (stated in UI + reports):** parser coverage is
  best-effort; some fields will be blank for some filers and that is
  reported truthfully, not papered over. No metric is claimed verified
  without evidence (same standard applied to WEI/INSDR — incl. the
  Render-only / SEC-throttle honesty).
- Client: vite build for JSX correctness; manual tab check.

## Open items / risks (resolve in the plan)

- Some filers file the proxy as a graphics-heavy HTML or reference an
  ARS/PDF; text extraction quality varies. Plan decides the
  HTML→text approach and whether a minimal parser dep is justified.
- Summary Compensation Table layouts differ; `parseComp` targets the
  canonical column set and degrades per-row.
- "Other public directorships" phrasing varies ("also serves on the
  board of …", tabular director matrices); `parseBoard` uses multiple
  patterns and accepts partial recall — acceptable for the bounded
  Network use.
- `KNOWN_FUNCTIONS`/registry ordering: place `MGMT` adjacent to `INSDR`.
