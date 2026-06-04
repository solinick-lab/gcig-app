# Griffin Fund — "Sell the position" vote

- **Date:** 2026-06-03
- **Status:** Approved design (vote choices, downstream wiring, position
  source, and weighting confirmed by user via brainstorming). Awaiting spec
  review before implementation planning.
- **Scope:** Add a second kind of voting session — a vote to **exit an
  existing holding** — alongside the existing buy-pitch vote. A sell session
  offers two analyst calls, **Sell** (exit) or **Hold** (keep); carries no
  recommended dollar amount; is opened against a position we actually own;
  and, when it passes, becomes a claimable Sell line in the existing Trade
  Requests → DocuSign envelope flow. Shipped as one release.

## Why

The voting system was built for *new ideas*: a member pitches a ticker, the
club rates it Buy / Hold / Sell, and a passing Buy flows into a trade
confirmation. There is no first-class way to ask the inverse — "we **own**
XYZ; should we **dump** it?" The `Sell` ballot value exists, but a session is
structured around a buy pitch (a proposed allocation, an attached pitch) and
a `Sell` ballot leads nowhere downstream. Now that the club is actively
unwinding positions, members need to vote to exit a holding and have that
decision flow into the same DocuSign trade-confirmation pipeline a buy does.
The framing is deliberately analyst-desk: members are issuing a Sell / Hold
rating on a name the fund holds, not casting a yes/no poll.

## Locked decisions

1. **Two choices, no amount.** A sell session offers exactly **Sell** and
   **Hold**. No `investmentAmount` on any sell ballot — the default intent is
   to exit the whole position; leadership sizes the actual order downstream.
2. **Same weighting as a buy vote.** `computeTally` is reused **unchanged**:
   general-body majority = 3 weighted votes, each President/CIO = 1, a final
   tie → `Hold`. For a sell vote, tie → `Hold` is the correct conservative
   default ("when in doubt, keep the position"). No per-kind weighting.
3. **Opened against a real holding.** The "Start Sell Vote" form picks the
   ticker from current holdings (Google Sheet portfolio mirror), not free
   text. No attached pitch, no allocation field.
4. **Passing feeds the trade flow.** A closed sell session with
   `finalDecision = "Sell"` becomes a selectable, linked Sell line in the
   Trade Requests composer, pre-sized to sell the entire held position
   (shares from the sheet). It bundles into the same DocuSign envelope a buy
   does. The exec can still adjust shares before sending.
5. **One model, a `kind` discriminator.** `VotingSession.kind`
   (`"buy"` default | `"sell"`). Reuses ballots, tally, lazy auto-close, AI
   recap, and DocuSign linkage. No separate `SellVote` model.
6. **No new `VoteAction` value.** Sell ballots reuse the existing `Sell` and
   `Hold` enum members. The `kind` field, plus server-side action
   validation, is what distinguishes a sell session.
7. **Buy-pitch sessions are untouched.** They keep Buy / Hold / Sell, the
   proposed-allocation band ($1,500–$10,000), and pitch attachment exactly
   as today.

## Architecture

### `server/prisma/schema.prisma` (modified)
Add to `model VotingSession`:

```
kind String @default("buy")   // "buy" (pitch) | "sell" (exit a holding)
```

String, not an enum — matches the existing `TradeRequestItem.kind`
convention and avoids an `ALTER TYPE`. New additive migration
`add_voting_session_kind` (`npx prisma migrate dev`) → emits
`ALTER TABLE "VotingSession" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'buy'`.
Every existing row becomes `"buy"`, which is correct. No backfill, no
down-migration concern. `npx prisma generate` to refresh client types.

### `server/src/routes/votes.js` (modified)
- **`computeTally`** — unchanged. It already counts Sell/Hold and weights
  them; `buyAmountStats` naturally returns `null` when no Buy ballots exist.
- **`POST /` (create)** — accept `kind` from the body (default `"buy"`;
  reject any value not in `{"buy","sell"}`). For a sell session, still
  require `ticker` + `deadline`; ignore `pitchId` (force null) since a sell
  vote is about a holding, not a pitch. Store `kind`. Return it.
- **`POST /:id/ballot`** — load the session first (already does, for the
  open/deadline check), then validate `action` against the session's kind:
  - `kind === "sell"` → `action ∈ {"Sell","Hold"}` (reject `Buy` with 400);
    `investmentAmount` forced `null` regardless of payload.
  - `kind === "buy"` → unchanged (`Buy`/`Hold`/`Sell`; `Buy` requires an
    amount in band).

  Refactor: move the existing `session` fetch above the action validation so
  `kind` is available, then branch the allowed-action set on it.
