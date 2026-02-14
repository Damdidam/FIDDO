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
             m.business_name, m.points_per_euro, m.points_for_reward,
             m.reward_description, m.status, m.business_type, m.allow_gifts
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
      businessType: c.business_type || 'horeca',
      allowGifts: !!c.allow_gifts,
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
// GET /api/me/cards/:merchantId — Card detail
// ═══════════════════════════════════════════════════════

router.get('/cards/:merchantId', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (endUser.is_blocked) return res.status(403).json({ error: 'Compte bloqué' });

    const merchantId = parseInt(req.params.merchantId);

    const mc = db.prepare(`
      SELECT mc.*, m.business_name, m.points_per_euro, m.points_for_reward,
             m.reward_description, m.address, m.phone, m.email,
             m.business_type, m.website_url, m.instagram_url, m.facebook_url,
             m.opening_hours, m.latitude, m.longitude, m.description, m.allow_gifts
      FROM merchant_clients mc
      JOIN merchants m ON mc.merchant_id = m.id
      WHERE mc.merchant_id = ? AND mc.end_user_id = ? AND m.status = 'active'
    `).get(merchantId, endUser.id);

    if (!mc) return res.status(404).json({ error: 'Carte non trouvée' });

    const theme = db.prepare('SELECT theme FROM merchant_preferences WHERE merchant_id = ?')
      .get(merchantId)?.theme || 'teal';

    let openingHours = null;
    try { openingHours = mc.opening_hours ? JSON.parse(mc.opening_hours) : null; } catch {}

    res.json({
      card: {
        pointsBalance: mc.points_balance,
        totalSpent: mc.total_spent,
        visitCount: mc.visit_count,
        lastVisit: mc.last_visit,
        pointsPerEuro: mc.points_per_euro,
        pointsForReward: mc.points_for_reward,
        rewardDescription: mc.custom_reward || mc.reward_description,
        canRedeem: mc.points_balance >= mc.points_for_reward,
        pointsUntilReward: Math.max(mc.points_for_reward - mc.points_balance, 0),
        progress: Math.min((mc.points_balance / mc.points_for_reward) * 100, 100),
      },
      merchant: {
        id: merchantId,
        name: mc.business_name,
        theme,
        businessType: mc.business_type || 'horeca',
        address: mc.address,
        phone: mc.phone,
        email: mc.email,
        websiteUrl: mc.website_url,
        instagramUrl: mc.instagram_url,
        facebookUrl: mc.facebook_url,
        openingHours,
        latitude: mc.latitude,
        longitude: mc.longitude,
        description: mc.description,
        allowGifts: !!mc.allow_gifts,
      },
    });
  } catch (error) {
    console.error('Card detail error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/me/cards/:merchantId/transactions — History
// ═══════════════════════════════════════════════════════

router.get('/cards/:merchantId/transactions', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const merchantId = parseInt(req.params.merchantId);
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = parseInt(req.query.offset) || 0;

    const mc = merchantClientQueries.find.get(merchantId, endUser.id);
    if (!mc) return res.status(404).json({ error: 'Carte non trouvée' });

    const total = db.prepare('SELECT COUNT(*) as c FROM transactions WHERE merchant_client_id = ?').get(mc.id).c;

    const transactions = db.prepare(`
      SELECT t.id, t.amount, t.points_delta, t.transaction_type, t.notes, t.created_at,
             s.display_name as staff_name
      FROM transactions t
      LEFT JOIN staff_accounts s ON t.staff_id = s.id
      WHERE t.merchant_client_id = ?
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(mc.id, limit, offset);

    res.json({
      total,
      transactions: transactions.map(t => ({
        id: t.id,
        type: t.transaction_type,
        amount: t.amount,
        pointsDelta: t.points_delta,
        notes: t.notes,
        staffName: t.staff_name,
        createdAt: t.created_at,
      })),
    });
  } catch (error) {
    console.error('History error:', error);
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
// PUT /api/me/email — Update email address
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// PUT /api/me/profile — Update name, phone, date of birth
// ═══════════════════════════════════════════════════════

router.put('/profile', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const { name, phone, dateOfBirth } = req.body;

    if (name !== undefined) {
      if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Nom trop court' });
      if (name.trim().length > 100) return res.status(400).json({ error: 'Nom trop long' });
    }

    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
    if (phone !== undefined) {
      updates.push('phone = ?', 'phone_e164 = ?');
      const p = phone.trim();
      params.push(p, p.startsWith('+') ? p : (p ? '+32' + p.replace(/^0/, '') : null));
    }
    if (dateOfBirth !== undefined) { updates.push('date_of_birth = ?'); params.push(dateOfBirth || null); }

    if (updates.length === 0) return res.status(400).json({ error: 'Rien à modifier' });

    updates.push("updated_at = datetime('now')");
    params.push(endUser.id);

    db.prepare(`UPDATE end_users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    res.json({ ok: true });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


router.put('/email', authenticateClient, async (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const { newEmail } = req.body;
    if (!newEmail || !newEmail.includes('@')) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    const emailLower = newEmail.trim().toLowerCase();

    const existing = endUserQueries.findByEmailLower.get(emailLower);
    if (existing && existing.id !== endUser.id) {
      return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    }

    db.prepare(`
      UPDATE end_users SET email = ?, email_lower = ?, updated_at = datetime('now') WHERE id = ?
    `).run(newEmail.trim(), emailLower, endUser.id);

    res.json({ ok: true, email: newEmail.trim() });
  } catch (error) {
    console.error('Email update error:', error);
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


// ═══════════════════════════════════════════════════════
// POST /api/me/cards/:merchantId/gift — Create gift voucher
// Debits ALL points from sender, creates a shareable link
// ═══════════════════════════════════════════════════════

router.post('/cards/:merchantId/gift', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (endUser.is_blocked) return res.status(403).json({ error: 'Compte bloqué' });

    const merchantId = parseInt(req.params.merchantId);

    // Check merchant allows gifts
    const merchant = merchantQueries.findById.get(merchantId);
    if (!merchant || merchant.status !== 'active') {
      return res.status(404).json({ error: 'Commerce non trouvé' });
    }
    if (!merchant.allow_gifts) {
      return res.status(400).json({ error: 'Ce commerce n\'autorise pas les transferts de points' });
    }

    // Check sender has points
    const mc = merchantClientQueries.find.get(merchantId, endUser.id);
    if (!mc) return res.status(404).json({ error: 'Carte non trouvée' });
    if (mc.points_balance <= 0) {
      return res.status(400).json({ error: 'Aucun point à offrir' });
    }

    const points = mc.points_balance;
    const token = crypto.randomBytes(16).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Transaction: debit sender + create voucher
    const trx = db.transaction(() => {
      // Debit sender
      db.prepare('UPDATE merchant_clients SET points_balance = 0, updated_at = datetime(\'now\') WHERE id = ?')
        .run(mc.id);

      // Record transaction
      db.prepare(`
        INSERT INTO transactions (merchant_id, merchant_client_id, staff_id, amount, points_delta, transaction_type, notes, created_at)
        VALUES (?, ?, NULL, NULL, ?, 'gift_out', ?, datetime('now'))
      `).run(merchantId, mc.id, -points, `Cadeau de ${points} pts — voucher ${token.substring(0, 8)}`);

      // Create voucher
      db.prepare(`
        INSERT INTO point_vouchers (token, merchant_id, sender_mc_id, sender_eu_id, points, status, expires_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(token, merchantId, mc.id, endUser.id, points, expiresAt);
    });

    trx();

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const giftUrl = `${baseUrl}/app?gift=${token}`;

    res.json({
      ok: true,
      token,
      points,
      giftUrl,
      expiresAt,
    });
  } catch (error) {
    console.error('Gift create error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/me/gift/:token — Get gift voucher info (public-ish)
// ═══════════════════════════════════════════════════════

router.get('/gift/:token', (req, res) => {
  try {
    const voucher = db.prepare(`
      SELECT pv.*, m.business_name
      FROM point_vouchers pv
      JOIN merchants m ON pv.merchant_id = m.id
      WHERE pv.token = ?
    `).get(req.params.token);

    if (!voucher) return res.status(404).json({ error: 'Lien cadeau introuvable' });
    if (voucher.status === 'claimed') return res.status(400).json({ error: 'Ce cadeau a déjà été récupéré' });
    if (voucher.status === 'expired' || new Date(voucher.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Ce lien cadeau a expiré' });
    }
    if (voucher.status === 'cancelled') return res.status(400).json({ error: 'Ce cadeau a été annulé' });

    res.json({
      points: voucher.points,
      merchantName: voucher.business_name,
      merchantId: voucher.merchant_id,
      expiresAt: voucher.expires_at,
    });
  } catch (error) {
    console.error('Gift info error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/me/gift/:token/claim — Claim gift voucher
// Credits points to the authenticated user
// ═══════════════════════════════════════════════════════

router.post('/gift/:token/claim', authenticateClient, (req, res) => {
  try {
    const endUser = endUserQueries.findById.get(req.endUserId);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (endUser.is_blocked) return res.status(403).json({ error: 'Compte bloqué' });

    const voucher = db.prepare('SELECT * FROM point_vouchers WHERE token = ?').get(req.params.token);
    if (!voucher) return res.status(404).json({ error: 'Lien cadeau introuvable' });
    if (voucher.status !== 'pending') return res.status(400).json({ error: 'Ce cadeau a déjà été utilisé' });
    if (new Date(voucher.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Ce lien cadeau a expiré' });
    }

    // Prevent self-claim
    if (voucher.sender_eu_id === endUser.id) {
      return res.status(400).json({ error: 'Vous ne pouvez pas récupérer votre propre cadeau' });
    }

    // Check claimer has a card at this merchant — auto-create if not
    let mc = merchantClientQueries.find.get(voucher.merchant_id, endUser.id);
    if (!mc) {
      db.prepare('INSERT INTO merchant_clients (merchant_id, end_user_id) VALUES (?, ?)').run(voucher.merchant_id, endUser.id);
      mc = merchantClientQueries.find.get(voucher.merchant_id, endUser.id);
    }

    const trx = db.transaction(() => {
      // Credit claimer
      db.prepare(`
        UPDATE merchant_clients
        SET points_balance = points_balance + ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(voucher.points, mc.id);

      // Record transaction
      db.prepare(`
        INSERT INTO transactions (merchant_id, merchant_client_id, staff_id, amount, points_delta, transaction_type, notes, created_at)
        VALUES (?, ?, NULL, NULL, ?, 'gift_in', ?, datetime('now'))
      `).run(voucher.merchant_id, mc.id, voucher.points, `Cadeau reçu — voucher ${voucher.token.substring(0, 8)}`);

      // Mark voucher claimed
      db.prepare(`
        UPDATE point_vouchers
        SET status = 'claimed', claimer_mc_id = ?, claimer_eu_id = ?, claimed_at = datetime('now')
        WHERE id = ?
      `).run(mc.id, endUser.id, voucher.id);
    });

    trx();

    res.json({
      ok: true,
      points: voucher.points,
      merchantId: voucher.merchant_id,
    });
  } catch (error) {
    console.error('Gift claim error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
