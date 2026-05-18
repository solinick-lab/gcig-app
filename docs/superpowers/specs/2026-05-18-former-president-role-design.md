# GCIG — Former President role (step-down → Junior Analyst + honorific badge)

- **Date:** 2026-05-18
- **Status:** Approved design (role shape, transition trigger, and
  architecture confirmed by user via brainstorming). Awaiting spec review
  before implementation planning.
- **Scope:** Add a "Former President" recognition badge and a President-only
  "Step down" action. Stepping down sets the member's primary role to
  `JuniorAnalyst` (zero admin/executive power) and adds a no-power
  `FormerPresident` badge to `extraRoles`. Shipped as one release.

## Why

GCIG runs a "President-is-sole-admin" permission model. When a President
leaves office there is no first-class way to record that they *were*
President while stripping their power. Today the only option is a plain
role change to some analyst tier, which silently erases the fact that the
person led the club. We want the title preserved and the power gone:
operationally a former president is a junior analyst, but the directory
still shows they were President.

## Locked decisions

1. **Honorific badge, not a power-bearing role.** Primary `role` becomes
   `JuniorAnalyst` (rank 4 — votes, attendance, industry membership, zero
   admin). `FormerPresident` is added to `extraRoles` purely as a
   recognition badge. No permission gate ever reads `extraRoles` for rank,
   so the badge confers nothing.
2. **`FormerPresident` is still added to the `Role` enum.** Required
   because `extraRoles` is typed `Role[]` in Prisma and the
   `PUT /:id/extra-roles` validator checks membership in the role list. It
   is given `ROLE_RANK` `0`, so even if it were ever mis-set as a *primary*
   role it would confer no power (defense in depth).
3. **Badge-only, enforced server-side.** A new `ASSIGNABLE_ROLES` list
   (= `ROLES` minus `FormerPresident`) gates every endpoint that sets a
   *primary* role (invite, `PUT /:id`, `PUT /:id/role`). `extra-roles`
   keeps validating against the full `ROLES` list. Result: `FormerPresident`
   can only ever exist as a badge, never as someone's primary role.
4. **Transition is manual only.** No auto-demotion on handover (explicitly
   chosen). A President-only `POST /users/:id/step-down` action performs the
   change atomically. The President operates it from the Members page,
   including on their own row.
5. **Guarded + atomic.** `step-down` requires the caller to be President
   (`requireAdmin`) and the target's current `role` to be `President`
   (else 400). One Prisma `update` sets `role: 'JuniorAnalyst'` and a
   deduped `extraRoles` including `'FormerPresident'`; one audit entry.
6. **No session/token rotation.** `verifyJwt` re-reads `role` from the DB
   on every request, so the stepped-down user loses power on their very
   next request without a forced re-login. The stale `role` claim in their
   JWT is unused for authorization.
7. **Sticky by design.** A former president stays a former president; the
   badge is not removed when they are later given another role. Removal /
   mis-application correction is out of v1 scope (an Executive can use the
   existing `PUT /:id/extra-roles` API if ever needed).

## Architecture

### `server/prisma/schema.prisma` (modified)
Add `FormerPresident` to `enum Role` (place it after `FacultyAdvisory`, at
the end, so existing enum ordinals are untouched). New additive migration
`add_former_president_role` (`npx prisma migrate dev`) → emits
`ALTER TYPE "Role" ADD VALUE 'FormerPresident'`. No data backfill, no
down-migration concern; existing rows unaffected. Run `npx prisma generate`
to refresh client types.

### `server/src/middleware/auth.js` (modified)
- `ROLE_RANK`: add `FormerPresident: 0`.
- Do **not** add it to `EXECUTIVE_ROLES` or `PRESIDENT_ONLY_ROLES`.
- No other changes — `requireAdmin` / `requireExecutive` / `requireRole`
  already key off primary `role` only, so a `JuniorAnalyst`-with-badge is
  correctly powerless.

### `server/src/routes/users.js` (modified)
- `ROLES`: add `'FormerPresident'` (keeps `extra-roles` validation valid).
- `ROLE_LABELS`: add `FormerPresident: 'Former President'`.
- New `const ASSIGNABLE_ROLES = ROLES.filter((r) => r !== 'FormerPresident');`
- Replace the `ROLES.includes(role)` primary-role checks with
  `ASSIGNABLE_ROLES.includes(role)` in: `POST /` (invite), `PUT /:id`,
  `PUT /:id/role`. Leave `PUT /:id/extra-roles` validating against `ROLES`.
