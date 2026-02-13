const express = require('express');
const bcrypt = require('bcryptjs');
const { db, merchantQueries, staffQueries } = require('../database');
const { authenticateStaff, requireRole } = require('../middleware/auth');
const { logAudit, auditCtx } = require('../middleware/audit');
const { exportMerchantData, validateBackup, importMerchantData } = require('../services/backup');
const { sendMerchantInfoChangedEmail, sendPasswordChangedEmail } = require('../services/email');
const { normalizeEmail, normalizeVAT } = require('../services/normalizer');

const router = express.Router();

// All routes require authentication
router.use(authenticateStaff);

// ─── Theme defaults ──────────────────────────────────

const VALID_THEMES = ['teal', 'navy', 'violet', 'forest', 'brick', 'amber', 'slate'];
const VALID_LANGUAGES = ['fr', 'nl', 'en'];
const VALID_BACKUP_FREQ = ['manual', 'daily', 'twice', 'thrice'];

const DEFAULT_PREFS = {
  theme: 'teal',
  language: 'fr',
  timezone: 'Europe/Brussels',
  reward_message: 'Félicitations ! Vous avez gagné votre récompense ! 🎁',
  notify_new_client: 1,
  notify_reward_ready: 1,
  notify_weekly_report: 0,
  logo_url: null,
  backup_frequency: 'manual',
  last_backup_at: null,
  credit_methods: '{"email":true,"phone":true,"qr":true,"scan":true}',
};


// ═══════════════════════════════════════════════════════
// GET /api/preferences — Get current preferences
// ═══════════════════════════════════════════════════════

