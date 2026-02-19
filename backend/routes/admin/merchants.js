const express = require('express');
const { db, merchantQueries, staffQueries } = require('../../database');
const { authenticateAdmin } = require('../../middleware/admin-auth');
const { logAudit, auditCtx } = require('../../middleware/audit');
const { sendMerchantValidatedEmail, sendMerchantRejectedEmail } = require('../../services/email');

const router = express.Router();
router.use(authenticateAdmin);


// ═══════════════════════════════════════════════════════
// GET /api/admin/merchants — List all merchants
// ═══════════════════════════════════════════════════════

router.get('/', (req, res) => {
  try {
    const { status } = req.query;
    const merchants = status
      ? merchantQueries.getByStatus.all(status)
      : merchantQueries.getAll.all();

    // Enrich with counts
    const stmtClients = db.prepare('SELECT COUNT(*) as count FROM merchant_clients WHERE merchant_id = ?');
    const stmtStaff = db.prepare('SELECT COUNT(*) as count FROM staff_accounts WHERE merchant_id = ?');
    const stmtOwner = db.prepare("SELECT email, display_name FROM staff_accounts WHERE merchant_id = ? AND role = 'owner' LIMIT 1");

    const enriched = merchants.map(m => ({
      ...m,
      client_count: stmtClients.get(m.id).count,
      staff_count: stmtStaff.get(m.id).count,
      owner_email: stmtOwner.get(m.id)?.email,
      owner_name: stmtOwner.get(m.id)?.display_name,
    }));

    res.json({ merchants: enriched, count: enriched.length });
  } catch (error) {
    console.error('Erreur liste merchants:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/admin/merchants/stats/global — Platform stats
// ═══════════════════════════════════════════════════════

router.get('/stats/global', (req, res) => {
  try {
    const stats = {
      merchants: {
        total: db.prepare('SELECT COUNT(*) as c FROM merchants').get().c,
        active: db.prepare("SELECT COUNT(*) as c FROM merchants WHERE status = 'active'").get().c,
        pending: db.prepare("SELECT COUNT(*) as c FROM merchants WHERE status = 'pending'").get().c,
      },
      endUsers: db.prepare('SELECT COUNT(*) as c FROM end_users WHERE deleted_at IS NULL').get().c,
      transactions: db.prepare('SELECT COUNT(*) as c FROM transactions').get().c,
      revenue: db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE transaction_type = 'credit'").get().t,
    };

    res.json(stats);
  } catch (error) {
    console.error('Erreur stats globales:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/admin/merchants/:id — Merchant details
// ═══════════════════════════════════════════════════════

router.get('/:id', (req, res) => {
  try {
    const merchant = merchantQueries.findById.get(parseInt(req.params.id));
    if (!merchant) {
      return res.status(404).json({ error: 'Commerce non trouvé' });
    }

    const staff = staffQueries.getByMerchant.all(merchant.id);

    const stats = {
      clients: db.prepare('SELECT COUNT(*) as c FROM merchant_clients WHERE merchant_id = ?').get(merchant.id).c,
      revenue: db.prepare('SELECT COALESCE(SUM(total_spent), 0) as t FROM merchant_clients WHERE merchant_id = ?').get(merchant.id).t,
      transactions: db.prepare('SELECT COUNT(*) as c FROM transactions WHERE merchant_id = ?').get(merchant.id).c,
    };

    res.json({ merchant, staff, stats });
  } catch (error) {
    console.error('Erreur détails merchant:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/admin/merchants/:id/validate — Activate merchant
// ═══════════════════════════════════════════════════════

router.post('/:id/validate', (req, res) => {
  try {
    const merchantId = parseInt(req.params.id);
    const merchant = merchantQueries.findById.get(merchantId);

    if (!merchant) return res.status(404).json({ error: 'Commerce non trouvé' });
    if (merchant.status !== 'pending') {
      return res.status(400).json({ error: `Impossible de valider un commerce en status "${merchant.status}"` });
    }

    // Activate merchant
    merchantQueries.updateStatus.run('active', req.admin.id, merchantId);

    // Activate owner staff accounts
    staffQueries.activateOwnersByMerchant.run(merchantId);

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      merchantId,
      action: 'merchant_validated',
      targetType: 'merchant',
      targetId: merchantId,
    });

    // Fire-and-forget email
    const owner = db.prepare("SELECT email FROM staff_accounts WHERE merchant_id = ? AND role = 'owner' LIMIT 1").get(merchantId);
    if (owner) {
      sendMerchantValidatedEmail(owner.email, merchant.business_name);
    }

    res.json({ message: 'Commerce validé et activé' });
  } catch (error) {
    console.error('Erreur validation:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/admin/merchants/:id/reject — Reject merchant
// ═══════════════════════════════════════════════════════

router.post('/:id/reject', (req, res) => {
  try {
    const merchantId = parseInt(req.params.id);
    const { reason } = req.body;

    const merchant = merchantQueries.findById.get(merchantId);
    if (!merchant) return res.status(404).json({ error: 'Commerce non trouvé' });
    if (merchant.status !== 'pending') {
      return res.status(400).json({ error: `Impossible de refuser un commerce en status "${merchant.status}"` });
    }

    merchantQueries.reject.run(reason || 'Aucune raison spécifiée', req.admin.id, merchantId);

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      merchantId,
      action: 'merchant_rejected',
      targetType: 'merchant',
      targetId: merchantId,
      details: { reason },
    });

    // Fire-and-forget email
    const owner = db.prepare("SELECT email FROM staff_accounts WHERE merchant_id = ? AND role = 'owner' LIMIT 1").get(merchantId);
    if (owner) {
      sendMerchantRejectedEmail(owner.email, merchant.business_name, reason);
    }

    res.json({ message: 'Commerce refusé' });
  } catch (error) {
    console.error('Erreur refus:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/admin/merchants/:id/suspend — Suspend merchant
// ═══════════════════════════════════════════════════════

router.post('/:id/suspend', (req, res) => {
  try {
    const merchantId = parseInt(req.params.id);
    const { reason } = req.body;

    const merchant = merchantQueries.findById.get(merchantId);
    if (!merchant) return res.status(404).json({ error: 'Commerce non trouvé' });
    if (merchant.status !== 'active') {
      return res.status(400).json({ error: 'Seul un commerce actif peut être suspendu' });
    }

    merchantQueries.suspend.run(merchantId);
    staffQueries.deactivateAllByMerchant.run(merchantId);

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      merchantId,
      action: 'merchant_suspended',
      targetType: 'merchant',
      targetId: merchantId,
      details: { reason },
    });

    res.json({ message: 'Commerce suspendu' });
  } catch (error) {
    console.error('Erreur suspension:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/admin/merchants/:id/reactivate — Reactivate merchant
// ═══════════════════════════════════════════════════════

router.post('/:id/reactivate', (req, res) => {
  try {
    const merchantId = parseInt(req.params.id);

    const merchant = merchantQueries.findById.get(merchantId);
    if (!merchant) return res.status(404).json({ error: 'Commerce non trouvé' });
    if (merchant.status !== 'suspended') {
      return res.status(400).json({ error: 'Seul un commerce suspendu peut être réactivé' });
    }

    merchantQueries.reactivate.run(merchantId);
    staffQueries.activateOwnersByMerchant.run(merchantId);

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      merchantId,
      action: 'merchant_reactivated',
      targetType: 'merchant',
      targetId: merchantId,
    });

    res.json({ message: 'Commerce réactivé' });
  } catch (error) {
    console.error('Erreur réactivation:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/admin/merchants/bulk-delete — Hard delete multiple merchants
// ═══════════════════════════════════════════════════════

router.post('/bulk-delete', (req, res) => {
  try {
    const { merchantIds } = req.body;

    if (!Array.isArray(merchantIds) || merchantIds.length === 0) {
      return res.status(400).json({ error: 'Liste d\'IDs requise' });
    }

    if (merchantIds.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 commerces par lot' });
    }

    const ids = merchantIds.map(id => parseInt(id)).filter(id => !isNaN(id) && id > 0);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'Aucun ID valide' });
    }

    const results = { deleted: 0, skipped: 0, details: [] };

    const run = db.transaction(() => {
      for (const id of ids) {
        const merchant = merchantQueries.findById.get(id);
        if (!merchant) {
          results.skipped++;
          results.details.push({ id, status: 'not_found' });
          continue;
        }

        // Get all merchant_clients for this merchant
        const cards = db.prepare('SELECT id FROM merchant_clients WHERE end_user_id IS NOT NULL AND merchant_id = ?').all(id);
        const cardIds = db.prepare('SELECT id FROM merchant_clients WHERE merchant_id = ?').all(id).map(c => c.id);

        // Get all staff for this merchant
        const staffIds = db.prepare('SELECT id FROM staff_accounts WHERE merchant_id = ?').all(id).map(s => s.id);

        // Delete transactions
        if (cardIds.length > 0) {
          const ph = cardIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM transactions WHERE merchant_client_id IN (${ph})`).run(...cardIds);
        }
        db.prepare('DELETE FROM transactions WHERE merchant_id = ?').run(id);

        // Delete point vouchers
        if (cardIds.length > 0) {
          const ph = cardIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM point_vouchers WHERE sender_mc_id IN (${ph}) OR claimer_mc_id IN (${ph})`).run(...cardIds, ...cardIds);
        }

        // Delete merchant_clients
        db.prepare('DELETE FROM merchant_clients WHERE merchant_id = ?').run(id);

        // Delete announcement_reads for staff of this merchant
        if (staffIds.length > 0) {
          const ph = staffIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM announcement_reads WHERE staff_id IN (${ph})`).run(...staffIds);
        }

        // Delete announcement_targets
        try { db.prepare('DELETE FROM announcement_targets WHERE merchant_id = ?').run(id); } catch (e) { /* */ }

        // Delete admin_message_reads
        try { db.prepare('DELETE FROM admin_message_reads WHERE merchant_id = ?').run(id); } catch (e) { /* */ }

        // Delete merchant_invoices
        try { db.prepare('DELETE FROM merchant_invoices WHERE merchant_id = ?').run(id); } catch (e) { /* */ }

        // Delete staff accounts
        db.prepare('DELETE FROM staff_accounts WHERE merchant_id = ?').run(id);

        // Delete merchant preferences
        try { db.prepare('DELETE FROM merchant_preferences WHERE merchant_id = ?').run(id); } catch (e) { /* */ }

        // Delete poll sessions
        try { db.prepare('DELETE FROM poll_sessions WHERE merchant_id = ?').run(id); } catch (e) { /* */ }

        // Delete audit logs for this merchant
        db.prepare('DELETE FROM audit_logs WHERE merchant_id = ?').run(id);

        // Delete the merchant
        db.prepare('DELETE FROM merchants WHERE id = ?').run(id);

        results.deleted++;
        results.details.push({ id, name: merchant.business_name, status: 'deleted' });
      }

      return results;
    });

    const outcome = run();

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin', actorId: req.admin.id, merchantId: null,
      action: 'bulk_hard_delete_merchants',
      targetType: 'merchant', targetId: null,
      details: { count: outcome.deleted, ids },
    });

    res.json({
      message: `${outcome.deleted} commerce(s) supprimé(s) définitivement`,
      ...outcome,
    });
  } catch (error) {
    console.error('Erreur bulk delete merchants:', error);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});


module.exports = router;