- New endpoint:

  ```
  POST /users/:id/step-down   (requireAdmin — President only)
  ```
  - Load target; 404 if missing.
  - If `target.role !== 'President'` → 400
    `{ error: 'Only a sitting President can step down' }`.
  - `prisma.user.update({ where:{id}, data:{
      role: 'JuniorAnalyst',
      extraRoles: Array.from(new Set([...(target.extraRoles||[]),
                                      'FormerPresident'])),
    }})` selecting `{id,name,email,role,extraRoles}`.
  - `auditReq(req, 'user.stepped_down', 'user', id,
      { from:'President', to:'JuniorAnalyst', badge:'FormerPresident' })`.
  - Return the updated user. Idempotent: the `Set` dedupes; the
    `role==='President'` guard prevents a second meaningful run.

### `client/src/components/RoleBadge.jsx` (modified)
- `ROLE_LABELS`: add `FormerPresident: 'Former President'`.
- `VARIANTS`: add `FormerPresident: 'bg-navy-50 text-navy border-gold-300'`
  — echoes the presidential navy/gold but lighter, reading as honorary
  rather than active office. Single seam: every render site (Members,
  directory, profile) uses `RoleBadge`, so this covers all of them.

### `client/src/pages/Members.jsx` (modified)
- Do **not** add `FormerPresident` to the local `ROLES` const. That const
  feeds both the primary-role `<select>` and the `ExtraRoleEditor`
  checkboxes; omitting it keeps the badge out of both, matching
  "set only via step-down". The existing `ExtraRoleEditor` already
  preserves unknown existing `extraRoles` on save (it seeds `selected`
  from `user.extraRoles`), so a member's `FormerPresident` badge survives
  unrelated extra-role edits and still renders via the badge map at the
  top of the row.
- Add `handleStepDown(id)`: `window.confirm(...)` →
  `api.post('/users/'+id+'/step-down')` → `load()`; surface
  `err.response?.data?.error` like `handleRoleChange` does.
- Render a "Step down as President" control on each member row, shown only
  when the viewer is President and that row's `u.role === 'President'`,
  placed next to the role `<select>` (both desktop table and mobile card
  layouts). Confirm copy: *"{name} will become a Junior Analyst and keep
  the Former President title. This removes all presidential powers and
  cannot be undone from this screen. Continue?"*

## Edge cases

- **President steps self down, no successor:** allowed. The super-admin
  tier is email-based (`SUPER_ADMIN_EMAIL`) and role-independent, so it can
  still appoint a new President — the club is never permanently locked out.
  Not blocked; documented.
- **`extraRoles` already has `FormerPresident`:** `Set` dedupes; the
  `role==='President'` guard makes a repeat call a no-op 400 anyway.
- **Former president promoted again later:** primary role changes normally
  via existing endpoints; the badge persists (accurate — they remain a
  former president). Reversal is out of v1 scope.
- **Attendance:** `JuniorAnalyst` is not in `ATTENDANCE_EXEMPT_ROLES`, and
  attendance logic reads primary `role` only — a former president attends
  like a junior analyst, exactly "like a junior analyst basically". No
  attendance code changes.

## Testing

- **`auth.test.js`:** `ROLE_RANK.FormerPresident === 0`; `requireAdmin`,
  `requireExecutive`, and `requireRole('JuniorAnalyst')` all deny a request
  whose `req.user.role` is `FormerPresident`.
- **users route tests:**
  - President → `POST /:id/step-down` on a President target: 200, target
    `role === 'JuniorAnalyst'`, `extraRoles` contains `FormerPresident`,
    audit row written.
  - Non-President caller → 403; target not a President → 400; second call
    → 400 (guard); duplicate badge not added (dedupe).
  - `FormerPresident` rejected as a *primary* role by `POST /` invite,
    `PUT /:id`, and `PUT /:id/role` (ASSIGNABLE_ROLES); still accepted by
    `PUT /:id/extra-roles`.
- **Powerless-after-step-down:** a stepped-down user's next
  `verifyJwt`-authenticated request resolves `role` as `JuniorAnalyst`
  from the DB and is denied an executive route (extends the existing
  `verifyJwt` DB-refresh test pattern).
- **Manual QA:** as President, step a President down from Members (desktop
  + mobile); badge shows on their row and in the directory; the
  step-down control disappears once they are no longer President; they can
  no longer reach President/Executive screens.

## Build order (single release)

1. Prisma: add enum value, `migrate dev`, `prisma generate`.
2. `auth.js`: `ROLE_RANK.FormerPresident = 0`.
3. `users.js`: `ROLES`/`ROLE_LABELS` entries, `ASSIGNABLE_ROLES` split +
   apply to the three primary-role endpoints, new `step-down` endpoint.
4. `RoleBadge.jsx`: label + variant.
5. `Members.jsx`: `handleStepDown` + the President-only row control
   (desktop + mobile).
6. Tests (auth + users route).
7. Manual QA checklist.

## Non-goals (YAGNI)

- No automatic demotion on presidential handover (manual-only chosen).
- No generalized "Former <Officer>" framework — only Former President now.
- No step-down reversal / badge-removal UI.
- No email or broadcast notification on step-down (audit log is the record).
