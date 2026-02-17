const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const router = express.Router();

const { authenticateStaff, requireRole } = require('../middleware/auth');
const { generateClientToken, verifyClientToken } = require('../middleware/client-auth');
const { db, merchantQueries, endUserQueries, merchantClientQueries, aliasQueries } = require('../database');
const { normalizeEmail, normalizePhone } = require('../services/normalizer');
const { logAudit, auditCtx } = require('../middleware/audit');
const { sendWelcomeEmail } = require('../services/email');

// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════

const IDENT_TTL_MS = 15 * 60 * 1000; // 15 min — pending identification lifetime
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 min

// ═══════════════════════════════════════════════════════
// IN-MEMORY: Pending identifications + Rate limiting
// ═══════════════════════════════════════════════════════

// ⚠️ KNOWN LIMITATION: All pending identification data is in-memory.
// Server restart loses all pending QR identifications and rate-limit state.
// Acceptable for paid tier (no cold starts). For free tier, clients may need
// to re-identify after restart. Consider SQLite persistence if this becomes
// an issue with 100+ merchants.

// Map<merchantId, Map<identId, { endUserId, name, email, phone, points, createdAt }>>
const pendingIdents = new Map();

// Rate limiting for PIN attempts: Map<"ip:identifier", { count, lockedUntil }>
const pinAttempts = new Map();

// Cooldown for recent identifications: Map<"merchantId:identifier", { ts, identId, isNew, name, pointsBalance }>
const identCooldowns = new Map();
const IDENT_COOLDOWN_MS = 15 * 60 * 1000; // 15 min

// Server-side PIN hash storage: consumed idents keep their pinHash here (never sent to frontend)
// Map<pinToken, { pinHash, createdAt }>
const consumedPinHashes = new Map();
const PIN_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 min

/** Resolve a pinToken to its pinHash (one-time use) */
function resolvePinToken(token) {
  if (!token) return null;
  const entry = consumedPinHashes.get(token);
  if (!entry) return null;
  consumedPinHashes.delete(token);
  if (Date.now() - entry.createdAt > PIN_TOKEN_TTL_MS) return null;
  return entry.pinHash;
}

// Server-side QR verify tokens: proves client was identified by QR scan (bypass PIN for redeem)
// Map<qrVerifyToken, { createdAt }>
const qrVerifyTokens = new Map();
const QR_VERIFY_TTL_MS = 30 * 60 * 1000; // 30 min

