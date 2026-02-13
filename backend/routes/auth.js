const express = require('express');
const bcrypt = require('bcryptjs');
const { merchantQueries, staffQueries } = require('../database');
const {
  authenticateStaff,
  generateStaffToken,
  staffCookieOptions,
  checkAccountLock,
  computeLockUntil,
  MAX_FAILED_ATTEMPTS,
} = require('../middleware/auth');
const { logAudit, auditCtx } = require('../middleware/audit');
const { normalizeEmail, normalizeVAT, isValidEmail } = require('../services/normalizer');

const router = express.Router();

// ═══════════════════════════════════════════════════════
// POST /api/auth/register — Inscription merchant (→ pending)
// ═══════════════════════════════════════════════════════

router.post('/register', async (req, res) => {
  try {
    let {
      businessName, address, vatNumber,
      email, phone, ownerPhone,
      ownerEmail, ownerPassword, ownerName,
      pointsPerEuro, pointsForReward, rewardDescription,
    } = req.body;

    // ── Validate required fields ──
    if (!businessName || !address || !vatNumber || !email || !phone || !ownerPhone) {
      return res.status(400).json({ error: 'Tous les champs du commerce sont requis' });
    }
    if (!ownerEmail || !ownerPassword || !ownerName) {
      return res.status(400).json({ error: 'Email, mot de passe et nom du responsable requis' });
    }
    if (ownerPassword.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }
    // Input length limits
    if (businessName.length > 150) return res.status(400).json({ error: 'Nom du commerce trop long (max 150)' });
    if (address.length > 300) return res.status(400).json({ error: 'Adresse trop longue (max 300)' });
    if (ownerName.length > 100) return res.status(400).json({ error: 'Nom du responsable trop long (max 100)' });
    if (ownerEmail.length > 254) return res.status(400).json({ error: 'Email trop long (max 254)' });
    if (phone.length > 20) return res.status(400).json({ error: 'Téléphone trop long (max 20)' });
    if (ownerPhone.length > 20) return res.status(400).json({ error: 'Téléphone responsable trop long (max 20)' });

    // ── Normalize ──
    const normalizedOwnerEmail = normalizeEmail(ownerEmail);
    if (!normalizedOwnerEmail) {
      return res.status(400).json({ error: 'Email du responsable invalide' });
    }

    const normalizedVat = normalizeVAT(vatNumber);
    if (!normalizedVat) {
      return res.status(400).json({ error: 'Numéro de TVA invalide (format: BE0123456789)' });
    }

    email = email.toLowerCase().trim();

    // ── Validate loyalty config ──
    const ppe = pointsPerEuro !== undefined && pointsPerEuro !== '' ? parseFloat(pointsPerEuro) : 1.0;
    const pfr = pointsForReward !== undefined && pointsForReward !== '' ? parseInt(pointsForReward) : 100;
    const rdesc = (rewardDescription && rewardDescription.trim()) ? rewardDescription.trim() : 'Récompense offerte';

    if (isNaN(ppe) || ppe <= 0) {
      return res.status(400).json({ error: 'Points par euro invalide (doit être > 0)' });
    }
    if (isNaN(pfr) || pfr <= 0) {
      return res.status(400).json({ error: 'Points pour récompense invalide (doit être > 0)' });
    }
    if (rdesc.length > 200) {
      return res.status(400).json({ error: 'Description de la récompense trop longue (max 200 caractères)' });
    }

    // ── Uniqueness checks ──
    const existingMerchant = merchantQueries.findByVat.get(normalizedVat);
    if (existingMerchant) {
      return res.status(400).json({ error: 'Ce numéro de TVA est déjà enregistré' });
    }

    const existingStaff = staffQueries.findByEmail.get(normalizedOwnerEmail);
    if (existingStaff) {
      return res.status(400).json({ error: 'Cet email est déjà utilisé pour un compte' });
    }

    // ── Create merchant (status: pending) with loyalty config ──
    const merchantResult = merchantQueries.create.run(
      businessName.trim(), address.trim(), normalizedVat,
      email, phone.trim(), ownerPhone.trim(),
      ppe, pfr, rdesc
    );
    const merchantId = merchantResult.lastInsertRowid;

    // ── Create owner staff account (is_active: 0 — awaiting validation) ──
    const hashedPassword = await bcrypt.hash(ownerPassword, 10);
    staffQueries.create.run(
      merchantId, normalizedOwnerEmail, hashedPassword,
      ownerName.trim(), 'owner', 0
    );

    // ── Audit ──
    logAudit({
      ...auditCtx(req),
      actorType: 'system',
      merchantId,
      action: 'merchant_registered',
      targetType: 'merchant',
      targetId: merchantId,
      details: {
        businessName,
        vatNumber: normalizedVat,
        ownerEmail: normalizedOwnerEmail,
        pointsPerEuro: ppe,
        pointsForReward: pfr,
        rewardDescription: rdesc,
      },
    });

    res.status(201).json({
      message: 'Demande d\'inscription envoyée ! Vous recevrez un email une fois votre compte validé.',
      merchantId,
    });
  } catch (error) {
    console.error('Erreur inscription:', error);
    res.status(500).json({ error: 'Erreur lors de l\'inscription' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/auth/login — Login staff (with brute force protection)
// ═══════════════════════════════════════════════════════

router.post('/login', async (req, res) => {
  try {
    let { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    email = normalizeEmail(email);
    if (!email) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    // Find staff account
    const staff = staffQueries.findByEmail.get(email);
    if (!staff) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    // ── Brute force: check lock ──
    const { locked, minutesRemaining } = checkAccountLock(staff);
    if (locked) {
      return res.status(429).json({
        error: `Compte temporairement verrouillé. Réessayez dans ${minutesRemaining} minute(s).`,
      });
    }

    // ── Verify password ──
    const validPassword = await bcrypt.compare(password, staff.password);
    if (!validPassword) {
      // Increment failed count
      staffQueries.incrementFailedLogin.run(staff.id);

      const newCount = staff.failed_login_count + 1;
      if (newCount >= MAX_FAILED_ATTEMPTS) {
        const lockUntil = computeLockUntil();
        staffQueries.lockAccount.run(lockUntil, staff.id);

        logAudit({
          ...auditCtx(req),
          actorType: 'system',
          merchantId: staff.merchant_id,
          action: 'account_locked',
          targetType: 'staff',
          targetId: staff.id,
          details: { failedAttempts: newCount },
        });
      }

      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    // ── Check account status ──
    if (!staff.is_active) {
      const merchant = merchantQueries.findById.get(staff.merchant_id);
      if (!merchant) {
        return res.status(403).json({ error: 'Commerce non trouvé' });
      }

      const statusMessages = {
        pending: 'Votre commerce est en attente de validation. Vous recevrez un email une fois approuvé.',
        suspended: 'Votre commerce est suspendu. Contactez le support.',
        rejected: `Votre demande a été refusée${merchant.rejection_reason ? ' : ' + merchant.rejection_reason : '.'}`,
        cancelled: 'Ce commerce a été résilié.',
      };

      const msg = statusMessages[merchant.status] || 'Votre compte est désactivé.';
      return res.status(403).json({ error: msg });
    }

    // Verify merchant is active
    const merchant = merchantQueries.findById.get(staff.merchant_id);
    if (!merchant || merchant.status !== 'active') {
      return res.status(403).json({ error: 'Votre commerce n\'est pas actif.' });
    }

    // ── Success: reset failed count, generate token ──
    staffQueries.updateLastLogin.run(staff.id);

    const token = generateStaffToken(staff);
    res.cookie('staff_token', token, staffCookieOptions(staff.role));

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: staff.id,
      merchantId: staff.merchant_id,
      action: 'staff_login',
      targetType: 'staff',
      targetId: staff.id,
    });

    const { password: _, ...staffData } = staff;
    res.json({
      message: 'Connexion réussie',
      staff: staffData,
      merchant,
    });
  } catch (error) {
    console.error('Erreur login:', error);
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/auth/verify — Vérifier le token courant
// ═══════════════════════════════════════════════════════

router.get('/verify', authenticateStaff, (req, res) => {
  const staff = staffQueries.findById.get(req.staff.id);
  if (!staff) {
    return res.status(404).json({ error: 'Compte non trouvé' });
  }

  // Re-check account status (may have been deactivated after JWT issued)
  if (!staff.is_active) {
    res.clearCookie('staff_token');
    return res.status(403).json({ error: 'Votre compte a été désactivé.' });
  }

  const merchant = merchantQueries.findById.get(staff.merchant_id);
  if (!merchant) {
    return res.status(404).json({ error: 'Commerce non trouvé' });
  }

  // Re-check merchant status (may have been suspended after JWT issued)
  if (merchant.status !== 'active') {
    res.clearCookie('staff_token');
    const statusMessages = {
      suspended: 'Votre commerce a été suspendu. Contactez le support.',
      cancelled: 'Ce commerce a été résilié.',
      pending: 'Votre commerce est en attente de validation.',
    };
    return res.status(403).json({ error: statusMessages[merchant.status] || 'Commerce non actif.' });
  }

  const { password: _, ...staffData } = staff;
  res.json({ staff: staffData, merchant });
});


// ═══════════════════════════════════════════════════════
// POST /api/auth/logout
// ═══════════════════════════════════════════════════════

router.post('/logout', (req, res) => {
  res.clearCookie('staff_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  });
  res.json({ message: 'Déconnecté' });
});


// ═══════════════════════════════════════════════════════
// PUT /api/auth/settings — Update merchant settings (owner only)
// ═══════════════════════════════════════════════════════

router.put('/settings', authenticateStaff, (req, res) => {
  if (req.staff.role !== 'owner') {
    return res.status(403).json({ error: 'Seul le propriétaire peut modifier les paramètres' });
  }

  try {
    const { pointsPerEuro, pointsForReward, rewardDescription } = req.body;

    const ppe = parseFloat(pointsPerEuro);
    const pfr = parseInt(pointsForReward);

    if (isNaN(ppe) || ppe <= 0) {
      return res.status(400).json({ error: 'Points par euro invalide' });
    }
    if (isNaN(pfr) || pfr <= 0) {
      return res.status(400).json({ error: 'Points pour récompense invalide' });
    }

    const rdesc = (rewardDescription && rewardDescription.trim()) ? rewardDescription.trim() : 'Récompense offerte';
    if (rdesc.length > 200) {
      return res.status(400).json({ error: 'Description de la récompense trop longue (max 200 caractères)' });
    }

    merchantQueries.updateSettings.run(
      ppe, pfr, rdesc,
      req.staff.merchant_id
    );

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId: req.staff.merchant_id,
      action: 'settings_updated',
      targetType: 'merchant',
      targetId: req.staff.merchant_id,
      details: { pointsPerEuro: ppe, pointsForReward: pfr, rewardDescription: rdesc },
    });

    res.json({ message: 'Paramètres mis à jour' });
  } catch (error) {
    console.error('Erreur update settings:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});


module.exports = router;
