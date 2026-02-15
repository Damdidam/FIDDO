const express = require('express');
const { db } = require('../database');
const { authenticateStaff, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateStaff);
router.use(requireRole('owner', 'manager'));


// ═══════════════════════════════════════════════════════
// GET /api/dashboard/stats?from=&to=
// Aggregated stats for a given period.
// Dates are ISO strings (YYYY-MM-DD HH:mm:ss).
// ═══════════════════════════════════════════════════════

router.get('/stats', (req, res) => {
  try {
    const mid = req.staff.merchant_id;
    const { from, to } = req.query;

    // Build date clauses
    let txDateClause = '';
    let mcDateClause = '';
    const txParams = [mid];
    const mcParams = [mid];

    if (from) {
      txDateClause += ' AND t.created_at >= ?';
      mcDateClause += ' AND mc.created_at >= ?';
      txParams.push(from);
      mcParams.push(from);
    }
    if (to) {
      txDateClause += ' AND t.created_at <= ?';
      mcDateClause += ' AND mc.created_at <= ?';
      txParams.push(to);
      mcParams.push(to);
    }

    // ── Visits (credit transactions = 1 visit each) ──
    const visits = db.prepare(`
      SELECT COUNT(*) as c FROM transactions t
      WHERE t.merchant_id = ? AND t.transaction_type = 'credit' ${txDateClause}
    `).get(...txParams).c;

    // ── Points distributed (sum of positive deltas from credits) ──
    const pointsOut = db.prepare(`
      SELECT COALESCE(SUM(t.points_delta), 0) as s FROM transactions t
      WHERE t.merchant_id = ? AND t.transaction_type = 'credit' ${txDateClause}
    `).get(...txParams).s;

    // ── Rewards given ──
    const rewards = db.prepare(`
      SELECT COUNT(*) as c FROM transactions t
      WHERE t.merchant_id = ? AND t.transaction_type = 'reward' ${txDateClause}
    `).get(...txParams).c;

    // ── Points redeemed (absolute value of reward deltas) ──
    const pointsRedeemed = db.prepare(`
      SELECT COALESCE(SUM(ABS(t.points_delta)), 0) as s FROM transactions t
      WHERE t.merchant_id = ? AND t.transaction_type = 'reward' ${txDateClause}
    `).get(...txParams).s;

    // ── New clients (merchant_clients created in period) ──
    const newClients = db.prepare(`
      SELECT COUNT(*) as c FROM merchant_clients mc
      WHERE mc.merchant_id = ? ${mcDateClause}
    `).get(...mcParams).c;

    // ── Active clients (visited in period) ──
    let activeClients;
    if (from || to) {
      let activeClause = '';
      const activeParams = [mid];
      if (from) { activeClause += ' AND mc.last_visit >= ?'; activeParams.push(from); }
      if (to) { activeClause += ' AND mc.last_visit <= ?'; activeParams.push(to); }
      activeClients = db.prepare(`
        SELECT COUNT(*) as c FROM merchant_clients mc
        JOIN end_users eu ON mc.end_user_id = eu.id
        WHERE mc.merchant_id = ? AND eu.deleted_at IS NULL ${activeClause}
      `).get(...activeParams).c;
    } else {
      activeClients = db.prepare(`
        SELECT COUNT(*) as c FROM merchant_clients mc
        JOIN end_users eu ON mc.end_user_id = eu.id
        WHERE mc.merchant_id = ? AND eu.deleted_at IS NULL
      `).get(mid).c;
    }

    // ── Total clients (always, for context) ──
    const totalClients = db.prepare(`
      SELECT COUNT(*) as c FROM merchant_clients mc
      JOIN end_users eu ON mc.end_user_id = eu.id
      WHERE mc.merchant_id = ? AND eu.deleted_at IS NULL
    `).get(mid).c;

    res.json({
      visits,
      pointsOut,
      pointsRedeemed,
      rewards,
      newClients,
      activeClients,
      totalClients,
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/dashboard/activity?type=&from=&to=&limit=&offset=
// Transaction feed with filtering + pagination.
// type: credit|reward|adjustment|merge (optional)
// limit=0 → count only (no rows returned)
// ═══════════════════════════════════════════════════════

router.get('/activity', (req, res) => {
  try {
    const mid = req.staff.merchant_id;
    const { type, from, to } = req.query;

    // limit=0 is valid (count-only mode)
    const rawLimit = parseInt(req.query.limit);
    const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 0), 200);
    const offset = parseInt(req.query.offset) || 0;

    let where = 'WHERE t.merchant_id = ?';
    const params = [mid];

    if (type && ['credit', 'reward', 'adjustment', 'merge', 'gift_out', 'gift_in', 'gift_refund', 'gift'].includes(type)) {
      if (type === 'gift') {
        where += ' AND t.transaction_type IN (?, ?, ?)';
        params.push('gift_out', 'gift_in', 'gift_refund');
      } else {
        where += ' AND t.transaction_type = ?';
        params.push(type);
      }
    }
    if (from) {
      where += ' AND t.created_at >= ?';
      params.push(from);
    }
    if (to) {
      where += ' AND t.created_at <= ?';
      params.push(to);
    }

    // Count total
    const total = db.prepare(`
      SELECT COUNT(*) as c FROM transactions t ${where}
    `).get(...params).c;

    // Count-only mode
    if (limit === 0) {
      return res.json({ transactions: [], total, limit: 0, offset: 0, hasMore: total > 0 });
    }

    // Fetch page
    const rows = db.prepare(`
      SELECT t.id, t.amount, t.points_delta, t.transaction_type, t.source, t.notes, t.created_at,
             eu.email AS client_email, eu.phone AS client_phone, eu.name AS client_name,
             sa.display_name AS staff_name,
             mc.points_balance AS client_balance
      FROM transactions t
      JOIN merchant_clients mc ON t.merchant_client_id = mc.id
      JOIN end_users eu ON mc.end_user_id = eu.id
      LEFT JOIN staff_accounts sa ON t.staff_id = sa.id
      ${where}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // Enrich gift transactions with counterpart info
    const giftRows = rows.filter(r => r.transaction_type === 'gift_out' || r.transaction_type === 'gift_in');
    for (const row of giftRows) {
      const match = row.notes && row.notes.match(/voucher\s+(\S+)/);
      if (!match) continue;
      const voucher = db.prepare(`
        SELECT pv.status,
               sender_eu.email AS sender_email, sender_eu.name AS sender_name, sender_eu.phone AS sender_phone,
               claimer_eu.email AS claimer_email, claimer_eu.name AS claimer_name, claimer_eu.phone AS claimer_phone
        FROM point_vouchers pv
        LEFT JOIN end_users sender_eu ON pv.sender_eu_id = sender_eu.id
        LEFT JOIN end_users claimer_eu ON pv.claimer_eu_id = claimer_eu.id
        WHERE pv.token LIKE ? AND pv.merchant_id = ?
        LIMIT 1
      `).get(match[1] + '%', mid);
      if (!voucher) continue;
      if (row.transaction_type === 'gift_out') {
        row.gift_to = voucher.claimer_name || voucher.claimer_email || voucher.claimer_phone || null;
        row.gift_status = voucher.status; // pending, claimed, expired
      } else {
        row.gift_from = voucher.sender_name || voucher.sender_email || voucher.sender_phone || '?';
      }
    }

    res.json({
      transactions: rows,
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  } catch (error) {
    console.error('Dashboard activity error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
