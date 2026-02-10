const crypto = require('crypto');
const { auditQueries } = require('../database');

/**
 * Log an action to the immutable audit trail.
 * Never throws — audit failures must not block business operations.
 */
function logAudit({
  actorType,
  actorId = null,
  merchantId = null,
  action,
  targetType = null,
  targetId = null,
  details = null,
  ipAddress = null,
  requestId = null,
  userAgent = null,
}) {
  try {
    auditQueries.create.run(
      actorType,
      actorId,
      merchantId,
      action,
      targetType,
      targetId,
      details ? JSON.stringify(details) : null,
      ipAddress,
      requestId,
      userAgent
    );
  } catch (error) {
    // Log to console but never throw — audit must not break operations
    console.error('❌ Audit log failed:', error.message);
  }
}

/**
 * Extract client IP from request (supports proxies).
 */
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

/**
 * Extract user agent from request.
 */
function getUserAgent(req) {
  return req.headers['user-agent'] || null;
}

/**
 * Generate a unique request ID for correlating logs.
 */
function generateRequestId() {
  return crypto.randomUUID();
}

/**
 * Express middleware: attach requestId to every request.
 * All audit logs within the same request share this ID.
 */
function requestIdMiddleware(req, res, next) {
  req.requestId = req.headers['x-request-id'] || generateRequestId();
  res.setHeader('x-request-id', req.requestId);
  next();
}

/**
 * Convenience: build audit context from a request object.
 * Use in routes to avoid repeating boilerplate.
 *
 * Usage:
 *   logAudit({ ...auditCtx(req), action: 'did_something', ... });
 */
function auditCtx(req) {
  return {
    ipAddress: getClientIP(req),
    requestId: req.requestId || null,
    userAgent: getUserAgent(req),
  };
}

module.exports = {
  logAudit,
  getClientIP,
  getUserAgent,
  generateRequestId,
  requestIdMiddleware,
  auditCtx,
};
