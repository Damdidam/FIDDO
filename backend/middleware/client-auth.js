const jwt = require('jsonwebtoken');

// ═══════════════════════════════════════════════════════
// Shared client JWT config — single source of truth
// ═══════════════════════════════════════════════════════

const DEFAULT_SECRET = 'fiddo-client-secret-change-me';
const CLIENT_JWT_SECRET = process.env.CLIENT_JWT_SECRET || DEFAULT_SECRET;
const CLIENT_JWT_EXPIRY = '90d';

// Fail loudly in production if default secret is used
if (process.env.NODE_ENV === 'production' && CLIENT_JWT_SECRET === DEFAULT_SECRET) {
  console.error('⛔ CRITICAL: CLIENT_JWT_SECRET is using the default value in production!');
  console.error('   Set CLIENT_JWT_SECRET in your environment variables.');
  process.exit(1);
}

function generateClientToken(endUserId, email, phone) {
  return jwt.sign(
    { endUserId, email: email || null, phone: phone || null, type: 'client' },
    CLIENT_JWT_SECRET,
    { expiresIn: CLIENT_JWT_EXPIRY }
  );
}

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
  CLIENT_JWT_EXPIRY,
  generateClientToken,
  verifyClientToken,
  authenticateClient,
};
