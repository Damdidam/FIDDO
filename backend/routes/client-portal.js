const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const router = express.Router();

const { db, endUserQueries, merchantClientQueries, merchantQueries } = require('../database');
const { normalizeEmail } = require('../services/normalizer');
const { sendMagicLinkEmail } = require('../services/email');
const { generateClientToken, authenticateClient } = require('../middleware/client-auth');

// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════

const MAGIC_LINK_TTL_MS = 5 * 60 * 1000; // 5 min (reduced from 15 for security)

// Rate limiting: Map<ip, { count, lastAttempt }>
const loginAttempts = new Map();

// Cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of loginAttempts) {
    if (now - data.lastAttempt > 3600000) loginAttempts.delete(key);
  }
}, 5 * 60 * 1000);


// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress || 'unknown';
}


// ═══════════════════════════════════════════════════════
// POST /api/me/login — Send magic link email
// ═══════════════════════════════════════════════════════

router.post('/login', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const emailLower = normalizeEmail(email);
    if (!emailLower) return res.status(400).json({ error: 'Email invalide' });

    // Rate limit: max 5 per IP per hour
    const ip = getClientIP(req);
    const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    if (attempts.count >= 5 && Date.now() - attempts.lastAttempt < 3600000) {
      return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    }
    attempts.count++;
    attempts.lastAttempt = Date.now();
    loginAttempts.set(ip, attempts);

    // Always respond OK to prevent account enumeration
    const endUser = endUserQueries.findByEmailLower.get(emailLower);

    if (endUser && !endUser.is_blocked) {
      // Generate magic token
      const magicToken = crypto.randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();

      endUserQueries.setMagicToken.run(magicToken, expires, endUser.id);

      // Send email
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      const magicUrl = `${baseUrl}/me/verify/${magicToken}`;
      sendMagicLinkEmail(endUser.email, magicUrl);
    }

    // Always return success (no account enumeration)
    res.json({ ok: true, message: 'Si un compte existe, un email de connexion a été envoyé.' });
  } catch (error) {
    console.error('Magic link error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/me/verify — Validate magic link, return JWT
// ═══════════════════════════════════════════════════════

router.post('/verify', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token requis' });

    const endUser = endUserQueries.findByMagicToken.get(token);
    if (!endUser) {
      return res.status(401).json({ error: 'Lien invalide ou expiré' });
    }

    // Check expiry
    if (endUser.magic_token_expires && new Date(endUser.magic_token_expires) < new Date()) {
      endUserQueries.clearMagicToken.run(endUser.id);
      return res.status(401).json({ error: 'Lien expiré. Demandez un nouveau lien.' });
    }

    if (endUser.is_blocked) {
      return res.status(403).json({ error: 'Compte bloqué' });
    }

    // Clear magic token (one-time use)
    endUserQueries.clearMagicToken.run(endUser.id);

    // Generate JWT
    const clientToken = generateClientToken(endUser.id);

    res.json({
      token: clientToken,
      client: {
        name: endUser.name,
        email: endUser.email,
        phone: endUser.phone,
        qrToken: endUser.qr_token,
      },
    });
  } catch (error) {
    console.error('Verify error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/me/cards — List all loyalty cards for this client
// ═══════════════════════════════════════════════════════

router.get('/cards', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (endUser.is_blocked) return res.status(403).json({ error: 'Compte bloqué' });

    // Get all merchant_client relationships
    const cards = db.prepare(`
      SELECT mc.merchant_id, mc.points_balance, mc.total_spent, mc.visit_count,
             mc.last_visit, mc.is_blocked, mc.custom_reward,
             m.business_name, m.points_per_euro, m.points_for_reward, m.reward_description, m.status
      FROM merchant_clients mc
      JOIN merchants m ON mc.merchant_id = m.id
      WHERE mc.end_user_id = ? AND m.status = 'active'
      ORDER BY mc.last_visit DESC
    `).all(endUser.id);

    // Get theme for each merchant
    const getTheme = db.prepare('SELECT theme FROM merchant_preferences WHERE merchant_id = ?');

    const result = cards.map(c => ({
      merchantId: c.merchant_id,
      merchantName: c.business_name,
      theme: getTheme.get(c.merchant_id)?.theme || 'teal',
      pointsBalance: c.points_balance,
      totalSpent: c.total_spent,
      visitCount: c.visit_count,
      lastVisit: c.last_visit,
      pointsPerEuro: c.points_per_euro,
      pointsForReward: c.points_for_reward,
      rewardDescription: c.custom_reward || c.reward_description,
      canRedeem: c.points_balance >= c.points_for_reward,
      progress: Math.min((c.points_balance / c.points_for_reward) * 100, 100),
    }));

    res.json({
      client: {
        name: endUser.name,
        email: endUser.email,
        phone: endUser.phone,
        qrToken: endUser.qr_token,
        hasPin: !!endUser.pin_hash,
      },
      cards: result,
    });
  } catch (error) {
    console.error('Cards error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/me/pin — Set or update client PIN
// ═══════════════════════════════════════════════════════

router.post('/pin', authenticateClient, async (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (endUser.is_blocked) return res.status(403).json({ error: 'Compte bloqué' });

    const { currentPin, newPin } = req.body;

    // Validate new PIN
    if (!newPin || !/^\d{4}$/.test(newPin)) {
      return res.status(400).json({ error: 'Le code PIN doit contenir 4 chiffres' });
    }

    // If user already has a PIN, verify current one
    if (endUser.pin_hash) {
      if (!currentPin) {
        return res.status(400).json({ error: 'Code PIN actuel requis' });
      }
      if (!bcrypt.compareSync(currentPin, endUser.pin_hash)) {
        return res.status(403).json({ error: 'Code PIN actuel incorrect' });
      }
    }

    const pinHash = await bcrypt.hash(newPin, 10);
    endUserQueries.setPin.run(pinHash, endUser.id);

    res.json({ ok: true, message: 'Code PIN mis à jour' });
  } catch (error) {
    console.error('PIN update error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/me/qr — Get client QR token (for display)
// ═══════════════════════════════════════════════════════

router.get('/qr', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (endUser.is_blocked) return res.status(403).json({ error: 'Compte bloqué' });

    // Generate qr_token if missing (legacy users)
    let qrToken = endUser.qr_token;
    if (!qrToken) {
      qrToken = require('crypto').randomBytes(8).toString('base64url');
      endUserQueries.setQrToken.run(qrToken, endUser.id);
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    res.json({
      qrToken,
      qrUrl: `${baseUrl}/c/${qrToken}`,
    });
  } catch (error) {
    console.error('QR error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
