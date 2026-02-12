const express = require('express');
const { db, merchantQueries } = require('../../database');
const { authenticateAdmin } = require('../../middleware/admin-auth');
const { logAudit, auditCtx } = require('../../middleware/audit');
const { messageQueries, invoiceQueries } = require('../../database-messages');

const router = express.Router();
router.use(authenticateAdmin);


// ═══════════════════════════════════════════════════════
//  MESSAGES
// ═══════════════════════════════════════════════════════


// POST /api/admin/messages — Create a new message/broadcast
// ─────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  try {
    const { title, body, msgType, targetType, targetMerchantIds } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Titre requis' });
    }
    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'Contenu requis' });
    }

    const type = ['info', 'maintenance', 'urgent'].includes(msgType) ? msgType : 'info';
    const target = targetType === 'selected' ? 'selected' : 'all';

    let targetIds = null;
    if (target === 'selected') {
      if (!targetMerchantIds || !Array.isArray(targetMerchantIds) || targetMerchantIds.length === 0) {
        return res.status(400).json({ error: 'Au moins un commerce cible requis' });
      }
      targetIds = JSON.stringify(targetMerchantIds.map(id => parseInt(id)));
    }

    const result = messageQueries.create.run(
      title.trim(),
      body.trim(),
      type,
      target,
      targetIds,
      req.admin.id
    );

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      action: 'message_created',
      targetType: 'message',
      targetId: result.lastInsertRowid,
      details: { msgType: type, target, recipientCount: target === 'all' ? 'all' : targetMerchantIds.length },
    });

    res.status(201).json({
      message: 'Message envoyé',
      id: result.lastInsertRowid,
    });
  } catch (error) {
    console.error('Erreur création message:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// GET /api/admin/messages — List all messages
// ─────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const lim = Math.min(parseInt(req.query.limit) || 50, 200);
    const messages = messageQueries.getAll.all(lim);

    // Enrich with read counts
    const stmtReadCount = db.prepare('SELECT COUNT(*) as c FROM admin_message_reads WHERE message_id = ?');
    const stmtTargetCount = db.prepare("SELECT COUNT(*) as c FROM merchants WHERE status = 'active'");
    const totalActive = stmtTargetCount.get().c;

    const enriched = messages.map(m => {
      const readCount = stmtReadCount.get(m.id).c;
      let recipientCount = totalActive;
      if (m.target_type === 'selected' && m.target_merchant_ids) {
        try { recipientCount = JSON.parse(m.target_merchant_ids).length; } catch (e) {}
      }
      return { ...m, read_count: readCount, recipient_count: recipientCount };
    });

    res.json({ messages: enriched, count: enriched.length });
  } catch (error) {
    console.error('Erreur liste messages admin:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// DELETE /api/admin/messages/:id — Delete a message
// ──────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  try {
    const msgId = parseInt(req.params.id);
    const msg = messageQueries.findById.get(msgId);
    if (!msg) return res.status(404).json({ error: 'Message non trouvé' });

    messageQueries.deleteReads.run(msgId);
    messageQueries.delete.run(msgId);

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      action: 'message_deleted',
      targetType: 'message',
      targetId: msgId,
    });

    res.json({ message: 'Message supprimé' });
  } catch (error) {
    console.error('Erreur suppression message:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
//  INVOICES
// ═══════════════════════════════════════════════════════


// POST /api/admin/messages/invoices — Upload an invoice
// ─────────────────────────────────────────────────────

router.post('/invoices', express.json({ limit: '10mb' }), (req, res) => {
  try {
    const { merchantId, month, label, amount, status, fileBase64, fileName, notes } = req.body;

    if (!merchantId) return res.status(400).json({ error: 'Commerce requis' });
    if (!month) return res.status(400).json({ error: 'Mois requis' });
    if (!label || !label.trim()) return res.status(400).json({ error: 'Libellé requis' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Montant invalide' });

    const merchant = merchantQueries.findById.get(parseInt(merchantId));
    if (!merchant) return res.status(404).json({ error: 'Commerce non trouvé' });

    const invoiceStatus = ['pending', 'paid', 'overdue'].includes(status) ? status : 'pending';

    const result = invoiceQueries.create.run(
      parseInt(merchantId),
      month,
      label.trim(),
      parseFloat(amount),
      invoiceStatus,
      fileBase64 || null,
      fileName || null,
      notes || null,
      req.admin.id
    );

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      merchantId: parseInt(merchantId),
      action: 'invoice_created',
      targetType: 'invoice',
      targetId: result.lastInsertRowid,
      details: { month, amount: parseFloat(amount), status: invoiceStatus },
    });

    res.status(201).json({
      message: 'Facture créée',
      id: result.lastInsertRowid,
    });
  } catch (error) {
    console.error('Erreur création facture:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// GET /api/admin/messages/invoices — List all invoices
// ─────────────────────────────────────────────────────

router.get('/invoices', (req, res) => {
  try {
    const lim = Math.min(parseInt(req.query.limit) || 50, 200);
    const invoices = invoiceQueries.getAll.all(lim);
    res.json({ invoices, count: invoices.length });
  } catch (error) {
    console.error('Erreur liste factures admin:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// PATCH /api/admin/messages/invoices/:id/status — Update invoice status
// ────────────────────────────────────────────────────────────────────

router.patch('/invoices/:id/status', (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    const { status } = req.body;

    if (!['pending', 'paid', 'overdue'].includes(status)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }

    const invoice = invoiceQueries.findById.get(invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Facture non trouvée' });

    invoiceQueries.updateStatus.run(status, invoiceId);

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      merchantId: invoice.merchant_id,
      action: 'invoice_status_updated',
      targetType: 'invoice',
      targetId: invoiceId,
      details: { oldStatus: invoice.status, newStatus: status },
    });

    res.json({ message: 'Statut mis à jour' });
  } catch (error) {
    console.error('Erreur update statut facture:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// DELETE /api/admin/messages/invoices/:id — Delete an invoice
// ───────────────────────────────────────────────────────────

router.delete('/invoices/:id', (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);
    const invoice = invoiceQueries.findById.get(invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Facture non trouvée' });

    invoiceQueries.delete.run(invoiceId);

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: req.admin.id,
      merchantId: invoice.merchant_id,
      action: 'invoice_deleted',
      targetType: 'invoice',
      targetId: invoiceId,
    });

    res.json({ message: 'Facture supprimée' });
  } catch (error) {
    console.error('Erreur suppression facture:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
