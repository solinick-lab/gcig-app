import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generalLimiter } from './middleware/rateLimit.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import pitchRoutes from './routes/pitches.js';
import eventRoutes from './routes/events.js';
import holdingRoutes from './routes/holdings.js';
import reportRoutes from './routes/reports.js';
import attendanceRoutes from './routes/attendance.js';
import dashboardRoutes from './routes/dashboard.js';
import voteRoutes from './routes/votes.js';
import industryRoutes from './routes/industries.js';
import auditRoutes from './routes/audit.js';
import twoFactorRoutes from './routes/twoFactor.js';
import chatRoutes from './routes/chat.js';
import broadcastRoutes from './routes/broadcasts.js';
import systemRoutes from './routes/system.js';
import aiChatRoutes from './routes/aiChat.js';
import publicRoutes from './routes/public.js';
import filesRoutes from './routes/files.js';
import pitchRequestRoutes from './routes/pitchRequests.js';
import cpiRoutes from './routes/cpi.js';
import seaRoutes from './routes/sea.js';
import { ensureRecurringMeetings } from './services/recurringMeetings.js';
import cron from 'node-cron';
import { regenerate as regenerateDayInReview } from './services/dayInReview.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust Render's proxy so express-rate-limit + req.ip use the real client IP.
app.set('trust proxy', 1);

// Security headers. We're an API — the client is a separate static site —
// so we don't need a CSP here, but clickjacking and MIME-sniffing defenses
// are still worth having.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// Comma-separated list of allowed client origins. Set CLIENT_ORIGIN to e.g.
//   https://thegriffinfund.org,https://www.thegriffinfund.org,https://gcig-client.onrender.com
const ALLOWED_ORIGINS = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Requests with no Origin header (server-to-server, curl) pass through.
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    // Browser JS can only read response headers that are explicitly
    // exposed. verifyJwt sets X-New-Token when a token is being
    // silently rotated; without this whitelist the client's axios
    // interceptor would never see the header.
    exposedHeaders: ['X-New-Token'],
  })
);
// `verify` runs before JSON.parse and gets the raw bytes — the only safe
// place to capture them, because once express.json() finishes the request
// stream is already drained. Routes that need to validate an HMAC over the
// exact bytes the client signed (currently /api/cpi/ingest) read req.rawBody.
app.use(
  express.json({
    limit: '25mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use('/api', generalLimiter);

// Serve uploaded files (PDF, PPTX)
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/pitches', pitchRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/holdings', holdingRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/votes', voteRoutes);
app.use('/api/industries', industryRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/2fa', twoFactorRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/broadcasts', broadcastRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/ai-chat', aiChatRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/pitch-requests', pitchRequestRoutes);
app.use('/api/cpi', cpiRoutes);
app.use('/api/sea', seaRoutes);

// Generic error handler. Logs the full error server-side for debugging but
// never leaks internal details (stack traces, Prisma error bodies, etc.) to
// the client. Routes that want a user-visible message should throw an
// Error with a `.status` field set and a safe `.message`.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(`[${req.method} ${req.originalUrl}]`, err);
    return res.status(status).json({ error: 'Internal server error' });
  }
  // 4xx errors with explicit messages (e.g. validation) stay as-is.
  res.status(status).json({ error: err.message || 'Bad request' });
});

// ── Scheduled jobs ────────────────────────────────────────────────────
// Daily 4:05 PM America/New_York — proactively warm the Day-in-Review
// cache so the first dashboard load after market close is instant
// instead of waiting 10-30s for the LLM. 5 minutes after the cache
// key flips so we're safely in the new review-day window.
//
// Requires the API service to run continuously (Render Starter+ tier).
// On the free spin-down tier this still works while the service is
// awake, just doesn't fire if nobody's pinged the API for 15+ min.
// The lazy /day-in-review endpoint is the safety net either way.
cron.schedule(
  '5 16 * * *',
  () => {
    console.log('[cron] day-in-review: regenerating after 4pm ET close');
    regenerateDayInReview({ force: true })
      .then((r) => {
        if (r) {
          console.log(
            `[cron] day-in-review: generated for ${r.reviewDay} at ${r.dayInReviewAt}`
          );
        } else {
          console.warn('[cron] day-in-review: generator returned null');
        }
      })
      .catch((err) => {
        console.error('[cron] day-in-review failed:', err.message);
      });
  },
  { timezone: 'America/New_York' }
);

const port = process.env.PORT || 4000;
app.listen(port, async () => {
  console.log(`GCIG API listening on http://localhost:${port}`);
  try {
    await ensureRecurringMeetings();
  } catch (err) {
    console.error('Failed to ensure recurring meetings:', err);
  }
});
