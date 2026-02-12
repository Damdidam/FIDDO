const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const router = express.Router();

const { authenticateStaff, requireRole } = require('../middleware/auth');
const { db, merchantQueries, endUserQueries, merchantClientQueries, aliasQueries } = require('../database');
const { normalizeEmail, normalizePhone } = require('../services/normalizer');
const { logAudit, auditCtx } = require('../middleware/audit');

// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════

const CLIENT_JWT_SECRET = process.env.CLIENT_JWT_SECRET || 'fiddo-client-secret-change-me';
const CLIENT_JWT_EXPIRY = '30d';
const IDENT_TTL_MS = 15 * 60 * 1000; // 15 min — pending identification lifetime
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 min

// ═══════════════════════════════════════════════════════
// IN-MEMORY: Pending identifications + Rate limiting
// ═══════════════════════════════════════════════════════

// Map<merchantId, Map<identId, { endUserId, name, email, phone, points, createdAt }>>
const pendingIdents = new Map();

// Rate limiting for PIN attempts: Map<"ip:identifier", { count, lockedUntil }>
const pinAttempts = new Map();

// Cleanup every 2 minutes
setInterval(() => {
  const now = Date.now();

  // Clean expired identifications
  for (const [merchantId, idents] of pendingIdents) {
    for (const [identId, ident] of idents) {
      if (now - ident.createdAt > IDENT_TTL_MS) {
        idents.delete(identId);
      }
    }
    if (idents.size === 0) pendingIdents.delete(merchantId);
  }

  // Clean expired rate limits
  for (const [key, data] of pinAttempts) {
    if (data.lockedUntil && now > data.lockedUntil) {
      pinAttempts.delete(key);
    } else if (!data.lockedUntil && now - data.lastAttempt > PIN_LOCKOUT_MS) {
      pinAttempts.delete(key);
    }
  }
}, 2 * 60 * 1000);


// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress || 'unknown';
}

function checkPinRateLimit(req, identifier) {
  const key = getClientIP(req) + ':' + identifier;
  const data = pinAttempts.get(key);

  if (!data) return { blocked: false };

  if (data.lockedUntil) {
    const remaining = Math.ceil((data.lockedUntil - Date.now()) / 60000);
    if (Date.now() < data.lockedUntil) {
      return { blocked: true, minutesRemaining: remaining };
    }
    // Lock expired
    pinAttempts.delete(key);
    return { blocked: false };
  }

  return { blocked: false };
}

function recordPinFailure(req, identifier) {
  const key = getClientIP(req) + ':' + identifier;
  const data = pinAttempts.get(key) || { count: 0 };
  data.count++;
  data.lastAttempt = Date.now();

  if (data.count >= MAX_PIN_ATTEMPTS) {
    data.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
  }

  pinAttempts.set(key, data);
  return data.count;
}

function clearPinFailures(req, identifier) {
  const key = getClientIP(req) + ':' + identifier;
  pinAttempts.delete(key);
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
    if (decoded.type !== 'client') return null;
    return decoded;
  } catch {
    return null;
  }
}

/** 3-step end_user lookup (same as points.js, read-only) */
function findEndUser(emailLower, phoneE164) {
  let endUser = null;

  if (emailLower) {
    endUser = endUserQueries.findByEmailLower.get(emailLower);
  }
  if (!endUser && phoneE164) {
    endUser = endUserQueries.findByPhoneE164.get(phoneE164);
  }
  if (!endUser && emailLower) {
    const alias = aliasQueries.findByValue.get(emailLower);
    if (alias) endUser = endUserQueries.findById.get(alias.end_user_id);
  }
  if (!endUser && phoneE164) {
    const alias = aliasQueries.findByValue.get(phoneE164);
    if (alias) endUser = endUserQueries.findById.get(alias.end_user_id);
  }

  return endUser;
}


// ═══════════════════════════════════════════════════════
// POST /api/qr/generate — Generate/regenerate static QR token (owner)
// ═══════════════════════════════════════════════════════