- **`GET /`, `GET /pending`, `GET /:id`** — add `kind` to the selected/
  returned fields (it's on the row, so `findMany`/`findUnique` already carry
  it; confirm nothing strips it). The client branches on `kind`.

### `server/src/services/articleSummarizer.js` (modified)
`summarizeVoteSession` becomes kind-aware. For `kind === "sell"`, the prompt
frames an **analyst-style exit note** — the decision is Sell vs Hold on a
position the fund holds, the recap should read like a sell-side rating
rationale, not a buy thesis. Keep the buy prompt as-is. Single branch on
`session.kind`.

### `server/src/routes/pitches.js` + `server/src/routes/users.js` (modified — correctness fix)
Both infer a pitch's outcome from the **most-recent closed `VotingSession`
for the ticker** (`pitches.js` ~line 323, `users.js` ~line 323). A sell
session on a held ticker (Sell/Hold ballots, zero Buys) would become that
most-recent session and flip an old buy-pitch's outcome to `NoBuy`. Scope
both lookups to buy sessions:

```
where: { ticker: { in: myTickers }, status: 'closed', kind: 'buy' }
```

This keeps pitch-outcome inference reading only the votes that were about
*acquiring* the name. (Verified both sites share the same shape.)

### `server/src/routes/tradeRequests.js` (modified)
- **New `GET /trade-requests/eligible-sells`** — mirror of `eligible-buys`:
  closed `VotingSession`s with `kind = "sell"` and a recomputed
  `finalDecision = "Sell"`, **not** already claimed by a
  `TradeRequestItem.votingSessionId`. Annotate each with the **current held
  shares** for that ticker from `getSheetPortfolio()` so the composer can
  pre-size "sell the whole position" (null/0 if the sheet is unreachable or
  the position is already gone — surface that, don't block).
- **`POST /` (create trade request)** — allow a `Sell` line to carry a
  `votingSessionId`. When present: validate the referenced session is
  `closed`, `kind === "sell"`, `finalDecision === "Sell"`, and unclaimed;
  link it (so it drops out of `eligible-sells`, exactly as buy sessions drop
  out of `eligible-buys`). Sizing: default to the full held share count from
  the sheet; honor an explicit `shares` override from the composer. A Sell
  line with **no** `votingSessionId` keeps working as today (manual,
  SPY/VOO-style cash raising).
- DocuSign needs **no** template or anchor change — a vote-driven Sell line
  is just another `\buysell{N}\` = `Sell` row in the bundled envelope.

### `client/src/pages/Votes.jsx` (modified)
- **"Start Voting Session" modal** gets a **Buy pitch / Sell position**
  toggle at the top.
  - *Buy pitch* (default): the current form (free-text ticker, optional
    title, attach pitch, deadline) — unchanged.
  - *Sell position*: a **position dropdown** sourced from current holdings
    (sheet) showing ticker + shares + value; optional question (placeholder
    e.g. "Time to exit AAPL?"); deadline. No pitch attach, no allocation.
    Submits `{ kind: "sell", ticker, title, deadline }`.
- **Ballot UI** (`SessionDetail`) branches on `session.kind`:
  - `"sell"` → render two analyst buttons from a sell-specific action set:
    **Sell** ("Exit the position", `TrendingDown`/red) and **Hold**
    ("Maintain", `Minus`/gold). Hide the allocation input entirely.
  - `"buy"` → unchanged three-button Buy/Hold/Sell with the allocation field.
- **Results/tally** — reuse the weighted-bar + general-body/leadership
  layout (it's choice-agnostic). For a sell session, hide the "Proposed Buy
  allocation" block (no Buy ballots → already empty, but gate it on `kind`
  to be explicit). Final-decision card shows `SELL` / `HOLD`.
- **Analyst framing** — sell sessions carry an analyst-desk kicker (e.g.
  "Coverage" / "Rating" rather than "Decisions") and the Sell/Hold buttons
  use the rating descriptors above.

### `client/src/components/VoteNotification.jsx` (modified)
Kind-aware copy. Sell session → "A new sell vote on **{TICKER}** has been
started by {creator.name}. Cast your Sell or Hold rating before the
deadline." Buy session → current copy. (Needs `kind` + `ticker` on the
`/votes/pending` payload, which the route already returns.)

### `client/src/pages/TradeRequests.jsx` (modified)
Add a **"Passed sell votes"** picker fed by `GET /eligible-sells`, alongside
the existing eligible-buys picker. Each entry is addable as a Sell line
pre-filled to the **whole held position** (shares from the annotation) and
carries its `votingSessionId`. The existing manual Sell line (default
VOO/SPY, sized by shares or cover-amount, no session link) stays for pure
cash-raising. The existing over-sell check against the sheet still applies.

## Edge cases

- **Tie on a sell vote** → `Hold` (no exit). Correct and already the tally
  default; no special-casing.
- **Sell session whose `finalDecision` is `Hold`** → never appears in
  `eligible-sells`; nothing flows downstream. The recap still explains the
  hold.
- **Position already sold before the vote closes** (sheet shows 0 shares) →
  `eligible-sells` annotates held-shares as 0/null; composer shows it but the
  over-sell guard prevents sending a phantom order. Surface, don't crash.
- **Sheet unreachable at create time** → position dropdown falls back
  gracefully (empty/loading state); exec can retry. Never hard-fail the
  modal. (Mirrors `getSheetPortfolio().catch(() => null)` usage elsewhere.)
- **A buy pitch and a sell vote exist for the same ticker** → independent
  rows; pitch-outcome inference reads only `kind:'buy'`, so the sell vote
  never colors the member's pitch record.
- **Client sends `Buy` on a sell session** (stale UI / API poke) → 400 from
  the ballot validator. Defense in depth beyond the UI only showing two
  buttons.
- **`investmentAmount` sent on a sell ballot** → forced `null` server-side,
  same way Hold/Sell already nullify it today.

## Testing

- **`votes` route / `computeTally`:**
  - Tally over Sell/Hold-only ballots: weighting matches a buy session
    (general body 3, leadership 1 each), `buyAmountStats === null`, tie →
    `Hold`.
  - `POST /:id/ballot` on a sell session: `Buy` → 400; `Sell`/`Hold` → 200
    with `investmentAmount === null` even when an amount is posted.
  - `POST /` with `kind:"sell"` stores `kind` and forces `pitchId` null;
    invalid `kind` → 400.
- **Pitch-outcome inference:** a closed `kind:"sell"` session for a ticker
  does **not** change the inferred outcome of a buy pitch on that ticker
  (`pitches.js` + `users.js`); a `kind:"buy"` session still does.
- **`eligible-sells`:** returns only closed sell sessions with
  `finalDecision === "Sell"` and no claiming `TradeRequestItem`; a claimed
  one is excluded; held-shares annotation present.
- **`POST /trade-requests`:** a Sell line with a valid `votingSessionId`
  links + claims the session (it disappears from `eligible-sells`); an
  invalid reference (open / wrong kind / not-Sell / already claimed) → 400;
  a manual Sell line with no `votingSessionId` still works.
- **Client:** `npm run build` clean. Manual QA — open a sell vote from a
  held position; cast Sell and Hold; close; confirm SELL result + analyst
  recap; confirm it appears in the Trade Requests composer pre-sized to the
  full position and bundles into an envelope.

## Build order (single release)

1. Prisma: add `kind`, `migrate dev`, `prisma generate`.
2. `votes.js`: create accepts `kind`, ballot validates actions per kind.
3. `articleSummarizer.js`: kind-aware recap prompt.
4. `pitches.js` + `users.js`: scope outcome inference to `kind:'buy'`.
5. `tradeRequests.js`: `eligible-sells` + Sell-line `votingSessionId`
   linking/validation.
6. `Votes.jsx`: session-type toggle + position picker + sell ballot UI +
   analyst framing.
7. `VoteNotification.jsx`: kind-aware copy.
8. `TradeRequests.jsx`: passed-sell-votes picker.
9. Tests (votes route, inference, trade-requests) + client build + manual QA.

## Non-goals (YAGNI)

- **No partial sell / trim / percentage.** Default intent is exit the whole
  position; the exec adjusts shares in the composer if they want less. No
  "sell N%" or sell-amount field on the ballot.
- **No auto-send of the DocuSign envelope on sell-vote close.** Same manual
  exec gate as buys — they eyeball the order first ("Things NOT to do").
- **No change to buy-pitch sessions** (choices, allocation band, pitch
  attach all unchanged).
- **No new role gate.** Creating a sell session uses the existing
  `requireExecutive` on `POST /votes`.
- **No reversal/undo of a passed sell vote** beyond deleting the session
  (existing `DELETE /votes/:id`).
