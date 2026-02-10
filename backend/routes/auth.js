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
const { sendRegistrationConfirmationEmail } = require('../services/email');

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
    } = req.body;

    if (!businessName || !address || !vatNumber || !email || !phone || !ownerPhone) {
      return res.status(400).json({ error: 'Tous les champs du commerce sont requis' });
    }
    if (!ownerEmail || !ownerPassword || !ownerName) {
      return res.status(400).json({ error: 'Email, mot de passe et nom du responsable requis' });
    }
    if (ownerPassword.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    const normalizedOwnerEmail = normalizeEmail(ownerEmail);
    if (!normalizedOwnerEmail) {
      return res.status(400).json({ error: 'Email du responsable invalide' });
    }

    const normalizedVat = normalizeVAT(vatNumber);
    if (!normalizedVat) {
      return res.status(400).json({ error: 'Numéro de TVA invalide (format: BE0123456789)' });
    }

    email = email.toLowerCase().trim();

    const existingMerchant = merchantQueries.findByVat.get(normalizedVat);
    if (existingMerchant) {
      return res.status(400).json({ error: 'Ce numéro de TVA est déjà enregistré' });
    }

    const existingStaff = staffQueries.findByEmail.get(normalizedOwnerEmail);
    if (existingStaff) {
      return res.status(400).json({ error: 'Cet email est déjà utilisé pour un compte' });
    }

    const merchantResult = merchantQueries.create.run(
      businessName.trim(), address.trim(), normalizedVat,
      email, phone.trim(), ownerPhone.trim()
    );
    const merchantId = merchantResult.lastInsertRowid;

    const hashedPassword = await bcrypt.hash(ownerPassword, 10);
    staffQueries.create.run(
      merchantId, normalizedOwnerEmail, hashedPassword,
      ownerName.trim(), 'owner', 0
    );

    logAudit({
      ...auditCtx(req),
      actorType: 'system',
      merchantId,
      action: 'merchant_registered',
      targetType: 'merchant',
      targetId: merchantId,
      details: { businessName, vatNumber: normalizedVat, ownerEmail: normalizedOwnerEmail },
    });

    sendRegistrationConfirmationEmail(normalizedOwnerEmail, businessName.trim());

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
// POST /api/auth/login
// ═══════════════════════════════════════════════════════

router.post('/login', async (req, res) => {
  try {
    let { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({
        error: 'Veuillez renseigner votre email et votre mot de passe.',
        errorCode: 'MISSING_FIELDS',
      });
    }

    email = normalizeEmail(email);
    if (!email) {
      return res.status(400).json({
        error: 'Le format de l\'email n\'est pas valide.',
        errorCode: 'INVALID_EMAIL',
      });
    }

    const staff = staffQueries.findByEmail.get(email);
    if (!staff) {
      return res.status(401).json({
        error: 'Aucun compte trouvé avec cet email, ou le mot de passe est incorrect.',
        errorCode: 'INVALID_CREDENTIALS',
      });
    }

    const { locked, minutesRemaining } = checkAccountLock(staff);
    if (locked) {
      return res.status(429).json({
        error: `Suite à plusieurs tentatives infructueuses, votre compte est temporairement verrouillé. Vous pourrez réessayer dans ${minutesRemaining} minute(s).`,
        errorCode: 'ACCOUNT_LOCKED',
        minutesRemaining,
      });
    }

    const validPassword = await bcrypt.compare(password, staff.password);
    if (!validPassword) {
      staffQueries.incrementFailedLogin.run(staff.id);

      const newCount = staff.failed_login_count + 1;
      const remaining = MAX_FAILED_ATTEMPTS - newCount;

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

        return res.status(429).json({
          error: 'Trop de tentatives échouées. Votre compte a été verrouillé pour 15 minutes.',
          errorCode: 'ACCOUNT_JUST_LOCKED',
        });
      }

      return res.status(401).json({
        error: 'Email ou mot de passe incorrect.',
        errorCode: 'INVALID_CREDENTIALS',
        attemptsRemaining: remaining > 0 ? remaining : undefined,
      });
    }

    if (!staff.is_active) {
      const merchant = merchantQueries.findById.get(staff.merchant_id);
      if (!merchant) {
        return res.status(403).json({
          error: 'Votre commerce n\'a pas été trouvé dans notre système.',
          errorCode: 'MERCHANT_NOT_FOUND',
        });
      }

      const statusResponses = {
        pending: {
          error: 'Votre demande d\'inscription est en cours d\'examen par notre équipe. Vous recevrez un email dès que votre compte sera activé.',
          errorCode: 'MERCHANT_PENDING',
        },
        suspended: {
          error: 'Votre commerce a été suspendu. Veuillez contacter le support à support@fiddo.be pour plus d\'informations.',
          errorCode: 'MERCHANT_SUSPENDED',
        },
        rejected: {
          error: `Votre demande d'inscription n'a pas été approuvée${merchant.rejection_reason ? '.\n\nMotif : ' + merchant.rejection_reason : '.'}`,
          errorCode: 'MERCHANT_REJECTED',
        },
        cancelled: {
          error: 'Ce commerce a été résilié. Si vous pensez qu\'il s\'agit d\'une erreur, contactez support@fiddo.be.',
          errorCode: 'MERCHANT_CANCELLED',
        },
      };

      const response = statusResponses[merchant.status] || {
        error: 'Votre compte est actuellement désactivé.',
        errorCode: 'ACCOUNT_DISABLED',
      };

      return res.status(403).json(response);
    }

    const merchant = merchantQueries.findById.get(staff.merchant_id);
    if (!merchant || merchant.status !== 'active') {
      return res.status(403).json({
        error: 'Votre commerce n\'est pas encore actif. Veuillez patienter ou contacter le support.',
        errorCode: 'MERCHANT_INACTIVE',
      });
    }

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
    res.status(500).json({
      error: 'Une erreur technique est survenue. Veuillez réessayer dans quelques instants.',
      errorCode: 'SERVER_ERROR',
    });
  }
});

// ═══════════════════════════════════════════════════════
// GET /api/auth/verify
// ═══════════════════════════════════════════════════════

router.get('/verify', authenticateStaff, (req, res) => {
  const staff = staffQueries.findById.get(req.staff.id);
  if (!staff) {
    return res.status(404).json({ error: 'Compte non trouvé' });
  }

  const merchant = merchantQueries.findById.get(staff.merchant_id);
  if (!merchant) {
    return res.status(404).json({ error: 'Commerce non trouvé' });
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

    merchantQueries.updateSettings.run(
      ppe, pfr,
      rewardDescription || 'Récompense offerte',
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
      details: { pointsPerEuro: ppe, pointsForReward: pfr, rewardDescription },
    });

    res.json({ message: 'Paramètres mis à jour' });
  } catch (error) {
    console.error('Erreur update settings:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

module.exports = router;
