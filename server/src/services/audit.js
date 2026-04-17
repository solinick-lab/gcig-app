import prisma from '../db.js';

/**
 * Record a security- or management-relevant action.
 * Best-effort: logs failure but never throws to the caller.
 */
export async function audit(
  { userId, userName, action, resource, resourceId, metadata, ip },
  log = true
) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: userId ?? null,
        userName: userName ?? null,
        action,
        resource: resource ?? null,
        resourceId: resourceId ?? null,
        metadata: metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null,
        ip: ip ?? null,
      },
    });
    if (log) {
      console.log(`[audit] ${userName || 'anon'} ${action}${resource ? ` ${resource}` : ''}${resourceId ? ` #${resourceId}` : ''}`);
    }
  } catch (err) {
    console.error('audit log failed:', err.message);
  }
}

// Convenience wrapper for Express — extracts user and IP from the request.
// Defensive on every field because callers sometimes pass synthetic req-like
// objects (e.g. spread copies that lose getters) during signup/invite flows.
export async function auditReq(req, action, resource, resourceId, metadata) {
  const headers = req?.headers ?? {};
  const ip =
    headers['x-forwarded-for']?.split(',')[0].trim() ||
    req?.ip ||
    req?.socket?.remoteAddress ||
    null;
  await audit({
    userId: req?.user?.id ?? null,
    userName: req?.user?.name ?? req?.user?.email ?? null,
    action,
    resource,
    resourceId,
    metadata,
    ip,
  });
}
