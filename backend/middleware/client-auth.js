const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════
// Shared client JWT config — single source of truth
// ═══════════════════════════════════════════════════════

const DEFAULT_SECRET = 'fiddo-client-secret-change-me';
const CLIENT_JWT_SECRET = process.env.CLIENT_JWT_SECRET || DEFAULT_SECRET;

// Access token: short-lived (used for every API call)
const ACCESS_TOKEN_EXPIRY = '24h';

// Refresh token: long-lived (stored securely on device)
const REFRESH_TOKEN_EXPIRY_DAYS = 90;

// Legacy: keep accepting 30d tokens from web portal during transition
const LEGACY_JWT_EXPIRY = '30d';

// Fail loudly in production if default secret is used
if (process.env.NODE_ENV === 'production' && CLIENT_JWT_SECRET === DEFAULT_SECRET) {
  console.error('⛔ CRITICAL: CLIENT_JWT_SECRET is using the default value in production!');
  console.error('   Set CLIENT_JWT_SECRET in your environment variables.');
  process.exit(1);
}


// ═══════════════════════════════════════════════════════
// ACCESS TOKEN (JWT, 24h)
// ═══════════════════════════════════════════════════════

function generateAccessToken(endUserId, email, phone) {
  return jwt.sign(
    { endUserId, email: email || null, phone: phone || null, type: 'client' },
    CLIENT_JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

// Legacy: generate a long-lived token for web portal (backward compat)
function generateClientToken(endUserId, email, phone) {
  return jwt.sign(
    { endUserId, email: email || null, phone: phone || null, type: 'client' },
    CLIENT_JWT_SECRET,
    { expiresIn: LEGACY_JWT_EXPIRY }
  );
}


// ═══════════════════════════════════════════════════════
// REFRESH TOKEN (opaque, 90 days, stored in DB)
// ═══════════════════════════════════════════════════════

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function getRefreshTokenExpiresAt() {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);
  return d.toISOString();
}


// ═══════════════════════════════════════════════════════
// VERIFY & MIDDLEWARE
// ═══════════════════════════════════════════════════════

function verifyClientToken(token) {
  try {
    const decoded = jwt.verify(token, CLIENT_JWT_SECRET);
    if (decoded.type !== 'client' && decoded.type !== 'client-portal') return null;
    return decoded;
  } catch {
    return null;
  }
}

function authenticateClient(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requis' });
  }

  try {
    const decoded = jwt.verify(authHeader.substring(7), CLIENT_JWT_SECRET);
    if (decoded.type !== 'client-portal' && decoded.type !== 'client') {
      return res.status(401).json({ error: 'Token invalide' });
    }
    req.endUserId = decoded.endUserId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expirée' });
  }
}

module.exports = {
  CLIENT_JWT_SECRET,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY_DAYS,
  generateAccessToken,
  generateClientToken,
  generateRefreshToken,
  getRefreshTokenExpiresAt,
  verifyClientToken,
  authenticateClient,
};