/** Resolve a qrVerifyToken (one-time use) — returns true if valid */
function resolveQrVerifyToken(token) {
  if (!token) return false;
  const entry = qrVerifyTokens.get(token);
  if (!entry) return false;
  qrVerifyTokens.delete(token);
  if (Date.now() - entry.createdAt > QR_VERIFY_TTL_MS) return false;
  return true;
}

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

  // Clean expired identification cooldowns
  for (const [key, data] of identCooldowns) {
    if (now - data.ts > IDENT_COOLDOWN_MS) {
      identCooldowns.delete(key);
    }
  }

  // Clean expired consumed PIN hashes
  for (const [key, data] of consumedPinHashes) {
    if (now - data.createdAt > PIN_TOKEN_TTL_MS) {
      consumedPinHashes.delete(key);
    }
  }

  // Clean expired QR verify tokens
  for (const [key, data] of qrVerifyTokens) {
    if (now - data.createdAt > QR_VERIFY_TTL_MS) {
      qrVerifyTokens.delete(key);
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

    // Get theme + language
    const prefs = db.prepare('SELECT theme, language FROM merchant_preferences WHERE merchant_id = ?').get(merchant.id);

    res.json({
      merchantName: merchant.business_name,
      theme: prefs?.theme || 'teal',
      language: prefs?.language || 'fr',
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

router.post('/client-auth', async (req, res) => {
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
    if (!(await bcrypt.compare(pin, endUser.pin_hash))) {
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
// GET /api/qr/status/:identId — PUBLIC: check if identification still active
// Used by client on page refresh to avoid re-submitting
// ═══════════════════════════════════════════════════════

router.get('/status/:identId', (req, res) => {
  try {
    const { identId } = req.params;
    const { qrToken } = req.query;

    if (!qrToken) return res.status(400).json({ error: 'Token QR requis' });

    const merchant = merchantQueries.findByQrToken.get(qrToken);
    if (!merchant) return res.status(404).json({ active: false });

    // Check pending queue first
    const queue = pendingIdents.get(merchant.id);
    if (queue) {
      const ident = queue.get(identId);
      if (ident && Date.now() - ident.createdAt <= IDENT_TTL_MS) {
        return res.json({
          active: true,
          isNew: ident.isNew,
          clientName: ident.name,
          pointsBalance: ident.pointsBalance,
        });
      }
    }

    // Check cooldown (ident may have been consumed by staff, but client is still "done")
    for (const [key, cd] of identCooldowns) {
      if (cd.identId === identId && Date.now() - cd.ts < IDENT_COOLDOWN_MS) {
        return res.json({
          active: true,
          isNew: cd.isNew,
          clientName: cd.name,
          pointsBalance: cd.pointsBalance,
        });
      }
    }

    res.json({ active: false });
  } catch (error) {
    console.error('Status error:', error);
    res.json({ active: false });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/qr/register — PUBLIC: client identification (new OR existing)
// Single endpoint: adds client to staff's pending queue
// No PIN needed — PIN is only for reward redemption
// ═══════════════════════════════════════════════════════

router.post('/register', (req, res) => {
  try {
    const { qrToken, email, phone, name } = req.body;

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
    // Input length limits
    if (email && email.length > 254) return res.status(400).json({ error: 'Email trop long' });
    if (phone && phone.length > 20) return res.status(400).json({ error: 'Téléphone trop long' });
    if (name && name.length > 100) return res.status(400).json({ error: 'Nom trop long' });

    const emailLower = normalizeEmail(email);
    const phoneE164 = normalizePhone(phone);

    // Simple rate limit: max 20 identifications per IP per hour
    const ip = getClientIP(req);
    const regKey = 'reg:' + ip;
    const regData = pinAttempts.get(regKey) || { count: 0, lastAttempt: 0 };
    if (regData.count >= 20 && Date.now() - regData.lastAttempt < 3600000) {
      return res.status(429).json({ error: 'Trop de requêtes. Réessayez plus tard.' });
    }
    regData.count++;
    regData.lastAttempt = Date.now();
    pinAttempts.set(regKey, regData);

    // Cooldown check: if same person identified recently at this merchant
    const identifier = emailLower || phoneE164;
    const cooldownKey = merchant.id + ':' + identifier;
    const cooldown = identCooldowns.get(cooldownKey);
    if (cooldown && Date.now() - cooldown.ts < IDENT_COOLDOWN_MS) {
      const elapsedMs = Date.now() - cooldown.ts;
      const remainingMs = IDENT_COOLDOWN_MS - elapsedMs;
      const minutesAgo = Math.floor(elapsedMs / 60000);
      const minutesLeft = Math.ceil(remainingMs / 60000);

      // Still push to merchant queue with recent flag so merchant can decide
      if (!pendingIdents.has(merchant.id)) {
        pendingIdents.set(merchant.id, new Map());
      }
      const merchantQueue = pendingIdents.get(merchant.id);
      const recentIdentId = crypto.randomBytes(8).toString('hex');

      // Check if we already have a recent-flagged ident for this person
      let alreadyQueued = false;
      for (const [, ident] of merchantQueue) {
        if (ident.identifier === identifier && ident.recentCredit) {
          alreadyQueued = true;
          break;
        }
      }

      if (!alreadyQueued) {
        const mc = findEndUser(emailLower, phoneE164)
          ? merchantClientQueries.find.get(merchant.id, findEndUser(emailLower, phoneE164).id)
          : null;

        merchantQueue.set(recentIdentId, {
          endUserId: cooldown.endUserId || null,
          name: cooldown.name || name || '',
          email: email || '',
          phone: phone || '',
          pointsBalance: mc?.points_balance ?? cooldown.pointsBalance ?? 0,
          visitCount: mc?.visit_count ?? 0,
          isNew: false,
          identifier,
          recentCredit: true,
          minutesAgo,
          createdAt: Date.now(),
        });
      }

      return res.json({
        ok: true,
        identId: cooldown.identId,
        isNew: cooldown.isNew,
        clientName: cooldown.name,
        pointsBalance: cooldown.pointsBalance,
        cached: true,
        minutesAgo,
        minutesLeft,
      });
    }

    // Check if client already exists
    let existing = findEndUser(emailLower, phoneE164);
    let isNew = !existing;

    // Auto-create end_user if new (zero-friction: account exists from first scan)
    if (!existing && emailLower) {
      const qrToken2 = crypto.randomBytes(8).toString('base64url');
      const result = endUserQueries.create.run(
        email ? email.trim() : null,
        phone || null,
        emailLower,
        phoneE164,
        name || null,
        null // validation_token
      );
      if (result.lastInsertRowid) {
        endUserQueries.setQrToken.run(qrToken2, result.lastInsertRowid);
        // Implicit consent: user provided their own email → validated
        db.prepare("UPDATE end_users SET email_validated = 1, consent_date = datetime('now'), consent_method = 'qr_landing', first_merchant_id = ? WHERE id = ?")
          .run(merchant.id, result.lastInsertRowid);
        existing = endUserQueries.findById.get(result.lastInsertRowid);
      }
    }

    const mc = existing ? merchantClientQueries.find.get(merchant.id, existing.id) : null;

    // Add to pending identifications queue
    const identId = crypto.randomBytes(8).toString('hex');

    if (!pendingIdents.has(merchant.id)) {
      pendingIdents.set(merchant.id, new Map());
    }

    const merchantQueue = pendingIdents.get(merchant.id);

    // Prevent duplicate from same email/phone
    for (const [id, ident] of merchantQueue) {
      const sameEmail = emailLower && ident.emailLower === emailLower;
      const samePhone = phoneE164 && ident.phoneE164 === phoneE164;
      if (sameEmail || samePhone) {
        merchantQueue.delete(id);
      }
    }

    merchantQueue.set(identId, {
      endUserId: existing?.id || null,
      name: name || existing?.name || null,
      email: email || existing?.email || null,
      phone: phone || existing?.phone || null,
      emailLower,
      phoneE164,
      pointsBalance: mc?.points_balance || 0,
      visitCount: mc?.visit_count || 0,
      isNew,
      createdAt: Date.now(),
    });

    // Save cooldown to prevent re-submission spam
    const responseData = {
      ok: true,
      identId,
      isNew,
      clientName: existing?.name || name || null,
      pointsBalance: mc?.points_balance || 0,
    };

    identCooldowns.set(cooldownKey, {
      ts: Date.now(),
      identId,
      isNew,
      name: existing?.name || name || null,
      pointsBalance: mc?.points_balance || 0,
      endUserId: existing?.id || null,
    });

    res.json(responseData);

    // Send welcome email for new users (fire-and-forget, after response)
    if (isNew && emailLower) {
      const appUrl = (process.env.BASE_URL || 'https://www.fiddo.be') + '/app/';
      sendWelcomeEmail(email, merchant.business_name, 0, appUrl);
    }
  } catch (error) {
    console.error('Register error:', error);
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
// GET /api/qr/client-lookup/:token — Staff scans client QR
// Looks up end_user by qr_token, returns client info for credit form
// ═══════════════════════════════════════════════════════

router.get('/client-lookup/:token', authenticateStaff, (req, res) => {
  try {
    const { token } = req.params;
    const merchantId = req.staff.merchant_id;

    const endUser = endUserQueries.findByQrToken.get(token);
    if (!endUser) {
      return res.status(404).json({ error: 'Client non trouvé' });
    }

    // Check merchant_client relationship
    const mc = merchantClientQueries.find.get(merchantId, endUser.id);

    // Generate a server-side verify token (not a boolean the client can forge)
    const qrVerifyToken = crypto.randomBytes(16).toString('hex');
    qrVerifyTokens.set(qrVerifyToken, { createdAt: Date.now() });

    res.json({
      endUserId: endUser.id,
      name: endUser.name,
      email: endUser.email,
      phone: endUser.phone,
      pointsBalance: mc?.points_balance || 0,
      visitCount: mc?.visit_count || 0,
      isNew: !mc,
      qrVerifyToken,  // secure token — frontend passes this back on redeem
    });
  } catch (error) {
    console.error('Client lookup error:', error);
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
        recentCredit: ident.recentCredit || false,
        minutesAgo: ident.minutesAgo || 0,
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

    // Generate server-side verify token (for PIN bypass on redeem)
    const qrVerifyToken = crypto.randomBytes(16).toString('hex');
    qrVerifyTokens.set(qrVerifyToken, { createdAt: Date.now() });

    res.json({
      email: ident.email,
      phone: ident.phone,
      name: ident.name,
      pointsBalance: ident.pointsBalance,
      isNew: ident.isNew,
      qrVerifyToken,
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
module.exports.resolvePinToken = resolvePinToken;
module.exports.resolveQrVerifyToken = resolveQrVerifyToken;
