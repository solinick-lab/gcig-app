import rateLimit from 'express-rate-limit';

// Tight limit on authentication endpoints to blunt brute force attacks.
// Window is 5 minutes; after the limit the client must wait.
export const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please wait a few minutes and try again.' },
});

// Even tighter for verification code and reset links — these are brute-force
// targets because the code/token space is smaller.
export const codeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please request a new code.' },
});

// Generic ceiling so a single client can't spam any one endpoint thousands
// of times per minute.
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
