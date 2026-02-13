const jwt = require('jsonwebtoken');

const DEFAULT_ADMIN_SECRET = 'fiddo-admin-secret-change-me';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || DEFAULT_ADMIN_SECRET;

if (process.env.NODE_ENV === 'production' && ADMIN_JWT_SECRET === DEFAULT_ADMIN_SECRET) {
  console.error('⛔ CRITICAL: ADMIN_JWT_SECRET is using the default value in production!');
  process.exit(1);
}

/**
 * Middleware: authenticate super admin via HTTP-only cookie.
 * Sets req.admin = { id, email }
 */
function authenticateAdmin(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) {
    return res.status(401).json({ error: 'Token admin manquant' });
  }

  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    req.admin = decoded; // { id, email }
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token admin invalide' });
  }
}

/**
 * Generate a JWT for a super admin (24h session).
 */
function generateAdminToken(admin) {
  return jwt.sign(
    { id: admin.id, email: admin.email },
    ADMIN_JWT_SECRET,
    { expiresIn: '24h' }
  );
}

/**
 * Cookie options for admin token.
 */
const adminCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 24 * 60 * 60 * 1000, // 24h
};

module.exports = {
  ADMIN_JWT_SECRET,
  authenticateAdmin,
  generateAdminToken,
  adminCookieOptions,
};
