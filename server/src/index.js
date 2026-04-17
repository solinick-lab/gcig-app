import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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
import { ensureRecurringMeetings } from './services/recurringMeetings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust Render's proxy so express-rate-limit + req.ip use the real client IP.
app.set('trust proxy', 1);

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
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

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Server error' });
});

const port = process.env.PORT || 4000;
app.listen(port, async () => {
  console.log(`GCIG API listening on http://localhost:${port}`);
  try {
    await ensureRecurringMeetings();
  } catch (err) {
    console.error('Failed to ensure recurring meetings:', err);
  }
});
