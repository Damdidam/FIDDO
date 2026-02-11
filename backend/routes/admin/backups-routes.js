const express = require('express');
const { authenticateAdmin } = require('../../middleware/admin-auth');
const { logAudit, auditCtx } = require('../../middleware/audit');
const {
  createBackup,
  listBackups,
  getBackupPath,
  INTERVAL_HOURS,
  MAX_BACKUPS,
} = require('../../services/backup-db');

const router = express.Router();
router.use(authenticateAdmin);


// ═══════════════════════════════════════════════════════
// GET /api/admin/backups — List all backups
// ═══════════════════════════════════════════════════════

router.get('/', (req, res) => {
  try {
    const backups = listBackups();

    res.json({
      backups,
      count: backups.length,
      config: {
        intervalHours: INTERVAL_HOURS,
        maxKeep: MAX_BACKUPS,
      },
    });
  } catch (error) {
    console.error('Erreur liste backups:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/admin/backups — Create manual backup
// ═══════════════════════════════════════════════════════

router.post('/', async (req, res) => {
  try {
    const backup = await createBackup('manual');

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      action: 'backup_created',
      details: { filename: backup.filename, sizeMB: backup.sizeMB },
    });

    res.status(201).json({
      message: 'Backup créé avec succès',
      backup,
    });
  } catch (error) {
    console.error('Erreur création backup:', error);
    res.status(500).json({ error: 'Erreur lors de la création du backup' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/admin/backups/:filename/download — Download backup
// ═══════════════════════════════════════════════════════

router.get('/:filename/download', (req, res) => {
  try {
    const filepath = getBackupPath(req.params.filename);

    if (!filepath) {
      return res.status(404).json({ error: 'Backup non trouvé' });
    }

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      action: 'backup_downloaded',
      details: { filename: req.params.filename },
    });

    res.download(filepath, req.params.filename);
  } catch (error) {
    console.error('Erreur téléchargement backup:', error);
    res.status(500).json({ error: 'Erreur lors du téléchargement' });
  }
});


// ═══════════════════════════════════════════════════════
// DELETE /api/admin/backups/:filename — Delete a backup
// ═══════════════════════════════════════════════════════

router.delete('/:filename', (req, res) => {
  try {
    const filepath = getBackupPath(req.params.filename);

    if (!filepath) {
      return res.status(404).json({ error: 'Backup non trouvé' });
    }

    const fs = require('fs');
    fs.unlinkSync(filepath);

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      action: 'backup_deleted',
      details: { filename: req.params.filename },
    });

    res.json({ message: 'Backup supprimé' });
  } catch (error) {
    console.error('Erreur suppression backup:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});


module.exports = router;
