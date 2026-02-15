const express = require('express');
const bcrypt = require('bcryptjs');
const { db, merchantQueries, staffQueries } = require('../database');
const { authenticateStaff, requireRole } = require('../middleware/auth');
const { logAudit, auditCtx } = require('../middleware/audit');
const { exportMerchantData, validateBackup, importMerchantData } = require('../services/backup');
const { sendMerchantInfoChangedEmail, sendPasswordChangedEmail, sendExportEmail } = require('../services/email');
const { normalizeEmail, normalizeVAT } = require('../services/normalizer');

const router = express.Router();

// All routes require authentication
router.use(authenticateStaff);

// ─── Theme defaults ──────────────────────────────────

const VALID_THEMES = ['teal', 'navy', 'violet', 'forest', 'brick', 'amber', 'slate'];
const VALID_LANGUAGES = ['fr', 'nl', 'en', 'tr', 'zh', 'ar'];
const VALID_BACKUP_FREQ = ['manual', 'daily', 'twice', 'thrice'];

const VALID_BUSINESS_TYPES = [
  'horeca', 'boulangerie', 'coiffeur', 'beaute', 'pharmacie',
  'fleuriste', 'boucherie', 'epicerie', 'cave', 'librairie',
  'pressing', 'fitness', 'garage', 'veterinaire', 'autre',
];

const BUSINESS_TYPE_LABELS = {
  horeca: 'Horeca', boulangerie: 'Boulangerie', coiffeur: 'Coiffeur',
  beaute: 'Beauté', pharmacie: 'Pharmacie', fleuriste: 'Fleuriste',
  boucherie: 'Boucherie', epicerie: 'Épicerie', cave: 'Cave à vins',
  librairie: 'Librairie', pressing: 'Pressing', fitness: 'Fitness',
  garage: 'Garage', veterinaire: 'Vétérinaire', autre: 'Autre',
};

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
// POST /api/preferences/backup/export — Send backup by email (owner only)
// ═══════════════════════════════════════════════════════

