# GCIG — Grace Church Investment Group

Full-stack web application for the student-run GCIG investment club. Invite-only
auth, pitch & event calendars, pitch deck archive, live portfolio tracker (Yahoo
Finance), research report library, and attendance tracking with CSV export.

- **Frontend**: React 18 + Vite + Tailwind (navy/gold theme, Inter font)
- **Backend**: Node.js + Express + Prisma
- **Database**: PostgreSQL
- **Stock data**: `yahoo-finance2` (no API key required)
- **Auth**: JWT + bcrypt, President-is-sole-admin permission model

---

## Prerequisites

- Node.js 20+
- PostgreSQL 14+ running locally (or via Docker)

Quickest way to get Postgres:

```bash
docker run --name gcig-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
docker exec -it gcig-pg psql -U postgres -c "CREATE DATABASE gcig;"
```

---

## First-time setup

```bash
# 1. Server
cd server
cp .env.example .env
# Edit .env: set DATABASE_URL and JWT_SECRET
npm install
npx prisma migrate dev --name init
npm run prisma:seed           # seeds the initial President account
npm run dev                   # starts API on http://localhost:4000

# 2. Client (new terminal)
cd ../client
npm install
npm run dev                   # starts Vite on http://localhost:5173
```

Open http://localhost:5173 and sign in with:

- **Email**: set in `server/prisma/seed.js`
- **Password**: set in `server/prisma/seed.js` — rotate immediately after first login

**Rotate this password immediately** via the Profile page.

---

## Roles & permissions

| Role                     | Admin |
|--------------------------|-------|
| President                | Yes   |
| CIO                      | No    |
| Senior Portfolio Manager | No    |
| Portfolio Manager        | No    |
| Senior Analyst           | No    |
| Junior Analyst           | No    |

Only the President can create/edit/delete pitches, events, reports, holdings,
attendance records, and member accounts. All other roles are read-only. All
write endpoints are gated server-side by `requireAdmin` middleware, and the
client hides edit controls via `<AdminOnly>` — but the server is authoritative.

### Inviting members

1. President opens the **Members** page
2. Clicks "Invite Member", fills in name / email / role
3. The server generates a one-time temporary password and returns it to the
   President, who shares it out-of-band (text, email, etc.)
4. The new member signs in and changes their password via Profile

---

## Features

### 1. Dashboard
Welcome banner, quick stats (next pitch, active holdings, upcoming events),
and a recent activity feed aggregated from pitches, events, and report uploads.

### 2. Upcoming Pitches Calendar
Month / week / day views powered by `react-big-calendar`. Click any event to
see pitcher, ticker, date/time, location, and the linked slideshow. President
can add / edit / delete.

### 3. Events Calendar
Separate calendar for speaker series, field trips, firm visits, etc.

### 4. Pitch Archive
Grid of all past pitches that have a slideshow attached. Searchable by ticker
or pitcher name. Clicking opens a full-screen in-browser PDF viewer
(`react-pdf`) with page navigation. `.pptx` files are accepted but offered as
a download (no in-browser .pptx renderer exists without paid services — convert
to PDF for the best experience).

### 5. Live Portfolio Tracker
Table of all positions with live quotes pulled from Yahoo Finance via
`yahoo-finance2`. Each row shows shares, avg cost basis, current price, value,
gain/loss $, and gain/loss %. Summary row tallies portfolio-wide totals. A
`recharts` line chart shows performance over time, backed by a
`PortfolioSnapshot` table that captures the total value each day the page is
loaded.

Quotes are cached server-side for 60 seconds to avoid hammering Yahoo. If Yahoo
returns no data for a ticker, the row still renders with `—` values.

### 6. Research Reports
Library of uploaded PDFs tagged with title, author, ticker, date, and short
description. Searchable and filterable.

### 7. Attendance Tracker
- **President view**: matrix of members × events, dropdown per cell to mark
  Present / Absent / Excused. "Export CSV" button downloads the full sheet.
- **Member view**: their own attendance history plus an attendance percentage
  (counting Present and Excused as "attended").

---

## Project layout

```
gcig-app/
├── server/
│   ├── prisma/
│   │   ├── schema.prisma      Models + enums
│   │   └── seed.js            Seeds the initial President
│   ├── src/
│   │   ├── index.js           Express bootstrap
│   │   ├── db.js              Prisma singleton
│   │   ├── middleware/
│   │   │   └── auth.js        verifyJwt + requireAdmin
│   │   ├── routes/
│   │   │   ├── auth.js, users.js, pitches.js, events.js,
│   │   │   ├── holdings.js, reports.js, attendance.js, dashboard.js
│   │   └── services/
│   │       ├── quotes.js      yahoo-finance2 wrapper + cache
│   │       └── upload.js      multer config
│   └── uploads/               Runtime file storage (gitignored)
│
└── client/
    ├── src/
    │   ├── main.jsx / App.jsx
    │   ├── api/client.js      axios instance with JWT interceptor
    │   ├── context/AuthContext.jsx
    │   ├── components/        Layout, Sidebar, RoleBadge, Button, Card, Modal, …
    │   └── pages/             Login, Dashboard, Pitches, Events,
    │                          PreviousPitches, Portfolio, Reports,
    │                          Attendance, Members, Profile
    ├── tailwind.config.js     Navy (#1B2A4A) / gold (#C9A84C) palette
    └── vite.config.js         Dev proxy /api → :4000
```

---

## Environment variables

`server/.env`:

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/gcig?schema=public"
JWT_SECRET="change-this-to-a-long-random-string"
PORT=4000
CLIENT_ORIGIN="http://localhost:5173"
```

Generate a strong JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Production notes

This scaffold is production-capable with a few hardening steps:

1. Swap `localStorage` JWT storage for httpOnly cookies
2. Add rate limiting (e.g. `express-rate-limit`) on `/auth/login`
3. Put uploads behind a real object store (S3) once the collection grows
4. Put HTTPS in front of both services
5. Run `prisma migrate deploy` instead of `migrate dev` in production
6. Set `NODE_ENV=production` and remove the CORS `origin` to be strict

---

## License

Private / internal to GCIG.
# gcig-app
