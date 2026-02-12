const express = require('express');
const { authenticateStaff, requireRole } = require('../middleware/auth');
const { messageQueries, invoiceQueries } = require('../database-messages');

const router = express.Router();
router.use(authenticateStaff);


// ═══════════════════════════════════════════════════════
// GET /api/messages — List messages for current merchant
// ═══════════════════════════════════════════════════════

router.get('/', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { type, limit } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 100);

    let messages;
    if (type && ['info', 'maintenance', 'urgent'].includes(type)) {
      messages = messageQueries.getForMerchantByType.all(merchantId, merchantId, type, lim);
    } else {
      messages = messageQueries.getForMerchant.all(merchantId, merchantId, lim);
    }

    const { count: unread } = messageQueries.countUnreadForMerchant.get(merchantId, merchantId);

    res.json({ messages, unread, count: messages.length });
  } catch (error) {
    console.error('Erreur liste messages:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/messages/unread-count — Badge count
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
// POST /api/messages/:id/read — Mark message as read
// ═══════════════════════════════════════════════════════

router.post('/:id/read', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const messageId = parseInt(req.params.id);

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
// POST /api/messages/read-all — Mark all as read
// ═══════════════════════════════════════════════════════

router.post('/read-all', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const messages = messageQueries.getForMerchant.all(merchantId, merchantId, 200);

    for (const msg of messages) {
      if (!msg.is_read) {
        messageQueries.markRead.run(msg.id, merchantId);
      }
    }

    res.json({ message: 'Tous les messages marqués comme lus' });
  } catch (error) {
    console.error('Erreur read-all:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/messages/invoices — List invoices for current merchant
// ═══════════════════════════════════════════════════════

router.get('/invoices', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const lim = Math.min(parseInt(req.query.limit) || 50, 100);
    const invoices = invoiceQueries.getByMerchant.all(merchantId, lim);

    res.json({ invoices, count: invoices.length });
  } catch (error) {
    console.error('Erreur liste factures:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/messages/invoices/:id/download — Download invoice PDF
// ═══════════════════════════════════════════════════════

router.get('/invoices/:id/download', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const invoiceId = parseInt(req.params.id);

    const invoice = invoiceQueries.findByIdAndMerchant.get(invoiceId, merchantId);
    if (!invoice) {
      return res.status(404).json({ error: 'Facture non trouvée' });
    }
    if (!invoice.file_data) {
      return res.status(404).json({ error: 'Fichier non disponible' });
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
