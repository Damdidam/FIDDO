const express = require('express');
const { db, endUserQueries, aliasQueries, merchantClientQueries, transactionQueries, mergeQueries } = require('../../database');
const { authenticateAdmin } = require('../../middleware/admin-auth');
const { logAudit, auditCtx } = require('../../middleware/audit');
const { sendGlobalMergeNotificationEmail } = require('../../services/email');

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
// GET /api/admin/users/:id — User detail + cards + aliases
// ═══════════════════════════════════════════════════════

router.get('/:id', (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const user = endUserQueries.findById.get(userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const cards = db.prepare(`
      SELECT mc.*, m.business_name, m.email AS merchant_email, m.status AS merchant_status
      FROM merchant_clients mc
      JOIN merchants m ON m.id = mc.merchant_id
      WHERE mc.end_user_id = ?
      ORDER BY mc.last_visit DESC
    `).all(userId);

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
        notes_private: c.notes_private,
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


// ═══════════════════════════════════════════════════════
// GET /api/admin/users/:id/merge-preview?sourceId=XX
// Preview: shows exactly what will happen, commerce by commerce
// ═══════════════════════════════════════════════════════

router.get('/:id/merge-preview', (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const sourceId = parseInt(req.query.sourceId);

    if (!sourceId || sourceId === targetId) {
      return res.status(400).json({ error: 'sourceId invalide' });
    }

    const target = endUserQueries.findById.get(targetId);
    const source = endUserQueries.findById.get(sourceId);
    if (!target) return res.status(404).json({ error: 'Utilisateur cible non trouvé' });
    if (!source) return res.status(404).json({ error: 'Utilisateur source non trouvé' });

    const sourceCards = db.prepare(`
      SELECT mc.*, m.business_name
      FROM merchant_clients mc JOIN merchants m ON m.id = mc.merchant_id
      WHERE mc.end_user_id = ?
    `).all(sourceId);

    const targetCards = db.prepare(`
      SELECT mc.*, m.business_name
      FROM merchant_clients mc JOIN merchants m ON m.id = mc.merchant_id
      WHERE mc.end_user_id = ?
    `).all(targetId);

    const targetMerchantIds = new Set(targetCards.map(c => c.merchant_id));

    const actions = sourceCards.map(sc => {
      const hasConflict = targetMerchantIds.has(sc.merchant_id);
      const tc = hasConflict ? targetCards.find(c => c.merchant_id === sc.merchant_id) : null;

      return {
        merchant_id: sc.merchant_id,
        business_name: sc.business_name,
        action: hasConflict ? 'merge' : 'transfer',
        source: { points: sc.points_balance, visits: sc.visit_count, spent: sc.total_spent },
        target_before: tc ? { points: tc.points_balance, visits: tc.visit_count, spent: tc.total_spent } : null,
        target_after: tc
          ? { points: tc.points_balance + sc.points_balance, visits: tc.visit_count + sc.visit_count, spent: tc.total_spent + sc.total_spent }
          : { points: sc.points_balance, visits: sc.visit_count, spent: sc.total_spent },
      };
    });

    const newAliases = [];
    if (source.email_lower) newAliases.push({ type: 'email', value: source.email_lower });
    if (source.phone_e164) newAliases.push({ type: 'phone', value: source.phone_e164 });

    res.json({
      source: { id: source.id, name: source.name, email: source.email, phone: source.phone },
      target: { id: target.id, name: target.name, email: target.email, phone: target.phone },
      actions,
      newAliases,
      summary: {
        commerces_affected: actions.length,
        cards_merged: actions.filter(a => a.action === 'merge').length,
        cards_transferred: actions.filter(a => a.action === 'transfer').length,
      },
    });
  } catch (error) {
    console.error('Erreur merge preview:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/admin/users/:id/merge — Global merge (super admin only)
// Target = :id (kept), Source = body.sourceId (absorbed)
// ═══════════════════════════════════════════════════════

router.post('/:id/merge', (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const { sourceId, reason } = req.body;

    if (!sourceId || sourceId === targetId) {
      return res.status(400).json({ error: 'sourceId invalide' });
    }

    const target = endUserQueries.findById.get(targetId);
    const source = endUserQueries.findById.get(sourceId);
    if (!target) return res.status(404).json({ error: 'Utilisateur cible non trouvé' });
    if (!source) return res.status(404).json({ error: 'Utilisateur source non trouvé' });

    const mergeNote = reason || 'Fusion globale par le super admin';

    const run = db.transaction(() => {
      const sourceCards = db.prepare(`
        SELECT mc.*, m.business_name
        FROM merchant_clients mc JOIN merchants m ON m.id = mc.merchant_id
        WHERE mc.end_user_id = ?
      `).all(sourceId);

      const results = { merged: [], transferred: [] };

      for (const sc of sourceCards) {
        const tc = merchantClientQueries.find.get(sc.merchant_id, targetId);

        if (tc) {
          // ── MERGE: both have a card at this merchant ──
          merchantClientQueries.mergeStats.run(
            sc.points_balance, sc.total_spent, sc.visit_count,
            sc.first_visit, sc.last_visit,
            tc.id
          );

          // Concat notes
          if (sc.notes_private) {
            const combined = tc.notes_private
              ? `${tc.notes_private}\n--- Fusionné (${source.name || source.email || '#' + sourceId}) ---\n${sc.notes_private}`
              : sc.notes_private;
            db.prepare("UPDATE merchant_clients SET notes_private = ?, updated_at = datetime('now') WHERE id = ?")
              .run(combined, tc.id);
          }

          // Reassign transactions
          transactionQueries.reassignClient.run(tc.id, sc.id);

          // Merge trace visible in merchant history
          transactionQueries.create.run(
            sc.merchant_id, tc.id, null, null, 0, 'merge', null, 'admin',
            `[Super Admin] ${mergeNote} — ${source.name || source.email || source.phone || '#' + sourceId} fusionné (+${sc.points_balance} pts, +${sc.visit_count} visites)`
          );

          merchantClientQueries.delete.run(sc.id);
          results.merged.push({ merchant: sc.business_name, points: sc.points_balance });
        } else {
          // ── TRANSFER: source card moves to target user ──
          merchantClientQueries.updateEndUser.run(targetId, sc.id);

          transactionQueries.create.run(
            sc.merchant_id, sc.id, null, null, 0, 'merge', null, 'admin',
            `[Super Admin] ${mergeNote} — Carte transférée depuis ${source.name || source.email || source.phone || '#' + sourceId}`
          );

          results.transferred.push({ merchant: sc.business_name, points: sc.points_balance });
        }
      }

      // ── Global aliases ──
      if (source.email_lower) {
        aliasQueries.create.run(targetId, 'email', source.email_lower);
      }
      if (source.phone_e164) {
        aliasQueries.create.run(targetId, 'phone', source.phone_e164);
      }

      // ── Enrich target with missing identifiers from source ──
      if (!target.email && source.email) {
        db.prepare("UPDATE end_users SET email = ?, email_lower = ?, updated_at = datetime('now') WHERE id = ?")
          .run(source.email, source.email_lower, targetId);
      }
      if (!target.phone && source.phone) {
        db.prepare("UPDATE end_users SET phone = ?, phone_e164 = ?, updated_at = datetime('now') WHERE id = ?")
          .run(source.phone, source.phone_e164, targetId);
      }
      if (!target.name && source.name) {
        db.prepare("UPDATE end_users SET name = ?, updated_at = datetime('now') WHERE id = ?")
          .run(source.name, targetId);
      }
      if (!target.pin_hash && source.pin_hash) {
        endUserQueries.setPin.run(source.pin_hash, targetId);
      }
      if (source.email_validated && !target.email_validated) {
        db.prepare("UPDATE end_users SET email_validated = 1, updated_at = datetime('now') WHERE id = ?")
          .run(targetId);
      }

      // ── Collect affected merchants for notifications ──
      const affectedMerchantIds = new Set(sourceCards.map(sc => sc.merchant_id));
      results.affectedMerchants = [...affectedMerchantIds];

      // ── Record in end_user_merges ──
      mergeQueries.create.run(
        sourceId, targetId, req.admin.id, mergeNote,
        JSON.stringify(results)
      );

      // ── Soft-delete source user ──
      // Clean aliases pointing to source first
      aliasQueries.deleteByUser.run(sourceId);
      endUserQueries.softDelete.run(sourceId);

      return results;
    });

    const results = run();

    // ── Notify affected merchant owners (async, non-blocking) ──
    const sourceName = source.name || source.email || source.phone || `#${sourceId}`;
    if (results.affectedMerchants && results.affectedMerchants.length > 0) {
      for (const mId of results.affectedMerchants) {
        try {
          const owner = db.prepare("SELECT email, display_name FROM staff_accounts WHERE merchant_id = ? AND role = 'owner' LIMIT 1").get(mId);
          const merchant = db.prepare("SELECT business_name FROM merchants WHERE id = ?").get(mId);
          if (owner && merchant) {
            const action = results.merged.some(m => m.merchant === merchant.business_name) ? 'merge' : 'transfer';
            sendGlobalMergeNotificationEmail(owner.email, merchant.business_name, action, sourceName, mergeNote)
              .catch(err => console.error(`Email merge notif failed for merchant ${mId}:`, err));
          }
        } catch (e) {
          console.error(`Notification merge merchant ${mId}:`, e);
        }
      }
    }

    logAudit({
      ...auditCtx(req),
      actorType: 'admin', actorId: req.admin.id, merchantId: null,
      action: 'global_user_merge',
      targetType: 'end_user', targetId: targetId,
      details: { sourceId, targetId, reason: reason || null, ...results },
    });

    res.json({
      message: 'Fusion globale effectuée',
      merged: results.merged.length,
      transferred: results.transferred.length,
      details: results,
    });
  } catch (error) {
    console.error('Erreur merge global:', error);
    res.status(500).json({ error: error.message || 'Erreur lors de la fusion' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/admin/users/:id/block — Global block
// POST /api/admin/users/:id/unblock — Global unblock
// ═══════════════════════════════════════════════════════

router.post('/:id/block', (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const user = endUserQueries.findById.get(userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    endUserQueries.block.run(userId);

    logAudit({
      ...auditCtx(req),
      actorType: 'admin', actorId: req.admin.id, merchantId: null,
      action: 'global_user_blocked',
      targetType: 'end_user', targetId: userId,
    });

    res.json({ message: 'Utilisateur bloqué globalement' });
  } catch (error) {
    console.error('Erreur block user:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/:id/unblock', (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const user = endUserQueries.findById.get(userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    endUserQueries.unblock.run(userId);

    logAudit({
      ...auditCtx(req),
      actorType: 'admin', actorId: req.admin.id, merchantId: null,
      action: 'global_user_unblocked',
      targetType: 'end_user', targetId: userId,
    });

    res.json({ message: 'Utilisateur débloqué' });
  } catch (error) {
    console.error('Erreur unblock user:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
