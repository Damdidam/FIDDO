const jwt = require('jsonwebtoken');
const { merchantQueries, staffQueries } = require('../database');

const DEFAULT_JWT_SECRET = 'fiddo-secret-change-me';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;

if (process.env.NODE_ENV === 'production' && JWT_SECRET === DEFAULT_JWT_SECRET) {
  console.error('⛔ CRITICAL: JWT_SECRET is using the default value in production!');
  process.exit(1);
}

// Brute force config
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

/**
 * Middleware: authenticate staff via HTTP-only cookie.
 * Verifies the JWT, re-checks staff is_active and merchant status from DB.
 * Uses live DB role (not stale JWT) to prevent privilege escalation after demotion.
 * Sets req.staff = { id, email, merchant_id, role }
 */
function authenticateStaff(req, res, next) {
  const token = req.cookies.staff_token;
  if (!token) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Re-check staff from DB (catches deactivation + role changes after JWT issued)
    const staff = staffQueries.findById.get(decoded.id);
    if (!staff || !staff.is_active) {
      return res.status(403).json({ error: 'Compte désactivé' });
    }

    // Verify merchant is still active
    const merchant = merchantQueries.findById.get(staff.merchant_id);
    if (!merchant || merchant.status !== 'active') {
      return res.status(403).json({ error: 'Commerce non actif' });
    }

    // Use live DB values (not stale JWT) for id, role, merchant_id
    req.staff = {
      id: staff.id,
      email: staff.email,
      merchant_id: staff.merchant_id,
      role: staff.role,
    };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token invalide' });
  }
}

/**
 * Middleware factory: require one of the specified roles.
 * Must be used AFTER authenticateStaff.
 *
 * Usage: router.get('/admin-only', authenticateStaff, requireRole('owner'), handler)
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.staff) {
      return res.status(401).json({ error: 'Non authentifié' });
    }
    if (!allowedRoles.includes(req.staff.role)) {
      return res.status(403).json({ error: 'Permissions insuffisantes' });
    }
    next();
  };
}

/**
 * Generate a JWT for a staff member.
 * Cashier: 8h session. Owner/Manager: 7 days.
 */
function generateStaffToken(staff) {
  return jwt.sign(
    {
      id: staff.id,
      email: staff.email,
      merchant_id: staff.merchant_id,
      role: staff.role,
    },
    JWT_SECRET,
    { expiresIn: staff.role === 'cashier' ? '8h' : '7d' }
  );
}

/**
 * Cookie options for staff token.
 */
function staffCookieOptions(role) {
  const maxAge = role === 'cashier'
    ? 8 * 60 * 60 * 1000       // 8h
    : 7 * 24 * 60 * 60 * 1000; // 7d

  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge,
  };
}

/**
 * Check if an account is locked due to too many failed attempts.
 * @param {Object} staff - staff account row from DB
 * @returns {{ locked: boolean, minutesRemaining: number }}
 */
function checkAccountLock(staff) {
  if (!staff.locked_until) {
    return { locked: false, minutesRemaining: 0 };
  }

  const lockExpires = new Date(staff.locked_until + 'Z');
  const now = new Date();

  if (now < lockExpires) {
    const minutesRemaining = Math.ceil((lockExpires - now) / (1000 * 60));
    return { locked: true, minutesRemaining };
  }

  // Lock expired
  return { locked: false, minutesRemaining: 0 };
}

/**
 * Compute the lockout timestamp after too many failed attempts.
 * @returns {string} ISO datetime string (UTC)
 */
function computeLockUntil() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + LOCKOUT_MINUTES);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

module.exports = {
  JWT_SECRET,
  authenticateStaff,
  requireRole,
  generateStaffToken,
  staffCookieOptions,
  checkAccountLock,
  computeLockUntil,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MINUTES,
};
