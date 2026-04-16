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

// Portfolio Manager and above can create/edit pitches.
// Hierarchy: President > CIO > SeniorPortfolioManager > PortfolioManager > SeniorAnalyst > JuniorAnalyst
const ROLE_RANK = {
  President: 6,
  CIO: 5,
  SeniorPortfolioManager: 4,
  PortfolioManager: 3,
  SeniorAnalyst: 2,
  JuniorAnalyst: 1,
};

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