router.post('/generate', authenticateStaff, requireRole('owner'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const merchant = merchantQueries.findById.get(merchantId);

    // If token already exists, return it (never regenerate)
    if (merchant.qr_token) {
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      return res.json({
        token: merchant.qr_token,
        url: `${baseUrl}/q/${merchant.qr_token}`,
        existing: true,
      });
    }

    // First time only: generate token
    const token = crypto.randomBytes(6).toString('base64url'); // ~8 chars, URL-safe
    merchantQueries.setQrToken.run(token, merchantId);

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId,
      action: 'qr_token_generated',
      targetType: 'merchant',
      targetId: merchantId,
    });

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({
      token,
      url: `${baseUrl}/q/${token}`,
      existing: false,
    });
  } catch (error) {
    console.error('QR generate error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/qr/token — Get current merchant QR token (staff)
// ═══════════════════════════════════════════════════════

router.get('/token', authenticateStaff, (req, res) => {
  try {
    const merchant = merchantQueries.findById.get(req.staff.merchant_id);
    if (!merchant) return res.status(404).json({ error: 'Commerce non trouvé' });

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    // Auto-generate on first access (permanent, never changes)
    let token = merchant.qr_token;
    if (!token) {
      token = crypto.randomBytes(6).toString('base64url');
      merchantQueries.setQrToken.run(token, merchant.id);
    }

    res.json({
      token,
      url: `${baseUrl}/q/${token}`,
    });
  } catch (error) {
    console.error('QR token fetch error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/qr/info/:token — PUBLIC: merchant info for client portal
// ═══════════════════════════════════════════════════════

router.get('/info/:token', (req, res) => {
  try {
    const merchant = merchantQueries.findByQrToken.get(req.params.token);
    if (!merchant || merchant.status !== 'active') {
      return res.status(404).json({ error: 'Commerce non trouvé' });
    }

    // Get theme
    const prefs = db.prepare('SELECT theme FROM merchant_preferences WHERE merchant_id = ?').get(merchant.id);

    res.json({
      merchantName: merchant.business_name,
      theme: prefs?.theme || 'teal',
      pointsPerEuro: merchant.points_per_euro,
      pointsForReward: merchant.points_for_reward,
      rewardDescription: merchant.reward_description,
    });
  } catch (error) {
    console.error('QR info error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/qr/client-auth — PUBLIC: client login (email/phone + PIN)
// Returns JWT + client data for the given merchant
// ═══════════════════════════════════════════════════════

router.post('/client-auth', (req, res) => {
  try {
    const { qrToken, email, phone, pin } = req.body;

    // Validate merchant
    if (!qrToken) return res.status(400).json({ error: 'Token QR requis' });
    const merchant = merchantQueries.findByQrToken.get(qrToken);
    if (!merchant || merchant.status !== 'active') {
      return res.status(404).json({ error: 'Commerce non trouvé' });
    }

    // Validate input
    if (!email && !phone) {
      return res.status(400).json({ error: 'Email ou téléphone requis' });
    }
    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'Code PIN requis (4 chiffres)' });
    }

    const emailLower = normalizeEmail(email);
    const phoneE164 = normalizePhone(phone);
    const identifier = emailLower || phoneE164;

    // Rate limiting
    const { blocked, minutesRemaining } = checkPinRateLimit(req, identifier);
    if (blocked) {
      return res.status(429).json({
        error: `Trop de tentatives. Réessayez dans ${minutesRemaining} minute(s).`,
      });
    }

    // Find end_user (3-step lookup)
    const endUser = findEndUser(emailLower, phoneE164);

    // SECURITY: don't reveal if account exists or not
    if (!endUser || !endUser.pin_hash) {
      recordPinFailure(req, identifier);
      return res.status(401).json({ error: 'Identifiant ou code PIN incorrect' });
    }

    if (endUser.is_blocked) {
      return res.status(403).json({ error: 'Compte bloqué' });
    }

    // Verify PIN
    if (!bcrypt.compareSync(pin, endUser.pin_hash)) {
      const attempts = recordPinFailure(req, identifier);
      const remaining = MAX_PIN_ATTEMPTS - attempts;
      if (remaining <= 0) {
        return res.status(429).json({
          error: `Trop de tentatives. Réessayez dans 15 minutes.`,
        });
      }
      return res.status(401).json({ error: 'Identifiant ou code PIN incorrect' });
    }

    // PIN OK — clear failures
    clearPinFailures(req, identifier);

    // Find merchant_client relationship (may not exist yet)
    const mc = merchantClientQueries.find.get(merchant.id, endUser.id);

    // Generate client JWT
    const clientToken = generateClientToken(endUser.id, endUser.email_lower, endUser.phone_e164);

    const response = {
      token: clientToken,
      client: {
        name: endUser.name,
        email: endUser.email,
        phone: endUser.phone,
      },
      merchant: {
        id: merchant.id,
        name: merchant.business_name,
        pointsForReward: merchant.points_for_reward,
        rewardDescription: merchant.reward_description,
      },
    };

    if (mc) {
      response.points = {
        balance: mc.points_balance,
        totalSpent: mc.total_spent,
        visitCount: mc.visit_count,
        canRedeem: mc.points_balance >= merchant.points_for_reward,
        customReward: mc.custom_reward || null,
      };
    } else {
      response.points = null; // first visit at this merchant
    }

    res.json(response);
  } catch (error) {
    console.error('Client auth error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/qr/identify — Client says "I'm here" (client JWT)
// Pushes an identification to the merchant's pending queue
// ═══════════════════════════════════════════════════════

router.post('/identify', (req, res) => {
  try {
    const { clientToken, qrToken } = req.body;

    // Verify client JWT
    const client = verifyClientToken(clientToken);
    if (!client) return res.status(401).json({ error: 'Session expirée' });

    // Verify merchant
    const merchant = merchantQueries.findByQrToken.get(qrToken);
    if (!merchant || merchant.status !== 'active') {
      return res.status(404).json({ error: 'Commerce non trouvé' });
    }

    // Get end_user info
    const endUser = endUserQueries.findById.get(client.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (endUser.is_blocked) return res.status(403).json({ error: 'Compte bloqué' });

    // Get merchant_client for points info
    const mc = merchantClientQueries.find.get(merchant.id, endUser.id);

    // Create identification entry
    const identId = crypto.randomBytes(8).toString('hex');

    if (!pendingIdents.has(merchant.id)) {
      pendingIdents.set(merchant.id, new Map());
    }

    const merchantQueue = pendingIdents.get(merchant.id);

    // Prevent duplicate: remove any existing ident from same end_user
    for (const [id, ident] of merchantQueue) {
      if (ident.endUserId === endUser.id) {
        merchantQueue.delete(id);
      }
    }

    merchantQueue.set(identId, {
      endUserId: endUser.id,
      name: endUser.name,
      email: endUser.email,
      phone: endUser.phone,
      pointsBalance: mc?.points_balance || 0,
      visitCount: mc?.visit_count || 0,
      isNew: !mc,
      createdAt: Date.now(),
    });

    res.json({ ok: true, identId });
  } catch (error) {
    console.error('Identify error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/qr/pending — Staff: get pending identifications
// ═══════════════════════════════════════════════════════

router.get('/pending', authenticateStaff, (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const queue = pendingIdents.get(merchantId);

    if (!queue || queue.size === 0) {
      return res.json({ clients: [] });
    }

    const now = Date.now();
    const clients = [];

    for (const [identId, ident] of queue) {
      // Skip expired
      if (now - ident.createdAt > IDENT_TTL_MS) continue;

      clients.push({
        identId,
        endUserId: ident.endUserId,
        name: ident.name,
        email: ident.email,
        phone: ident.phone,
        pointsBalance: ident.pointsBalance,
        visitCount: ident.visitCount,
        isNew: ident.isNew,
        secondsAgo: Math.floor((now - ident.createdAt) / 1000),
      });
    }

    // Most recent first
    clients.sort((a, b) => a.secondsAgo - b.secondsAgo);

    res.json({ clients });
  } catch (error) {
    console.error('Pending error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/qr/dismiss/:identId — Staff: dismiss an identification
// ═══════════════════════════════════════════════════════

router.post('/dismiss/:identId', authenticateStaff, (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const queue = pendingIdents.get(merchantId);

    if (queue) {
      queue.delete(req.params.identId);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Dismiss error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/qr/consume/:identId — Staff: select client for credit
// Returns client data to pre-fill credit form, then removes from queue
// ═══════════════════════════════════════════════════════

router.post('/consume/:identId', authenticateStaff, (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const queue = pendingIdents.get(merchantId);

    if (!queue) return res.status(404).json({ error: 'Aucune identification' });

    const ident = queue.get(req.params.identId);
    if (!ident) return res.status(404).json({ error: 'Identification non trouvée' });

    // Remove from queue
    queue.delete(req.params.identId);

    res.json({
      email: ident.email,
      phone: ident.phone,
      name: ident.name,
      pointsBalance: ident.pointsBalance,
      isNew: ident.isNew,
    });
  } catch (error) {
    console.error('Consume error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/qr/client-data — Client: get their data for a merchant (client JWT)
// Used by portal to refresh balance after identification
// ═══════════════════════════════════════════════════════

router.get('/client-data', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token requis' });
    }

    const client = verifyClientToken(authHeader.substring(7));
    if (!client) return res.status(401).json({ error: 'Session expirée' });

    const { qrToken } = req.query;
    if (!qrToken) return res.status(400).json({ error: 'Token QR requis' });

    const merchant = merchantQueries.findByQrToken.get(qrToken);
    if (!merchant) return res.status(404).json({ error: 'Commerce non trouvé' });

    const endUser = endUserQueries.findById.get(client.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const mc = merchantClientQueries.find.get(merchant.id, endUser.id);

    res.json({
      client: {
        name: endUser.name,
        email: endUser.email,
        phone: endUser.phone,
      },
      points: mc ? {
        balance: mc.points_balance,
        totalSpent: mc.total_spent,
        visitCount: mc.visit_count,
        canRedeem: mc.points_balance >= merchant.points_for_reward,
      } : null,
      merchant: {
        name: merchant.business_name,
        pointsForReward: merchant.points_for_reward,
        rewardDescription: merchant.reward_description,
      },
    });
  } catch (error) {
    console.error('Client data error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
