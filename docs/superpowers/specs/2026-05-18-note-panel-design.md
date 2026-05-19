# Terminal — NOTE (Per-User Research Notes Panel)

- **Date:** 2026-05-18
- **Status:** Approved (batch "build everything"; lead-dev autonomy;
  sub-project 5 of 7; on the cumulative `feat/fil-panel` panels
  branch alongside FIL/EARN/CON/CMP). First with a DB change.
- **Scope:** New `NOTE` terminal function: a private, per-user,
  per-ticker free-text research note, persisted to Postgres (one note
  per user per ticker, survives logout/reload). Additive.

## Why

A student doing DD wants to jot a thesis/notes on a ticker that
persist with their profile. No such concept exists. Mirrors the
established per-user persistence pattern (`presidentReview.js` +
the watchlist spec's model shape).

## Locked decisions

1. **One note per (user, ticker)** — upsert; no multiple notes/ticker
   (YAGNI). Private to the owning user.
2. Prisma model + a **hand-authored migration** (no local DB → write
   `migration.sql` mirroring an existing CREATE TABLE migration's
   format; Render runs `prisma migrate deploy` on boot per CLAUDE.md).
3. Server scoped strictly by `req.user.id` (`verifyJwt`); a user can
   only ever read/write/delete their own note. Never-throws/never-5xx;
   honest empty/loading/error/unauth states. `requires:'ticker'`.
4. Stays on the cumulative panels branch (registry accretes cleanly;
   `notes.js`/`index.js` mount/schema/migration are additive &
   isolated — no inter-panel conflict).

## Architecture

### DB — `server/prisma/schema.prisma` (new model + back-relation)
```prisma
model ResearchNote {
  id        Int      @id @default(autoincrement())
  userId    Int
  ticker    String
  body      String
  updatedAt DateTime @updatedAt
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([userId, ticker])
  @@index([userId])
}
```
`User` gets `researchNotes ResearchNote[]`. **Migration:**
`server/prisma/migrations/<UTC-timestamp>_add_research_notes/migration.sql`
hand-authored to match an existing CREATE-TABLE migration's exact SQL
conventions (quoted identifiers, the `@@unique`/`@@index` →
`CREATE UNIQUE INDEX`/`CREATE INDEX`, the FK
`ON DELETE CASCADE ON UPDATE CASCADE` like other Prisma-generated
migrations in the repo). Run `npx prisma generate` (no DB needed) so
the client types update; verify schema↔SQL consistency by eye against
a sibling migration. Do NOT run `prisma migrate dev` (no DB here).

### Server — `server/src/routes/notes.js` (new), mounted `/api/notes`
`router.use(verifyJwt)` (mirror `presidentReview.js`). Ticker
validated/uppercased per the existing `^[A-Z0-9.\-]{1,12}$`
convention.
- `GET /api/notes/:ticker` → `{ ticker, body, updatedAt }` for
  `where:{ userId:req.user.id, ticker }` (empty `{ ticker, body:'',
  updatedAt:null }` if none).
- `PUT /api/notes/:ticker` `{ body }` → trim, **cap 10000 chars**,
  `prisma.researchNote.upsert` on `@@unique([userId,ticker])`
  (idempotent) → the saved note. Empty/whitespace body → delete the
  note (so "clear + save" removes it) and return empty.
- `DELETE /api/notes/:ticker` → delete that user's note (absent =
  no-op success) → empty.
Every query/mutation hard-scoped by `userId:req.user.id`. Per-handler
try/catch → never 5xx (200 honest-empty / appropriate 4xx on bad
input). Mount in `server/src/index.js` next to the other `/api/*`
routers.

### Client — `client/src/terminal/functions/Notes.jsx` (new) + registry
- Registry: `{ id:'NOTE', label:'Notes', help:'Your private research
  notes for this ticker (saved to your profile).',
  requires:'ticker', component: Notes }` (import top; near
  FIL/EARN/CON/CMP; do NOT disturb their entries).
- On mount/ticker-change `GET /api/notes/:ticker` (cancelled-guard) →
  fill a `<textarea>`. An explicit **Save** button + a status line
  ("Saved ✓" / "Unsaved changes" / "Saving…" / error). `PUT` on save;
  a Clear that empties+saves (→ server deletes). Honest
  loading/empty/error states; if the request 401s, an honest
  "Sign in to keep notes" message (the shared `api` attaches JWT —
  terminal users are authed, but degrade honestly). Uses the shared
  `api`. No live polling.

## Data flow

```
open NOTE <ticker> → GET /api/notes/:ticker (userId-scoped) → textarea
edit → Save → PUT /api/notes/:ticker {body} → upsert (or delete if empty) → status
persisted by (userId,ticker) in Postgres → per-profile, durable
```

## Error handling

Server hard-scopes by `req.user.id` (no cross-user access possible via
the unique key), validates ticker + caps body, per-handler try/catch
→ never 5xx. Client keeps the user's edited text on a failed save
(shows error, does not wipe the textarea), honest states. New table
is additive — zero risk to existing data; migration is append-only.

## Testing

- Server: `notes.test.js` mirroring the project's injected-deps
  route-test style (inject a prisma-like stub — the same approach the
  watchlist spec defined; the terminal route tests' fakeReq/fakeRes
  pattern): per-user scoping (a query always carries
  `userId:req.user.id`; cannot read another user's note),
  upsert-idempotent PUT, body cap (10000), empty-body → delete,
  DELETE-own (absent no-op), `verifyJwt` required, never-5xx on bad
  input / stub reject. Full `cd server && npm test` green
  (was 125 on this branch → +N). `node --check`; `npx prisma
  generate` succeeds; schema↔migration.sql consistency eyeballed vs a
  sibling migration.
- Client: `npm run build` `✓ built`; reasoned walkthrough (no client
  harness): load existing note, edit→Save status cycle, clear→delete,
  ticker-change reloads the right note, failed save keeps text +
  error, loading/empty states.

## Build

Continues on `feat/fil-panel` (cumulative panels branch) — TDD,
subagent-driven. Single focused implementer (schema + migration +
route + mount + test, then panel + registry).
