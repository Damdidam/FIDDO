const express = require('express');
const { authenticateStaff } = require('../middleware/auth');
const { messageQueries, invoiceQueries } = require('../database-messages');

const router = express.Router();

// All routes require staff authentication
router.use(authenticateStaff);


// ═══════════════════════════════════════════════════════
// GET /api/messages — List messages for this merchant
// Optional: ?type=info|maintenance|urgent
// ═══════════════════════════════════════════════════════

router.get('/', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { type } = req.query;
    const limit = 50;

    let messages;
    if (type && ['info', 'maintenance', 'urgent'].includes(type)) {
      messages = messageQueries.getForMerchantByType.all(merchantId, merchantId, type, limit);
    } else {
      messages = messageQueries.getForMerchant.all(merchantId, merchantId, limit);
    }

    const unread = messageQueries.countUnreadForMerchant.get(merchantId, merchantId).count;

    res.json({ messages, unread });
  } catch (error) {
    console.error('Erreur liste messages:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/messages/unread-count — Badge count for navbar
// ═══════════════════════════════════════════════════════

router.get('/unread-count', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { count } = messageQueries.countUnreadForMerchant.get(merchantId, merchantId);
    res.json({ unread: count });
  } catch (error) {
    console.error('Erreur unread count:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/messages/:id/read — Mark a single message as read
// ═══════════════════════════════════════════════════════

router.post('/:id/read', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const messageId = parseInt(req.params.id);

    if (!messageId) {
      return res.status(400).json({ error: 'ID message invalide' });
    }

    // Verify message exists and is visible to this merchant
    const msg = messageQueries.findById.get(messageId);
    if (!msg) {
      return res.status(404).json({ error: 'Message non trouvé' });
    }

    messageQueries.markRead.run(messageId, merchantId);
    res.json({ message: 'Marqué comme lu' });
  } catch (error) {
    console.error('Erreur mark read:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/messages/read-all — Mark all messages as read
// ═══════════════════════════════════════════════════════

router.post('/read-all', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;

    // Get all visible unread messages for this merchant
    const messages = messageQueries.getForMerchant.all(merchantId, merchantId, 500);
    const unread = messages.filter(m => !m.is_read);

    for (const msg of unread) {
      messageQueries.markRead.run(msg.id, merchantId);
    }

    res.json({ message: 'Tous les messages marqués comme lus', count: unread.length });
  } catch (error) {
    console.error('Erreur read-all:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/messages/invoices — List invoices for this merchant
// ═══════════════════════════════════════════════════════

router.get('/invoices', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const invoices = invoiceQueries.getByMerchant.all(merchantId, 100);
    const { count } = invoiceQueries.countByMerchant.get(merchantId);

    // Compute stats
    const totalAmount = invoices.reduce((s, i) => s + i.amount, 0);
    const pending = invoices.filter(i => i.status === 'pending').length;
    const paid = invoices.filter(i => i.status === 'paid').length;
    const overdue = invoices.filter(i => i.status === 'overdue').length;

    res.json({
      invoices,
      count,
      stats: { totalAmount, pending, paid, overdue },
    });
  } catch (error) {
    console.error('Erreur liste factures:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/messages/invoices/:id/download — Download invoice PDF
// ═══════════════════════════════════════════════════════

router.get('/invoices/:id/download', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const invoiceId = parseInt(req.params.id);

    const invoice = invoiceQueries.findByIdAndMerchant.get(invoiceId, merchantId);
    if (!invoice) {
      return res.status(404).json({ error: 'Facture non trouvée' });
    }

    if (!invoice.file_data) {
      return res.status(404).json({ error: 'Aucun fichier attaché à cette facture' });
    }

    const buffer = Buffer.from(invoice.file_data, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.file_name || 'facture.pdf'}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Erreur download facture:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
