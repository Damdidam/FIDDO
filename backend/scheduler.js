// ═══════════════════════════════════════════════════════
// FIDDO — Scheduled Tasks (runs daily)
// ═══════════════════════════════════════════════════════

const { db, merchantQueries, voucherQueries } = require('./database');
const { sendAppReminderEmail } = require('./services/email');

/**
 * Send app download reminder to users who:
 * - Were created 3 days ago (±12h window)
 * - Have never opened the app (last_app_login IS NULL)
 * - Have a valid email
 * - Are not blocked or deleted
 */
function sendAppReminders() {
  try {
    const users = db.prepare(`
      SELECT eu.id, eu.email, eu.first_merchant_id,
             COALESCE(mc.points_balance, 0) as points_balance
      FROM end_users eu
      LEFT JOIN merchant_clients mc ON mc.end_user_id = eu.id AND mc.merchant_id = eu.first_merchant_id
      WHERE eu.deleted_at IS NULL
        AND eu.is_blocked = 0
        AND eu.email IS NOT NULL
        AND eu.last_app_login IS NULL
        AND eu.created_at BETWEEN datetime('now', '-3.5 days') AND datetime('now', '-2.5 days')
        AND COALESCE(mc.points_balance, 0) > 0
    `).all();

    if (users.length === 0) {
      console.log('📬 App reminders: no users to remind today');
      return;
    }

    console.log(`📬 Sending app reminders to ${users.length} user(s)…`);

    for (const user of users) {
      let merchantName = 'votre commerce';
      if (user.first_merchant_id) {
        const m = merchantQueries.findById.get(user.first_merchant_id);
        if (m) merchantName = m.business_name;
      }

      const appUrl = (process.env.BASE_URL || 'https://www.fiddo.be') + '/app/';
      sendAppReminderEmail(user.email, merchantName, user.points_balance || 0, appUrl);
    }

    console.log(`✅ App reminders sent to ${users.length} user(s)`);
  } catch (error) {
    console.error('❌ App reminder error:', error);
  }
}

/**
 * Expire pending gift vouchers and refund points to sender.
 * Runs every hour. If a voucher is past its expires_at and still 'pending',
 * the sender gets their points back + a gift_refund transaction is created.
 */
function refundExpiredGifts() {
  try {
    const expired = voucherQueries.findExpiredPending.all();

    if (expired.length === 0) return;

    console.log(`🎁 Refunding ${expired.length} expired gift voucher(s)…`);

    const refundTx = db.transaction(() => {
      for (const v of expired) {
        // Refund points to sender
        db.prepare(`
          UPDATE merchant_clients
          SET points_balance = points_balance + ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(v.points, v.sender_mc_id);

        // Create refund transaction
        db.prepare(`
          INSERT INTO transactions (merchant_id, merchant_client_id, staff_id, amount, points_delta, transaction_type, notes, created_at)
          VALUES (?, ?, NULL, NULL, ?, 'gift_refund', ?, datetime('now'))
        `).run(v.merchant_id, v.sender_mc_id, v.points, `Transfert expiré — ${v.points} pts remboursés (voucher ${v.token.substring(0, 8)})`);

        // Mark voucher expired
        db.prepare(`
          UPDATE point_vouchers SET status = 'expired' WHERE id = ?
        `).run(v.id);
      }
    });

    refundTx();
    console.log(`✅ ${expired.length} gift voucher(s) expired & refunded`);
  } catch (error) {
    console.error('❌ Gift refund error:', error);
  }
}

/**
 * Start the daily scheduler.
 * Runs at 10:00 AM every day (Belgian business hours).
 */
function startScheduler() {
  // Run once on startup (after 30s delay to let server boot)
  setTimeout(() => {
    console.log('⏰ Scheduler: initial check…');
    sendAppReminders();
    refundExpiredGifts();
  }, 30000);

  // App reminders — every 24 hours
  setInterval(() => {
    console.log('⏰ Scheduler: daily check…');
    sendAppReminders();
  }, 24 * 60 * 60 * 1000);

  // Gift refunds — every hour
  setInterval(() => {
    refundExpiredGifts();
  }, 60 * 60 * 1000);

  console.log('⏰ Scheduler started (daily app reminders + hourly gift refunds)');
}

module.exports = { startScheduler, sendAppReminders, refundExpiredGifts };