router.post('/backup/export', requireRole('owner'), async (req, res) => {
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

    const filename = `fiddo-backup-${backup._meta.business_name.replace(/[^a-zA-Z0-9]/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;

    const sent = await sendExportEmail(
      req.staff.email,
      backup._meta.business_name,
      filename,
      JSON.stringify(backup, null, 2),
      'application/json'
    );

    if (sent) {
      res.json({ success: true, message: `Backup envoyé à ${req.staff.email}` });
    } else {
      res.status(500).json({ error: 'Erreur lors de l\'envoi de l\'email' });
    }
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

    // Verify backup belongs to this merchant (or is a fresh import)
    if (data._meta && data._meta.merchant_id && data._meta.merchant_id !== merchantId) {
      return res.status(403).json({
        error: 'Ce backup appartient à un autre commerce',
        details: `Backup: ${data._meta.business_name || 'inconnu'} (ID ${data._meta.merchant_id}) — Votre commerce: ID ${merchantId}`,
      });
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

    let openingHours = null;
    try { openingHours = merchant.opening_hours ? JSON.parse(merchant.opening_hours) : null; } catch {}

    res.json({
      businessName: merchant.business_name,
      address: merchant.address,
      vatNumber: merchant.vat_number,
      email: merchant.email,
      phone: merchant.phone,
      ownerPhone: merchant.owner_phone,
      ownerName: staff?.display_name || '',
      ownerEmail: staff?.email || '',
      businessType: merchant.business_type || 'horeca',
      websiteUrl: merchant.website_url || '',
      instagramUrl: merchant.instagram_url || '',
      facebookUrl: merchant.facebook_url || '',
      openingHours,
      latitude: merchant.latitude || null,
      longitude: merchant.longitude || null,
      description: merchant.description || '',
      allowGifts: !!merchant.allow_gifts,
      businessTypes: BUSINESS_TYPE_LABELS,
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
    const {
      businessName, address, vatNumber, email, phone, ownerPhone, ownerName,
      businessType, websiteUrl, instagramUrl, facebookUrl,
      openingHours, latitude, longitude, description, allowGifts,
    } = req.body;

    // Validate required fields
    if (!businessName || !address || !vatNumber || !email || !phone || !ownerPhone) {
      return res.status(400).json({ error: 'Tous les champs obligatoires sont requis' });
    }

    // Input length limits (same as registration)
    if (businessName.length > 150) return res.status(400).json({ error: 'Nom du commerce trop long (max 150)' });
    if (address.length > 300) return res.status(400).json({ error: 'Adresse trop longue (max 300)' });
    if (email.length > 254) return res.status(400).json({ error: 'Email trop long (max 254)' });
    if (phone.length > 20) return res.status(400).json({ error: 'Téléphone trop long (max 20)' });
    if (ownerPhone.length > 20) return res.status(400).json({ error: 'Téléphone responsable trop long (max 20)' });
    if (ownerName && ownerName.length > 100) return res.status(400).json({ error: 'Nom du responsable trop long (max 100)' });
    if (description && description.length > 500) return res.status(400).json({ error: 'Description trop longue (max 500)' });

    // Validate business type
    const validType = (businessType && VALID_BUSINESS_TYPES.includes(businessType)) ? businessType : 'horeca';

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

    // Serialize opening_hours
    let hoursJson = null;
    if (openingHours && typeof openingHours === 'object') {
      hoursJson = JSON.stringify(openingHours);
    }

    // Build change log for admin notification
    const changes = [];
    if (businessName.trim() !== current.business_name) changes.push({ field: 'Nom du commerce', old: current.business_name, new: businessName.trim() });
    if (address.trim() !== current.address) changes.push({ field: 'Adresse', old: current.address, new: address.trim() });
    if (normalizedVat !== current.vat_number) changes.push({ field: 'N° TVA', old: current.vat_number, new: normalizedVat });
    if (email.trim().toLowerCase() !== current.email) changes.push({ field: 'Email commerce', old: current.email, new: email.trim().toLowerCase() });
    if (phone.trim() !== current.phone) changes.push({ field: 'Téléphone', old: current.phone, new: phone.trim() });
    if (ownerPhone.trim() !== current.owner_phone) changes.push({ field: 'Tél. propriétaire', old: current.owner_phone, new: ownerPhone.trim() });
    if (validType !== (current.business_type || 'horeca')) changes.push({ field: 'Type de commerce', old: current.business_type || 'horeca', new: validType });
    if ((websiteUrl || '') !== (current.website_url || '')) changes.push({ field: 'Site web', old: current.website_url || '', new: websiteUrl || '' });
    if ((instagramUrl || '') !== (current.instagram_url || '')) changes.push({ field: 'Instagram', old: current.instagram_url || '', new: instagramUrl || '' });
    if ((facebookUrl || '') !== (current.facebook_url || '')) changes.push({ field: 'Facebook', old: current.facebook_url || '', new: facebookUrl || '' });
    if ((description || '') !== (current.description || '')) changes.push({ field: 'Description', old: current.description || '', new: description || '' });
    if ((allowGifts ? 1 : 0) !== (current.allow_gifts || 0)) changes.push({ field: 'Cadeaux points', old: current.allow_gifts ? 'Oui' : 'Non', new: allowGifts ? 'Oui' : 'Non' });

    // Compare opening hours
    const currentHoursJson = current.opening_hours || null;
    const newHoursJson = (openingHours && typeof openingHours === 'object' && Object.keys(openingHours).length > 0) ? JSON.stringify(openingHours) : null;
    if (currentHoursJson !== newHoursJson) changes.push({ field: 'Horaires', old: currentHoursJson || '(vide)', new: newHoursJson || '(vide)' });

    if (changes.length === 0 && (!ownerName || ownerName.trim() === (staffQueries.findById.get(req.staff.id)?.display_name || ''))) {
      return res.json({ message: 'Aucune modification détectée', changes: [] });
    }

    // Update merchant (all fields)
    db.prepare(`
      UPDATE merchants
      SET business_name = ?, address = ?, vat_number = ?,
          email = ?, phone = ?, owner_phone = ?,
          business_type = ?, website_url = ?, instagram_url = ?, facebook_url = ?,
          opening_hours = ?, latitude = ?, longitude = ?,
          description = ?, allow_gifts = ?
      WHERE id = ?
    `).run(
      businessName.trim(), address.trim(), normalizedVat,
      email.trim().toLowerCase(), phone.trim(), ownerPhone.trim(),
      validType,
      websiteUrl || null, instagramUrl || null, facebookUrl || null,
      hoursJson, latitude || null, longitude || null,
      description || null, allowGifts ? 1 : 0,
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

    // Return updated
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
    if (newPassword.length > 72) {
      return res.status(400).json({ error: 'Le mot de passe ne doit pas dépasser 72 caractères' });
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
