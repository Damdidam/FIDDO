const express = require('express');
const { db } = require('../database');
const { authenticateStaff, requireRole } = require('../middleware/auth');
const { messageQueries, invoiceQueries } = require('../database-messages');

const router = express.Router();
router.use(authenticateStaff);


// ═══════════════════════════════════════════════════════
// HELPERS — Fetch announcements mapped to message format
// ═══════════════════════════════════════════════════════

const PRIORITY_TO_MSG_TYPE = { info: 'info', warning: 'maintenance', critical: 'urgent' };
const MSG_TYPE_TO_PRIORITY = { info: 'info', maintenance: 'warning', urgent: 'critical' };

/**
 * Query announcements table and return rows shaped like admin_messages.
 * Adds `source: 'announcement'` so the frontend can route mark-read correctly.
 */
function fetchAnnouncementsAsMsgs(merchantId, staffId, type, limit) {
  let sql = `
    SELECT a.id, a.title, a.content AS body,
      CASE a.priority
        WHEN 'warning'  THEN 'maintenance'
        WHEN 'critical' THEN 'urgent'
        ELSE 'info'
      END AS msg_type,
      a.target_type, a.created_at,
      CASE WHEN ar.id IS NOT NULL THEN 1 ELSE 0 END AS is_read,
      ar.read_at,
      'announcement' AS source
    FROM announcements a
    LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.staff_id = ?
    WHERE (
      a.target_type = 'all'
      OR EXISTS (
        SELECT 1 FROM announcement_targets at
        WHERE at.announcement_id = a.id AND at.merchant_id = ?
      )
    )
    AND (a.expires_at IS NULL OR a.expires_at > datetime('now'))
  `;

  const params = [staffId, merchantId];

  if (type && MSG_TYPE_TO_PRIORITY[type]) {
    sql += ` AND a.priority = ?`;
    params.push(MSG_TYPE_TO_PRIORITY[type]);
  }

  sql += ` ORDER BY a.created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Count unread announcements for a merchant/staff.
 */
function countUnreadAnnouncements(merchantId, staffId) {
  return db.prepare(`
    SELECT COUNT(*) AS count FROM announcements a
    WHERE (
      a.target_type = 'all'
      OR EXISTS (
        SELECT 1 FROM announcement_targets at
        WHERE at.announcement_id = a.id AND at.merchant_id = ?
      )
    )
    AND (a.expires_at IS NULL OR a.expires_at > datetime('now'))
    AND NOT EXISTS (
      SELECT 1 FROM announcement_reads ar
      WHERE ar.announcement_id = a.id AND ar.staff_id = ?
    )
  `).get(merchantId, staffId).count;
}


// ═══════════════════════════════════════════════════════
// GET /api/messages — Merged feed (admin_messages + announcements)
// ═══════════════════════════════════════════════════════

router.get('/', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const staffId = req.staff.id;
    const { type, limit } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 100);

    // ── 1. Messages from admin_messages ──
    let messages;
    if (type && ['info', 'maintenance', 'urgent'].includes(type)) {
      messages = messageQueries.getForMerchantByType.all(merchantId, merchantId, type, lim);
    } else {
      messages = messageQueries.getForMerchant.all(merchantId, merchantId, lim);
    }
    messages = messages.map(m => ({ ...m, source: 'message' }));

    // ── 2. Announcements ──
    const announcements = fetchAnnouncementsAsMsgs(merchantId, staffId, type, lim);

    // ── 3. Merge, sort, trim ──
    const merged = [...messages, ...announcements]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, lim);

    // ── 4. Total unread (both sources) ──
    const { count: msgUnread } = messageQueries.countUnreadForMerchant.get(merchantId, merchantId);
    const annUnread = countUnreadAnnouncements(merchantId, staffId);

    res.json({ messages: merged, unread: msgUnread + annUnread, count: merged.length });
  } catch (error) {
    console.error('Erreur liste messages:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/messages/unread-count — Badge count (both sources)
// ═══════════════════════════════════════════════════════

router.get('/unread-count', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const staffId = req.staff.id;

    const { count: msgCount } = messageQueries.countUnreadForMerchant.get(merchantId, merchantId);
    const annCount = countUnreadAnnouncements(merchantId, staffId);

    res.json({ unread: msgCount + annCount });
  } catch (error) {
    console.error('Erreur unread count:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/messages/:id/read — Mark a message as read
// (admin_messages only — announcements use /api/announcements/:id/read)
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
// POST /api/messages/read-all — Mark all as read (both sources)
// ═══════════════════════════════════════════════════════

router.post('/read-all', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const staffId = req.staff.id;

    // ── Messages ──
    const messages = messageQueries.getForMerchant.all(merchantId, merchantId, 200);
    let count = 0;
    for (const msg of messages) {
      if (!msg.is_read) {
        messageQueries.markRead.run(msg.id, merchantId);
        count++;
      }
    }

    // ── Announcements ──
    const announcements = fetchAnnouncementsAsMsgs(merchantId, staffId, null, 200);
    for (const ann of announcements) {
      if (!ann.is_read) {
        db.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, staff_id) VALUES (?, ?)')
          .run(ann.id, staffId);
        count++;
      }
    }

    res.json({ message: `${count} message(s) marqué(s) comme lu(s)`, count });
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
