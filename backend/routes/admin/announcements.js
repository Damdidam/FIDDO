const express = require('express');
const { db, merchantQueries } = require('../../database');
const { authenticateAdmin } = require('../../middleware/admin-auth');
const { logAudit, auditCtx } = require('../../middleware/audit');

const router = express.Router();
router.use(authenticateAdmin);


// ═══════════════════════════════════════════════════════
// PREPARED STATEMENTS (local — not in database.js to keep it clean)
// ═══════════════════════════════════════════════════════

const announcementQueries = {
  create: db.prepare(`
    INSERT INTO announcements (title, content, target_type, priority, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  findById: db.prepare('SELECT * FROM announcements WHERE id = ?'),
  getAll: db.prepare('SELECT a.*, sa.name as author_name FROM announcements a JOIN super_admins sa ON a.created_by = sa.id ORDER BY a.created_at DESC'),
  update: db.prepare('UPDATE announcements SET title = ?, content = ?, target_type = ?, priority = ?, expires_at = ? WHERE id = ?'),
  delete: db.prepare('DELETE FROM announcements WHERE id = ?'),
};

const targetQueries = {
  add: db.prepare('INSERT OR IGNORE INTO announcement_targets (announcement_id, merchant_id) VALUES (?, ?)'),
  deleteByAnnouncement: db.prepare('DELETE FROM announcement_targets WHERE announcement_id = ?'),
  getByAnnouncement: db.prepare(`
    SELECT at.merchant_id, m.business_name
    FROM announcement_targets at
    JOIN merchants m ON at.merchant_id = m.id
    WHERE at.announcement_id = ?
  `),
};

const readQueries = {
  countByAnnouncement: db.prepare(`
    SELECT COUNT(DISTINCT ar.staff_id) as read_count
    FROM announcement_reads ar
    WHERE ar.announcement_id = ?
  `),
  deleteByAnnouncement: db.prepare('DELETE FROM announcement_reads WHERE announcement_id = ?'),
};


// ═══════════════════════════════════════════════════════
// GET /api/admin/announcements/merchants — List active merchants for targeting
// (Must be BEFORE /:id to avoid route collision)
// ═══════════════════════════════════════════════════════

router.get('/merchants', (req, res) => {
  try {
    const merchants = db.prepare("SELECT id, business_name FROM merchants WHERE status = 'active' ORDER BY business_name").all();
    res.json({ merchants });
  } catch (error) {
    console.error('Erreur liste merchants:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/admin/announcements — List all
// ═══════════════════════════════════════════════════════

router.get('/', (req, res) => {
  try {
    const announcements = announcementQueries.getAll.all();

    const enriched = announcements.map(a => {
      const targets = a.target_type === 'selected'
        ? targetQueries.getByAnnouncement.all(a.id)
        : [];
      const readCount = readQueries.countByAnnouncement.get(a.id).read_count;

      return { ...a, targets, read_count: readCount };
    });

    res.json({ announcements: enriched, count: enriched.length });
  } catch (error) {
    console.error('Erreur liste annonces:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/admin/announcements — Create
// ═══════════════════════════════════════════════════════

router.post('/', (req, res) => {
  try {
    const { title, content, targetType, priority, merchantIds, expiresAt } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: 'Titre et contenu requis' });
    }

    const type = targetType || 'all';
    const prio = priority || 'info';

    const run = db.transaction(() => {
      const result = announcementQueries.create.run(
        title.trim(),
        content.trim(),
        type,
        prio,
        req.admin.id,
        expiresAt || null
      );

      const announcementId = result.lastInsertRowid;

      // Add targets if selected
      if (type === 'selected' && Array.isArray(merchantIds) && merchantIds.length > 0) {
        for (const mid of merchantIds) {
          targetQueries.add.run(announcementId, parseInt(mid));
        }
      }

      return announcementId;
    })();

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      action: 'announcement_created',
      targetType: 'announcement',
      targetId: run,
      details: { title, targetType: type, priority: prio },
    });

    res.status(201).json({ message: 'Annonce créée', id: run });
  } catch (error) {
    console.error('Erreur création annonce:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// PUT /api/admin/announcements/:id — Update
// ═══════════════════════════════════════════════════════

router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = announcementQueries.findById.get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Annonce non trouvée' });
    }

    const { title, content, targetType, priority, merchantIds, expiresAt } = req.body;

    const type = targetType || existing.target_type;
    const prio = priority || existing.priority;

    db.transaction(() => {
      announcementQueries.update.run(
        (title || existing.title).trim(),
        (content || existing.content).trim(),
        type,
        prio,
        expiresAt !== undefined ? expiresAt : existing.expires_at,
        id
      );

      // Replace targets
      targetQueries.deleteByAnnouncement.run(id);
      if (type === 'selected' && Array.isArray(merchantIds) && merchantIds.length > 0) {
        for (const mid of merchantIds) {
          targetQueries.add.run(id, parseInt(mid));
        }
      }
    })();

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      action: 'announcement_updated',
      targetType: 'announcement',
      targetId: id,
    });

    res.json({ message: 'Annonce mise à jour' });
  } catch (error) {
    console.error('Erreur mise à jour annonce:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// DELETE /api/admin/announcements/:id — Delete
// ═══════════════════════════════════════════════════════

router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = announcementQueries.findById.get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Annonce non trouvée' });
    }

    db.transaction(() => {
      readQueries.deleteByAnnouncement.run(id);
      targetQueries.deleteByAnnouncement.run(id);
      announcementQueries.delete.run(id);
    })();

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      action: 'announcement_deleted',
      targetType: 'announcement',
      targetId: id,
    });

    res.json({ message: 'Annonce supprimée' });
  } catch (error) {
    console.error('Erreur suppression annonce:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});



module.exports = router;
