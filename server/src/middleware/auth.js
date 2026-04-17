import jwt from 'jsonwebtoken';
import prisma from '../db.js';

export const COOKIE_NAME = 'gcig_session';

// Cookie options: always httpOnly, always secure in prod, sameSite=none so the
// cross-origin client (gcig-client → gcig-api) can send it along.
export function cookieOptions() {
  const prod = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
  return {
    httpOnly: true,
    secure: prod,
    sameSite: prod ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
    path: '/',
  };
}

export function issueJwt(res, user) {
  const token = jwt.sign(
    { id: user.id, role: user.role, v: user.tokenVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.cookie(COOKIE_NAME, token, cookieOptions());
  return token;
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: 0 });
}

export async function verifyJwt(req, res, next) {
  // Prefer the cookie (set at login). Fall back to Authorization header for
  // clients that still send it (e.g. tools / legacy sessions).
  let token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      token = header.slice(7);
    }
  }
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Always fetch the current role AND tokenVersion from the DB.
    // If the user rotated their tokenVersion (e.g. via logout-everywhere),
    // all old JWTs are immediately invalid.
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, name: true, role: true, tokenVersion: true },
    });
    if (!user) return res.status(401).json({ error: 'User not found' });
    if ((payload.v ?? 0) !== (user.tokenVersion ?? 0)) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Session revoked, please sign in again' });
    }
    req.user = { id: user.id, name: user.name, role: user.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'President') {
    return res.status(403).json({ error: 'President role required' });
  }
  next();
}

// Executive tier: President + CIO. Has admin powers for most features but
// cannot perform destructive user-account operations (delete member, reset
// password). Those remain President-only via requireAdmin.
const EXECUTIVE_ROLES = new Set(['President', 'CIO']);
export function requireExecutive(req, res, next) {
  if (!req.user || !EXECUTIVE_ROLES.has(req.user.role)) {
    return res.status(403).json({ error: 'Executive role (President or CIO) required' });
  }
  next();
}

// Operational permission hierarchy (higher number = more power).
// Advisory Board Members and Faculty Advisors sit OUTSIDE the operational chain
// — they are observers with no edit rights. They get the lowest operational
// rank so permission gates treat them as view-only.
export const ROLE_RANK = {
  President: 10,
  CIO: 9,
  SeniorPortfolioManager: 8,
  PortfolioManager: 7,
  SeniorAnalyst: 6,
  Analyst: 5,
  JuniorAnalyst: 4,
  AdvisoryBoardMember: 1,
  FacultyAdvisory: 1,
};

// Look up the role string for a given numeric rank. Returns null if no match.
export function roleForRank(rank) {
  for (const [role, r] of Object.entries(ROLE_RANK)) {
    if (r === rank) return role;
  }
  return null;
}

export function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole] || 0;
  return (req, res, next) => {
    const rank = ROLE_RANK[req.user?.role] || 0;
    if (rank < minRank) {
      return res.status(403).json({ error: `${minRole} role or higher required` });
    }
    next();
  };
}
