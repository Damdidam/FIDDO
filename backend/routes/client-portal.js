const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const router = express.Router();

const { db, endUserQueries, merchantClientQueries, merchantQueries, pushTokenQueries, refreshTokenQueries } = require('../database');
const { normalizeEmail, normalizePhone } = require('../services/normalizer');
const { sendMagicLinkEmail } = require('../services/email');
const {
  generateAccessToken,
  generateClientToken,
  generateRefreshToken,
  getRefreshTokenExpiresAt,
  authenticateClient,
} = require('../middleware/client-auth');


// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════

const MAGIC_LINK_TTL_MS = 5 * 60 * 1000; // 5 min

// Rate limiting: Map<ip, { count, lastAttempt }>
const loginAttempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of loginAttempts) {
    if (now - data.lastAttempt > 3600000) loginAttempts.delete(key);
  }
}, 5 * 60 * 1000);

// Cleanup expired refresh tokens every hour
setInterval(() => {
  try { refreshTokenQueries.deleteExpired.run(); } catch (_) {}
}, 60 * 60 * 1000);


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
      const magicToken = crypto.randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();

      endUserQueries.setMagicToken.run(magicToken, expires, endUser.id);

      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      const magicUrl = `${baseUrl}/me/verify/${magicToken}`;
      sendMagicLinkEmail(endUser.email, magicUrl);
    }

    res.json({ ok: true, message: 'Si un compte existe, un email de connexion a été envoyé.' });
  } catch (error) {
    console.error('Magic link error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/me/verify — Validate magic link, return tokens
// Returns both accessToken (24h) and refreshToken (90d)
// ═══════════════════════════════════════════════════════

router.post('/verify', (req, res) => {
  try {
    const { token, deviceName } = req.body;
    if (!token) return res.status(400).json({ error: 'Token requis' });

    const endUser = endUserQueries.findByMagicToken.get(token);
    if (!endUser) {
      return res.status(401).json({ error: 'Lien invalide ou expiré' });
    }

    if (endUser.magic_token_expires && new Date(endUser.magic_token_expires) < new Date()) {
      endUserQueries.clearMagicToken.run(endUser.id);
      return res.status(401).json({ error: 'Lien expiré. Demandez un nouveau lien.' });
    }

    if (endUser.is_blocked) {
      return res.status(403).json({ error: 'Compte bloqué' });
    }

    // Clear magic token (one-time use)
    endUserQueries.clearMagicToken.run(endUser.id);

    // Generate access token (JWT, short-lived)
    const accessToken = generateAccessToken(endUser.id, endUser.email, endUser.phone);

    // Generate refresh token (opaque, long-lived, stored in DB)
    const refreshToken = generateRefreshToken();
    refreshTokenQueries.create.run(
      endUser.id,
      refreshToken,
      deviceName || null,
      getRefreshTokenExpiresAt()
    );

    // Also generate legacy token for backward compat with web portal
    const clientToken = generateClientToken(endUser.id, endUser.email, endUser.phone);

    res.json({
      // New mobile tokens
      accessToken,
      refreshToken,
      // Legacy web portal token (backward compat)
      token: clientToken,
      client: {
        name: endUser.name,
        email: endUser.email,
        phone: endUser.phone,
        qrToken: endUser.qr_token,
        dateOfBirth: endUser.date_of_birth || null,
        profileCompleted: !!endUser.profile_completed,
      },
    });
  } catch (error) {
    console.error('Verify error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/me/refresh — Exchange refresh token for new access token
// ═══════════════════════════════════════════════════════

router.post('/refresh', (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token requis' });

    const stored = refreshTokenQueries.findByToken.get(refreshToken);
    if (!stored) {
      return res.status(401).json({ error: 'Session expirée, reconnectez-vous' });
    }

    // Check expiry
    if (new Date(stored.expires_at) < new Date()) {
      refreshTokenQueries.delete.run(stored.id);
      return res.status(401).json({ error: 'Session expirée, reconnectez-vous' });
    }

    const endUser = endUserQueries.findById.get(stored.end_user_id);
    if (!endUser || endUser.is_blocked) {
      refreshTokenQueries.delete.run(stored.id);
      return res.status(403).json({ error: 'Compte bloqué ou supprimé' });
    }

    // Update last_used
    refreshTokenQueries.updateLastUsed.run(stored.id);

    // Issue new access token
    const accessToken = generateAccessToken(endUser.id, endUser.email, endUser.phone);

    res.json({
      accessToken,
      client: {
        name: endUser.name,
        email: endUser.email,
        phone: endUser.phone,
        qrToken: endUser.qr_token,
        dateOfBirth: endUser.date_of_birth || null,
        profileCompleted: !!endUser.profile_completed,
      },
    });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/me/logout — Invalidate refresh token + push token
// ═══════════════════════════════════════════════════════

router.post('/logout', authenticateClient, (req, res) => {
  try {
    const { refreshToken, pushToken } = req.body;

    if (refreshToken) {
      refreshTokenQueries.deleteByToken.run(refreshToken);
    }
    if (pushToken) {
      pushTokenQueries.deleteByToken.run(pushToken);
    }

    res.json({ ok: true, message: 'Déconnecté' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// PUT /api/me/profile — Update client profile (name, phone, DOB)
// ═══════════════════════════════════════════════════════

router.put('/profile', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (endUser.is_blocked) return res.status(403).json({ error: 'Compte bloqué' });

    const { name, phone, dateOfBirth } = req.body;

    // Validate name
    const newName = name ? name.trim().substring(0, 100) : endUser.name;

    // Validate phone
    let newPhone = endUser.phone;
    let newPhoneE164 = endUser.phone_e164;
    if (phone !== undefined) {
      if (phone) {
        newPhoneE164 = normalizePhone(phone);
        if (!newPhoneE164) return res.status(400).json({ error: 'Numéro de téléphone invalide' });
        // Check uniqueness
        if (newPhoneE164 !== endUser.phone_e164) {
          const existing = endUserQueries.findByPhoneE164.get(newPhoneE164);
          if (existing && existing.id !== endUser.id) {
            return res.status(400).json({ error: 'Ce numéro est déjà utilisé' });
          }
        }
        newPhone = phone.trim();
      } else {
        newPhone = null;
        newPhoneE164 = null;
      }
    }

    // Validate date of birth
    let newDob = endUser.date_of_birth;
    if (dateOfBirth !== undefined) {
      if (dateOfBirth) {
        // Validate format YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
          return res.status(400).json({ error: 'Format date invalide (AAAA-MM-JJ)' });
        }
        const dob = new Date(dateOfBirth);
        if (isNaN(dob.getTime())) return res.status(400).json({ error: 'Date invalide' });

        // Age validation: >13 years, <120 years
        const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        if (age < 13) return res.status(400).json({ error: 'Vous devez avoir au moins 13 ans' });
        if (age > 120) return res.status(400).json({ error: 'Date de naissance invalide' });

        newDob = dateOfBirth;
      } else {
        newDob = null;
      }
    }

    // Ensure at least email OR phone
    if (!endUser.email_lower && !newPhoneE164) {
      return res.status(400).json({ error: 'Au moins un email ou téléphone requis' });
    }

    endUserQueries.updateProfile.run(newName, newPhone, newPhoneE164, newDob, endUser.id);

    const updated = endUserQueries.findById.get(endUser.id);
    res.json({
      ok: true,
      message: 'Profil mis à jour',
      client: {
        name: updated.name,
        email: updated.email,
        phone: updated.phone,
        dateOfBirth: updated.date_of_birth,
        profileCompleted: !!updated.profile_completed,
      },
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/me/cards — List all loyalty cards
// ═══════════════════════════════════════════════════════

router.get('/cards', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (endUser.is_blocked) return res.status(403).json({ error: 'Compte bloqué' });

    const cards = db.prepare(`
      SELECT mc.merchant_id, mc.points_balance, mc.total_spent, mc.visit_count,
             mc.last_visit, mc.is_blocked, mc.custom_reward,
             m.business_name, m.points_per_euro, m.points_for_reward, m.reward_description,
             m.status, m.address, m.phone, m.email
      FROM merchant_clients mc
      JOIN merchants m ON mc.merchant_id = m.id
      WHERE mc.end_user_id = ? AND m.status = 'active'
      ORDER BY mc.last_visit DESC
    `).all(endUser.id);

    const getTheme = db.prepare('SELECT theme, logo_url FROM merchant_preferences WHERE merchant_id = ?');

    const result = cards.map(c => {
      const prefs = getTheme.get(c.merchant_id);
      return {
        merchantId: c.merchant_id,
        merchantName: c.business_name,
        theme: prefs?.theme || 'teal',
        logoUrl: prefs?.logo_url || null,
        pointsBalance: c.points_balance,
        totalSpent: c.total_spent,
        visitCount: c.visit_count,
        lastVisit: c.last_visit,
        pointsPerEuro: c.points_per_euro,
        pointsForReward: c.points_for_reward,
        rewardDescription: c.custom_reward || c.reward_description,
        canRedeem: c.points_balance >= c.points_for_reward,
        progress: Math.min((c.points_balance / c.points_for_reward) * 100, 100),
      };
    });

    res.json({
      client: {
        name: endUser.name,
        email: endUser.email,
        phone: endUser.phone,
        qrToken: endUser.qr_token,
        hasPin: !!endUser.pin_hash,
        dateOfBirth: endUser.date_of_birth || null,
        profileCompleted: !!endUser.profile_completed,
      },
      cards: result,
    });
  } catch (error) {
    console.error('Cards error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/me/cards/:merchantId — Card detail + merchant business card
// ═══════════════════════════════════════════════════════

router.get('/cards/:merchantId', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (endUser.is_blocked) return res.status(403).json({ error: 'Compte bloqué' });

    const merchantId = parseInt(req.params.merchantId);
    const merchant = merchantQueries.findById.get(merchantId);
    if (!merchant || merchant.status !== 'active') {
      return res.status(404).json({ error: 'Commerce non trouvé' });
    }

    const mc = merchantClientQueries.find.get(merchantId, endUser.id);
    if (!mc) return res.status(404).json({ error: 'Carte non trouvée' });

    const prefs = db.prepare('SELECT theme, logo_url FROM merchant_preferences WHERE merchant_id = ?').get(merchantId);

    // Parse opening_hours JSON safely
    let openingHours = null;
    if (merchant.opening_hours) {
      try { openingHours = JSON.parse(merchant.opening_hours); } catch (_) {}
    }

    res.json({
      card: {
        pointsBalance: mc.points_balance,
        totalSpent: mc.total_spent,
        visitCount: mc.visit_count,
        lastVisit: mc.last_visit,
        firstVisit: mc.first_visit,
        pointsPerEuro: merchant.points_per_euro,
        pointsForReward: merchant.points_for_reward,
        rewardDescription: mc.custom_reward || merchant.reward_description,
        canRedeem: mc.points_balance >= merchant.points_for_reward,
        progress: Math.min((mc.points_balance / merchant.points_for_reward) * 100, 100),
        pointsUntilReward: Math.max(merchant.points_for_reward - mc.points_balance, 0),
      },
      merchant: {
        id: merchant.id,
        name: merchant.business_name,
        address: merchant.address,
        phone: merchant.phone,
        email: merchant.email,
        websiteUrl: merchant.website_url || null,
        description: merchant.description || null,
        openingHours,
        latitude: merchant.latitude || null,
        longitude: merchant.longitude || null,
        logoUrl: merchant.logo_url || prefs?.logo_url || null,
        instagramUrl: merchant.instagram_url || null,
        facebookUrl: merchant.facebook_url || null,
        theme: prefs?.theme || 'teal',
      },
    });
  } catch (error) {
    console.error('Card detail error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/me/cards/:merchantId/transactions — Transaction history
// ═══════════════════════════════════════════════════════

router.get('/cards/:merchantId/transactions', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const merchantId = parseInt(req.params.merchantId);
    const mc = merchantClientQueries.find.get(merchantId, endUser.id);
    if (!mc) return res.status(404).json({ error: 'Carte non trouvée' });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const transactions = db.prepare(`
      SELECT t.id, t.amount, t.points_delta, t.transaction_type, t.notes, t.created_at,
             sa.display_name as staff_name
      FROM transactions t
      LEFT JOIN staff_accounts sa ON t.staff_id = sa.id
      WHERE t.merchant_client_id = ?
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(mc.id, limit, offset);

    const total = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE merchant_client_id = ?').get(mc.id).c;

    res.json({
      transactions: transactions.map(t => ({
        id: t.id,
        amount: t.amount,
        pointsDelta: t.points_delta,
        type: t.transaction_type,
        notes: t.notes,
        staffName: t.staff_name || null,
        createdAt: t.created_at,
      })),
      total,
      hasMore: offset + transactions.length < total,
    });
  } catch (error) {
    console.error('Transactions error:', error);
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

    if (!newPin || !/^\d{4}$/.test(newPin)) {
      return res.status(400).json({ error: 'Le code PIN doit contenir 4 chiffres' });
    }

    if (endUser.pin_hash) {
      if (!currentPin) return res.status(400).json({ error: 'Code PIN actuel requis' });
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

    let qrToken = endUser.qr_token;
    if (!qrToken) {
      qrToken = crypto.randomBytes(8).toString('base64url');
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


// ═══════════════════════════════════════════════════════
// POST /api/me/push-token — Register Expo push token
// ═══════════════════════════════════════════════════════

router.post('/push-token', authenticateClient, (req, res) => {
  try {
    const { token, platform } = req.body;

    if (!token) return res.status(400).json({ error: 'Token requis' });
    if (!['ios', 'android'].includes(platform)) {
      return res.status(400).json({ error: 'Platform invalide (ios ou android)' });
    }

    pushTokenQueries.upsert.run(req.endUserId, token, platform);

    res.json({ ok: true, message: 'Push token enregistré' });
  } catch (error) {
    console.error('Push token error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// DELETE /api/me/push-token — Remove push token
// ═══════════════════════════════════════════════════════

router.delete('/push-token', authenticateClient, (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token requis' });

    pushTokenQueries.deleteByToken.run(token);

    res.json({ ok: true, message: 'Push token supprimé' });
  } catch (error) {
    console.error('Push token delete error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/me/notifications/preferences — Get notification prefs
// ═══════════════════════════════════════════════════════

router.get('/notifications/preferences', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    res.json({
      notifCredit: !!endUser.notif_credit,
      notifReward: !!endUser.notif_reward,
      notifPromo: !!endUser.notif_promo,
      notifBirthday: !!endUser.notif_birthday,
    });
  } catch (error) {
    console.error('Notif prefs error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// PUT /api/me/notifications/preferences — Update notification prefs
// ═══════════════════════════════════════════════════════

router.put('/notifications/preferences', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const {
      notifCredit = endUser.notif_credit,
      notifReward = endUser.notif_reward,
      notifPromo = endUser.notif_promo,
      notifBirthday = endUser.notif_birthday,
    } = req.body;

    endUserQueries.updateNotifPrefs.run(
      notifCredit ? 1 : 0,
      notifReward ? 1 : 0,
      notifPromo ? 1 : 0,
      notifBirthday ? 1 : 0,
      endUser.id
    );

    res.json({
      ok: true,
      message: 'Préférences mises à jour',
      notifCredit: !!notifCredit,
      notifReward: !!notifReward,
      notifPromo: !!notifPromo,
      notifBirthday: !!notifBirthday,
    });
  } catch (error) {
    console.error('Notif prefs update error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