router.get('/', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const prefs = db.prepare('SELECT * FROM merchant_preferences WHERE merchant_id = ?').get(merchantId);

    res.json({
      preferences: prefs || { merchant_id: merchantId, ...DEFAULT_PREFS },
    });
  } catch (error) {
    console.error('Erreur get preferences:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// PUT /api/preferences — Update all preferences (owner only)
// ═══════════════════════════════════════════════════════

router.put('/', requireRole('owner'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const {
      theme, language, timezone, reward_message,
      notify_new_client, notify_reward_ready, notify_weekly_report,
      logo_url, backup_frequency, credit_methods,
    } = req.body;

    // Validate
    if (theme && !VALID_THEMES.includes(theme)) {
      return res.status(400).json({ error: `Thème invalide. Choix : ${VALID_THEMES.join(', ')}` });
    }
    if (language && !VALID_LANGUAGES.includes(language)) {
      return res.status(400).json({ error: `Langue invalide. Choix : ${VALID_LANGUAGES.join(', ')}` });
    }
    if (backup_frequency && !VALID_BACKUP_FREQ.includes(backup_frequency)) {
      return res.status(400).json({ error: 'Fréquence de backup invalide' });
    }

    // Validate credit_methods if provided
    const VALID_CREDIT_KEYS = ['email', 'phone', 'qr', 'scan'];
    if (credit_methods) {
      const cm = typeof credit_methods === 'string' ? JSON.parse(credit_methods) : credit_methods;
      const keys = Object.keys(cm);
      if (!keys.every(k => VALID_CREDIT_KEYS.includes(k))) {
        return res.status(400).json({ error: 'Méthodes de crédit invalides' });
      }
      // At least one method must be enabled
      if (!Object.values(cm).some(v => v === true)) {
        return res.status(400).json({ error: 'Au moins une méthode de crédit doit être activée' });
      }
    }

    // Get current or defaults
    const current = db.prepare('SELECT * FROM merchant_preferences WHERE merchant_id = ?').get(merchantId) || DEFAULT_PREFS;

    // Upsert
    db.prepare(`
      INSERT INTO merchant_preferences
        (merchant_id, theme, language, timezone, reward_message,
         notify_new_client, notify_reward_ready, notify_weekly_report,
         logo_url, backup_frequency, credit_methods, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(merchant_id) DO UPDATE SET
        theme = excluded.theme,
        language = excluded.language,
        timezone = excluded.timezone,
        reward_message = excluded.reward_message,
        notify_new_client = excluded.notify_new_client,
        notify_reward_ready = excluded.notify_reward_ready,
        notify_weekly_report = excluded.notify_weekly_report,
        logo_url = excluded.logo_url,
        backup_frequency = excluded.backup_frequency,
        credit_methods = excluded.credit_methods,
        updated_at = datetime('now')
    `).run(
      merchantId,
      theme || current.theme,
      language || current.language,
      timezone || current.timezone,
      reward_message !== undefined ? reward_message : current.reward_message,
      notify_new_client !== undefined ? (notify_new_client ? 1 : 0) : current.notify_new_client,
      notify_reward_ready !== undefined ? (notify_reward_ready ? 1 : 0) : current.notify_reward_ready,
      notify_weekly_report !== undefined ? (notify_weekly_report ? 1 : 0) : current.notify_weekly_report,
      logo_url !== undefined ? logo_url : current.logo_url,
      backup_frequency || current.backup_frequency,
      credit_methods ? (typeof credit_methods === 'string' ? credit_methods : JSON.stringify(credit_methods)) : (current.credit_methods || '{"email":true,"phone":true,"qr":true,"scan":true}'),
    );

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId,
      action: 'preferences_updated',
      targetType: 'merchant',
      targetId: merchantId,
      details: { theme, language, backup_frequency },
    });

    // Return updated
    const updated = db.prepare('SELECT * FROM merchant_preferences WHERE merchant_id = ?').get(merchantId);
    res.json({ message: 'Préférences mises à jour', preferences: updated });
  } catch (error) {
    console.error('Erreur update preferences:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// PATCH /api/preferences/theme — Quick theme switch (any staff)
// ═══════════════════════════════════════════════════════

router.patch('/theme', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { theme } = req.body;

    if (!theme || !VALID_THEMES.includes(theme)) {
      return res.status(400).json({ error: `Thème invalide. Choix : ${VALID_THEMES.join(', ')}` });
    }

    db.prepare(`
      INSERT INTO merchant_preferences (merchant_id, theme, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(merchant_id) DO UPDATE SET theme = excluded.theme, updated_at = datetime('now')
    `).run(merchantId, theme);

    res.json({ message: 'Thème mis à jour', theme });
  } catch (error) {
    console.error('Erreur theme:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/preferences/backup/export — Download full backup (owner only)
// ═══════════════════════════════════════════════════════

router.get('/backup/export', requireRole('owner'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const backup = exportMerchantData(merchantId);

    // Mark backup time
    db.prepare(`
      INSERT INTO merchant_preferences (merchant_id, last_backup_at, updated_at)
      VALUES (?, datetime('now'), datetime('now'))
      ON CONFLICT(merchant_id) DO UPDATE SET last_backup_at = datetime('now'), updated_at = datetime('now')
    `).run(merchantId);

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId,
      action: 'backup_exported',
      targetType: 'merchant',
      targetId: merchantId,
      details: backup._stats,
    });

    // Send as downloadable JSON
    const filename = `fiddo-backup-${backup._meta.business_name.replace(/[^a-zA-Z0-9]/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (error) {
    console.error('Erreur export backup:', error);
    res.status(500).json({ error: 'Erreur lors de l\'export' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/preferences/backup/validate — Preview backup before import
// ═══════════════════════════════════════════════════════

router.post('/backup/validate', requireRole('owner'), (req, res) => {
  try {
    const data = req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Aucune donnée reçue' });
    }

    const result = validateBackup(data);
    res.json(result);
  } catch (error) {
    console.error('Erreur validate backup:', error);
    res.status(500).json({ error: 'Erreur lors de la validation' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/preferences/backup/import — Restore from backup (owner only)
// ⚠️ DESTRUCTIVE: replaces all client/transaction data
// ═══════════════════════════════════════════════════════

router.post('/backup/import', requireRole('owner'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { data, confirmReplace } = req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Aucune donnée reçue' });
    }

    if (!confirmReplace) {
      return res.status(400).json({ error: 'Confirmation requise (confirmReplace: true)' });
    }

    // Extra safety: validate first
    const validation = validateBackup(data);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Backup invalide', errors: validation.errors });
    }

    const result = importMerchantData(merchantId, data);

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId,
      action: 'backup_imported',
      targetType: 'merchant',
      targetId: merchantId,
      details: {
        ...result,
        source_business: data._meta.business_name,
        source_date: data._meta.exported_at,
      },
    });

    res.json({
      message: 'Données restaurées avec succès',
      result,
    });
  } catch (error) {
    console.error('Erreur import backup:', error);
    res.status(500).json({ error: error.message || 'Erreur lors de l\'import' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/preferences/merchant-info — Get merchant business info
// ═══════════════════════════════════════════════════════

router.get('/merchant-info', requireRole('owner'), (req, res) => {
  try {
    const merchant = merchantQueries.findById.get(req.staff.merchant_id);
    if (!merchant) return res.status(404).json({ error: 'Commerce non trouvé' });

    const staff = staffQueries.findById.get(req.staff.id);

    res.json({
      businessName: merchant.business_name,
      address: merchant.address,
      vatNumber: merchant.vat_number,
      email: merchant.email,
      phone: merchant.phone,
      ownerPhone: merchant.owner_phone,
      ownerName: staff?.display_name || '',
      ownerEmail: staff?.email || '',
    });
  } catch (error) {
    console.error('Erreur get merchant-info:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// PUT /api/preferences/merchant-info — Update merchant business info (owner only)
// Sends notification email to super admin
// ═══════════════════════════════════════════════════════

router.put('/merchant-info', requireRole('owner'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { businessName, address, vatNumber, email, phone, ownerPhone, ownerName } = req.body;

    // Validate required fields
    if (!businessName || !address || !vatNumber || !email || !phone || !ownerPhone) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }

    // Normalize & validate VAT
    const normalizedVat = normalizeVAT(vatNumber);
    if (!normalizedVat) {
      return res.status(400).json({ error: 'Numéro de TVA invalide (format: BE0123456789)' });
    }

    // Check VAT uniqueness (if changed)
    const current = merchantQueries.findById.get(merchantId);
    if (!current) return res.status(404).json({ error: 'Commerce non trouvé' });

    if (normalizedVat !== current.vat_number) {
      const existing = db.prepare('SELECT id FROM merchants WHERE vat_number = ? AND id != ?').get(normalizedVat, merchantId);
      if (existing) {
        return res.status(400).json({ error: 'Ce numéro de TVA est déjà utilisé par un autre commerce' });
      }
    }

    // Build change log for admin notification
    const changes = [];
    if (businessName.trim() !== current.business_name) changes.push({ field: 'Nom du commerce', old: current.business_name, new: businessName.trim() });
    if (address.trim() !== current.address) changes.push({ field: 'Adresse', old: current.address, new: address.trim() });
    if (normalizedVat !== current.vat_number) changes.push({ field: 'N° TVA', old: current.vat_number, new: normalizedVat });
    if (email.trim().toLowerCase() !== current.email) changes.push({ field: 'Email commerce', old: current.email, new: email.trim().toLowerCase() });
    if (phone.trim() !== current.phone) changes.push({ field: 'Téléphone', old: current.phone, new: phone.trim() });
    if (ownerPhone.trim() !== current.owner_phone) changes.push({ field: 'Tél. propriétaire', old: current.owner_phone, new: ownerPhone.trim() });

    if (changes.length === 0 && (!ownerName || ownerName.trim() === (staffQueries.findById.get(req.staff.id)?.display_name || ''))) {
      return res.json({ message: 'Aucune modification détectée', changes: [] });
    }

    // Update merchant
    db.prepare(`
      UPDATE merchants
      SET business_name = ?, address = ?, vat_number = ?,
          email = ?, phone = ?, owner_phone = ?
      WHERE id = ?
    `).run(
      businessName.trim(), address.trim(), normalizedVat,
      email.trim().toLowerCase(), phone.trim(), ownerPhone.trim(),
      merchantId
    );

    // Update owner display name if provided
    if (ownerName && ownerName.trim()) {
      const currentStaff = staffQueries.findById.get(req.staff.id);
      if (currentStaff && ownerName.trim() !== currentStaff.display_name) {
        changes.push({ field: 'Nom propriétaire', old: currentStaff.display_name, new: ownerName.trim() });
        db.prepare('UPDATE staff_accounts SET display_name = ? WHERE id = ?').run(ownerName.trim(), req.staff.id);
      }
    }

    // Audit
    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId,
      action: 'merchant_info_updated',
      targetType: 'merchant',
      targetId: merchantId,
      details: { changes },
    });

    // 🔥 Notify Super Sayan God (all super admins)
    if (changes.length > 0) {
      const admins = db.prepare('SELECT email FROM super_admins').all();
      admins.forEach(admin => {
        sendMerchantInfoChangedEmail(
          admin.email,
          current.business_name,
          businessName.trim(),
          req.staff.email,
          changes
        );
      });
    }

    // Update session data
    const updated = merchantQueries.findById.get(merchantId);

    res.json({
      message: 'Informations mises à jour',
      merchant: updated,
      changes,
    });
  } catch (error) {
    console.error('Erreur update merchant-info:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// PUT /api/preferences/password — Change own password
// ═══════════════════════════════════════════════════════

router.put('/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Mot de passe actuel et nouveau requis' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères' });
    }

    const staff = staffQueries.findById.get(req.staff.id);
    if (!staff) return res.status(404).json({ error: 'Compte non trouvé' });

    const valid = await bcrypt.compare(currentPassword, staff.password);
    if (!valid) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    staffQueries.updatePassword.run(hashed, req.staff.id);

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId: req.staff.merchant_id,
      action: 'password_changed',
      targetType: 'staff',
      targetId: req.staff.id,
    });

    // Fire-and-forget confirmation email
    sendPasswordChangedEmail(staff.email, staff.display_name);

    res.json({ message: 'Mot de passe modifié avec succès' });
  } catch (error) {
    console.error('Erreur changement mot de passe:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
