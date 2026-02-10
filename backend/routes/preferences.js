const express = require('express');
const { db } = require('../database');
const { authenticateStaff, requireRole } = require('../middleware/auth');
const { logAudit, auditCtx } = require('../middleware/audit');
const { exportMerchantData, validateBackup, importMerchantData } = require('../services/backup');

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
      logo_url, backup_frequency,
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

    // Get current or defaults
    const current = db.prepare('SELECT * FROM merchant_preferences WHERE merchant_id = ?').get(merchantId) || DEFAULT_PREFS;

    // Upsert
    db.prepare(`
      INSERT INTO merchant_preferences
        (merchant_id, theme, language, timezone, reward_message,
         notify_new_client, notify_reward_ready, notify_weekly_report,
         logo_url, backup_frequency, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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


module.exports = router;
