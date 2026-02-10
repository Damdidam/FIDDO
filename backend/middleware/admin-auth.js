const jwt = require('jsonwebtoken');

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'fiddo-admin-secret-change-me';

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
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 24 * 60 * 60 * 1000, // 24h
};

module.exports = {
  ADMIN_JWT_SECRET,
  authenticateAdmin,
  generateAdminToken,
  adminCookieOptions,
};
