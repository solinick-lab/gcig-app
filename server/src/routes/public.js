import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { nameProfile } from '../services/nameGender.js';

// Endpoints that are intentionally unauthenticated — consumed by pages
// the public can see (Landing, /invite/accept, etc.).
//
// Keep this route file small and obvious. Anything sensitive belongs
// behind verifyJwt elsewhere.

const router = Router();

// Per-IP throttle — prevents someone from turning the name-gender
// endpoint into a free personal classifier. 60 requests / 5 min / IP
// is plenty for the Landing page's one-time batch lookup.
const publicLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again in a few minutes.' },
});

// Batch lookup — POST { names: [...] } → { results: [{ name, firstName,
// gender, honorific, honorificName, pronouns, confidence }, ...] }.
// Accepts up to 50 names per request (covers the Landing roster many
// times over). Returns the same shape for every input name, with
// null/neutral fallbacks when the name can't be confidently resolved.
router.post('/name-gender', publicLimiter, (req, res) => {
  const { names } = req.body || {};
  if (!Array.isArray(names)) {
    return res.status(400).json({ error: 'names must be an array' });
  }
  if (names.length > 50) {
    return res.status(400).json({ error: 'Too many names (max 50)' });
  }
  const results = names.map((n) => {
    if (typeof n !== 'string') return { name: String(n), error: 'invalid' };
    const profile = nameProfile(n);
    return {
      name: n,
      firstName: profile.firstName,
      gender: profile.gender,
      confidence: profile.confidence,
      honorific: profile.honorific,
      honorificName: profile.honorificName,
      pronouns: profile.pronouns,
    };
  });
  res.json({ results });
});

export default router;
