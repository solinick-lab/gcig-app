import jwt from 'jsonwebtoken';
import prisma from '../db.js';

export async function verifyJwt(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Always fetch the current role from the DB so role changes
    // take effect immediately without requiring a re-login.
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, role: true },
    });
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = { id: user.id, role: user.role };
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

// Permission hierarchy (higher number = more power).
// Advisory Board Members and Faculty Advisors sit directly below Presidents
// as senior observers — outranked only by the executive tier.
export const ROLE_RANK = {
  President: 20,
  AdvisoryBoardMember: 19,
  FacultyAdvisory: 19,
  CIO: 15,
  SeniorPortfolioManager: 14,
  PortfolioManager: 13,
  SeniorAnalyst: 12,
  Analyst: 11,
  JuniorAnalyst: 10,
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
