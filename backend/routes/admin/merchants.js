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


module.exports = router;
