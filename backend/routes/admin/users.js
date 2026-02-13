const express = require('express');
const { db, endUserQueries, aliasQueries } = require('../../database');
const { authenticateAdmin } = require('../../middleware/admin-auth');

const router = express.Router();
router.use(authenticateAdmin);


// ═══════════════════════════════════════════════════════
// GET /api/admin/users — List all end_users (with search)
// ═══════════════════════════════════════════════════════

router.get('/', (req, res) => {
  try {
    const { q } = req.query;

    let users;
    if (q && q.trim().length >= 2) {
      const like = `%${q.trim()}%`;
      users = db.prepare(`
        SELECT eu.*,
          (SELECT COUNT(*) FROM merchant_clients mc WHERE mc.end_user_id = eu.id) AS merchant_count
        FROM end_users eu
        WHERE eu.deleted_at IS NULL
          AND (eu.email_lower LIKE ? OR eu.phone_e164 LIKE ? OR eu.name LIKE ?)
        ORDER BY eu.created_at DESC
        LIMIT 200
      `).all(like, like, like);
    } else {
      users = db.prepare(`
        SELECT eu.*,
          (SELECT COUNT(*) FROM merchant_clients mc WHERE mc.end_user_id = eu.id) AS merchant_count
        FROM end_users eu
        WHERE eu.deleted_at IS NULL
        ORDER BY eu.created_at DESC
        LIMIT 200
      `).all();
    }

    // Strip sensitive fields
    const safe = users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      email_validated: u.email_validated,
      has_pin: !!u.pin_hash,
      has_qr: !!u.qr_token,
      is_blocked: u.is_blocked,
      merchant_count: u.merchant_count,
      created_at: u.created_at,
    }));

    res.json({ users: safe, count: safe.length });
  } catch (error) {
    console.error('Erreur liste users:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/admin/users/:id — User detail + merchant cards + aliases
// ═══════════════════════════════════════════════════════

router.get('/:id', (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const user = endUserQueries.findById.get(userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    // All merchant_clients for this user + merchant name
    const cards = db.prepare(`
      SELECT mc.*, m.business_name, m.email AS merchant_email, m.status AS merchant_status
      FROM merchant_clients mc
      JOIN merchants m ON m.id = mc.merchant_id
      WHERE mc.end_user_id = ?
      ORDER BY mc.last_visit DESC
    `).all(userId);

    // Aliases
    const aliases = aliasQueries.getByUser.all(userId);

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        email_validated: user.email_validated,
        has_pin: !!user.pin_hash,
        has_qr: !!user.qr_token,
        is_blocked: user.is_blocked,
        consent_date: user.consent_date,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
      cards: cards.map(c => ({
        id: c.id,
        merchant_id: c.merchant_id,
        business_name: c.business_name,
        merchant_email: c.merchant_email,
        merchant_status: c.merchant_status,
        points_balance: c.points_balance,
        total_spent: c.total_spent,
        visit_count: c.visit_count,
        is_blocked: c.is_blocked,
        custom_reward: c.custom_reward,
        first_visit: c.first_visit,
        last_visit: c.last_visit,
      })),
      aliases,
    });
  } catch (error) {
    console.error('Erreur detail user:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
