const express = require('express');
const { db } = require('../database');
const { authenticateStaff } = require('../middleware/auth');
const { logAudit, auditCtx } = require('../middleware/audit');
const { sendMail, escHtml } = require('../services/email');

const router = express.Router();
router.use(authenticateStaff);


// ═══════════════════════════════════════════════════════
// GET /api/announcements — Get announcements for current merchant
// Returns unread + recent read announcements
// ═══════════════════════════════════════════════════════

router.get('/', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const staffId = req.staff.id;

    // Get announcements that target 'all' OR specifically this merchant
    // Exclude expired ones
    const announcements = db.prepare(`
      SELECT a.*,
        CASE WHEN ar.id IS NOT NULL THEN 1 ELSE 0 END as is_read,
        ar.read_at
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
      ORDER BY a.created_at DESC
      LIMIT 20
    `).all(staffId, merchantId);

    const unreadCount = announcements.filter(a => !a.is_read).length;

    res.json({ announcements, unread_count: unreadCount });
  } catch (error) {
    console.error('Erreur annonces:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/announcements/:id/read — Mark as read
// ═══════════════════════════════════════════════════════

router.post('/:id/read', (req, res) => {
  try {
    const announcementId = parseInt(req.params.id);
    const staffId = req.staff.id;

    db.prepare(
      'INSERT OR IGNORE INTO announcement_reads (announcement_id, staff_id) VALUES (?, ?)'
    ).run(announcementId, staffId);

    res.json({ message: 'Marqué comme lu' });
  } catch (error) {
    console.error('Erreur mark read:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/announcements/feedback — Send feedback to admin email
// Simple: merchant writes a message → email to SUPER_ADMIN_EMAIL
// ═══════════════════════════════════════════════════════

router.post('/feedback', async (req, res) => {
  try {
    const { subject, message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message requis' });
    }
    if (message.length > 5000) {
      return res.status(400).json({ error: 'Message trop long (max 5000 caractères)' });
    }
    if (subject && subject.length > 200) {
      return res.status(400).json({ error: 'Sujet trop long (max 200 caractères)' });
    }

    const merchantId = req.staff.merchant_id;
    const merchant = db.prepare('SELECT business_name FROM merchants WHERE id = ?').get(merchantId);
    const staffEmail = req.staff.email;
    const staffName = db.prepare('SELECT display_name FROM staff_accounts WHERE id = ?').get(req.staff.id)?.display_name || staffEmail;

    const adminEmail = process.env.SUPER_ADMIN_EMAIL;
    if (!adminEmail) {
      console.error('❌ SUPER_ADMIN_EMAIL not configured');
      return res.status(500).json({ error: 'Configuration email admin manquante' });
    }

    const emailSubject = subject
      ? `[FIDDO Feedback] ${merchant?.business_name || 'Merchant'} — ${subject}`
      : `[FIDDO Feedback] ${merchant?.business_name || 'Merchant'}`;

    await sendMail({
      to: adminEmail,
      replyTo: staffEmail,
      subject: emailSubject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #1F2937; color: white; padding: 15px 20px; border-radius: 10px 10px 0 0;">
            <h2 style="margin: 0; font-size: 1.1rem;">💬 Feedback Merchant</h2>
          </div>
          <div style="background: white; padding: 20px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 10px 10px;">
            <table style="width: 100%; font-size: 0.9rem; margin-bottom: 15px;">
              <tr><td style="color: #666; padding: 4px 0;"><strong>Commerce :</strong></td><td>${escHtml(merchant?.business_name || 'N/A')} (ID: ${merchantId})</td></tr>
              <tr><td style="color: #666; padding: 4px 0;"><strong>De :</strong></td><td>${escHtml(staffName)} (${escHtml(staffEmail)})</td></tr>
              <tr><td style="color: #666; padding: 4px 0;"><strong>Rôle :</strong></td><td>${escHtml(req.staff.role)}</td></tr>
              ${subject ? `<tr><td style="color: #666; padding: 4px 0;"><strong>Sujet :</strong></td><td>${escHtml(subject)}</td></tr>` : ''}
            </table>
            <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
            <div style="white-space: pre-wrap; line-height: 1.6;">${escHtml(message.trim())}</div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
            <p style="font-size: 0.8rem; color: #999;">Répondre directement à cet email contactera le merchant.</p>
          </div>
        </div>
      `,
    });

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId,
      action: 'feedback_sent',
      details: { subject: subject || null },
    });

    res.json({ message: 'Feedback envoyé' });
  } catch (error) {
    console.error('Erreur feedback:', error);
    res.status(500).json({ error: 'Erreur lors de l\'envoi' });
  }
});


module.exports = router;
