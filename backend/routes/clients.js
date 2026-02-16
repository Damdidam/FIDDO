const express = require('express');
const bcrypt = require('bcryptjs');
const { db, merchantQueries, merchantClientQueries, transactionQueries, endUserQueries, aliasQueries, voucherQueries } = require('../database');
const { authenticateStaff, requireRole } = require('../middleware/auth');
const { logAudit, auditCtx } = require('../middleware/audit');
const { creditPoints, redeemReward, adjustPoints } = require('../services/points');
const { sendPointsCreditedEmail, sendPinChangedEmail, sendExportEmail } = require('../services/email');
const { normalizeEmail, normalizePhone } = require('../services/normalizer');
const { resolvePinToken, resolveQrVerifyToken } = require('./qr');

const router = express.Router();
router.use(authenticateStaff);


// ═══════════════════════════════════════════════════════
// GET /api/clients/quick-search?q=...&mode=email|phone
// ═══════════════════════════════════════════════════════

router.get('/quick-search', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { q, mode } = req.query;
    if (!q || q.length < 3) return res.json({ results: [] });

    const termLike = `%${q.toLowerCase()}%`;
    let endUsers;

    // Scoped to merchant's own clients only (privacy: no cross-merchant data)
    if (mode === 'phone') {
      const digits = q.replace(/[^\d]/g, '');
      if (digits.length < 3) return res.json({ results: [] });
      endUsers = db.prepare(`
        SELECT eu.id, eu.email, eu.phone, eu.phone_e164, eu.name
        FROM end_users eu
        JOIN merchant_clients mc ON mc.end_user_id = eu.id AND mc.merchant_id = ?
        WHERE eu.deleted_at IS NULL
          AND (REPLACE(REPLACE(REPLACE(REPLACE(eu.phone_e164,'+',''),' ',''),'-',''),'.','') LIKE ? OR eu.name LIKE ?)
        ORDER BY eu.updated_at DESC LIMIT 10
      `).all(merchantId, `%${digits}%`, termLike);
    } else {
      endUsers = db.prepare(`
        SELECT eu.id, eu.email, eu.phone, eu.phone_e164, eu.name
        FROM end_users eu
        JOIN merchant_clients mc ON mc.end_user_id = eu.id AND mc.merchant_id = ?
        WHERE eu.deleted_at IS NULL AND (eu.email_lower LIKE ? OR eu.name LIKE ?)
        ORDER BY eu.updated_at DESC LIMIT 10
      `).all(merchantId, termLike, termLike);
    }

    const results = endUsers.map(eu => {
      const mc = merchantClientQueries.find.get(merchantId, eu.id);
      return {
        end_user_id: eu.id, email: eu.email, phone: eu.phone, name: eu.name,
        id: mc ? mc.id : null, points_balance: mc ? mc.points_balance : undefined,
        visit_count: mc ? mc.visit_count : undefined, total_spent: mc ? mc.total_spent : undefined,
        is_blocked: mc ? mc.is_blocked : false,
      };
    });
    res.json({ results, count: results.length });
  } catch (error) {
    console.error('Erreur quick-search:', error);
    res.status(500).json({ error: 'Erreur lors de la recherche' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/clients/recent-activity?limit=20
// ═══════════════════════════════════════════════════════

router.get('/recent-activity', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const merchant = merchantQueries.findById.get(merchantId);

    const rows = db.prepare(`
      SELECT t.id, t.amount, t.points_delta, t.transaction_type, t.source, t.notes, t.created_at,
             eu.email as client_email, eu.phone as client_phone, eu.name as client_name,
             mc.points_balance as current_balance, mc.id as merchant_client_id,
             mc.custom_reward,
             sa.display_name as staff_name, sa.role as staff_role
      FROM transactions t
      JOIN merchant_clients mc ON t.merchant_client_id = mc.id
      JOIN end_users eu ON mc.end_user_id = eu.id
      LEFT JOIN staff_accounts sa ON t.staff_id = sa.id
      WHERE t.merchant_id = ?
      ORDER BY t.created_at DESC LIMIT ?
    `).all(merchantId, limit);

    const transactions = rows.map(r => ({
      ...r,
      can_redeem: r.current_balance >= merchant.points_for_reward,
      has_custom_reward: !!r.custom_reward,
    }));

    res.json({ transactions, count: transactions.length });
  } catch (error) {
    console.error('Erreur recent-activity:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/clients/enriched — Clients + last tx info
// ═══════════════════════════════════════════════════════

router.get('/enriched', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;

    const clients = db.prepare(`
      SELECT mc.id, mc.points_balance, mc.total_spent, mc.visit_count,
             mc.first_visit, mc.last_visit, mc.is_blocked, mc.created_at,
             mc.end_user_id, mc.notes_private, mc.custom_reward,
             eu.email, eu.phone, eu.name, eu.email_validated, eu.is_blocked as eu_blocked,
             last_tx.staff_name as last_credited_by,
             last_tx.created_at as last_tx_at,
             last_tx.points_delta as last_tx_points,
             last_tx.amount as last_tx_amount
      FROM merchant_clients mc
      JOIN end_users eu ON mc.end_user_id = eu.id
      LEFT JOIN (
        SELECT t.merchant_client_id, sa.display_name as staff_name,
               t.created_at, t.points_delta, t.amount,
               ROW_NUMBER() OVER (PARTITION BY t.merchant_client_id ORDER BY t.created_at DESC) as rn
        FROM transactions t
        LEFT JOIN staff_accounts sa ON t.staff_id = sa.id
        WHERE t.merchant_id = ? AND t.transaction_type = 'credit'
      ) last_tx ON last_tx.merchant_client_id = mc.id AND last_tx.rn = 1
      WHERE mc.merchant_id = ? AND eu.deleted_at IS NULL
      ORDER BY mc.last_visit DESC
    `).all(merchantId, merchantId);

    res.json({ clients, count: clients.length });
  } catch (error) {
    console.error('Erreur enriched:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/clients/credit
// ═══════════════════════════════════════════════════════

router.post('/credit', async (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const staffId = req.staff.id;
    const { email, phone, name, amount, notes, idempotencyKey, pin, pinToken } = req.body;

    if (!email && !phone) return res.status(400).json({ error: 'Email ou téléphone requis' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Montant invalide' });
    if (req.staff.role === 'cashier' && parseFloat(amount) > 200) return res.status(403).json({ error: 'Max 200€ pour un caissier' });

    // Input length limits
    if (email && email.length > 254) return res.status(400).json({ error: 'Email trop long (max 254)' });
    if (phone && phone.length > 20) return res.status(400).json({ error: 'Téléphone trop long (max 20)' });
    if (name && name.length > 100) return res.status(400).json({ error: 'Nom trop long (max 100)' });
    if (notes && notes.length > 500) return res.status(400).json({ error: 'Notes trop longues (max 500)' });

    // Resolve pinToken server-side (from QR registration) or hash PIN from manual input
    const pinHash = resolvePinToken(pinToken) || (pin ? await bcrypt.hash(pin, 10) : null);

    const result = creditPoints({
      merchantId, staffId, email: email || null, phone: phone || null, name: name || null,
      amount: parseFloat(amount), notes: notes || null, idempotencyKey: idempotencyKey || null, source: 'manual',
      pinHash,
    });

    const merchant = merchantQueries.findById.get(merchantId);

    if (!result.idempotent) {
      logAudit({ ...auditCtx(req), actorType: 'staff', actorId: staffId, merchantId, action: 'points_credited',
        targetType: 'merchant_client', targetId: result.merchantClient.id,
        details: { amount: parseFloat(amount), pointsDelta: result.transaction.points_delta, isNewClient: result.isNewClient } });

      if (result.isNewClient && result.endUser.email) {
        // No validation email needed — client consented by providing their email
        // Welcome email is sent from /api/qr/register
      }
      if (result.endUser.email && result.endUser.email_validated)
        sendPointsCreditedEmail(result.endUser.email, result.transaction.points_delta, result.merchantClient.points_balance,
          merchant.business_name, { points_for_reward: merchant.points_for_reward, reward_description: merchant.reward_description });
    }

    const canRedeem = result.merchantClient.points_balance >= merchant.points_for_reward;

    res.json({
      message: result.isNewClient ? 'Nouveau client créé et points crédités' : 'Points crédités',
      client: { id: result.merchantClient.id, email: result.endUser.email, phone: result.endUser.phone,
        name: result.endUser.name, points_balance: result.merchantClient.points_balance,
        total_spent: result.merchantClient.total_spent, visit_count: result.merchantClient.visit_count,
        can_redeem: canRedeem, reward_threshold: merchant.points_for_reward,
        reward_description: result.merchantClient.custom_reward || merchant.reward_description },
      transaction: { amount: parseFloat(amount), points_delta: result.transaction.points_delta },
      isNewClient: result.isNewClient,
    });
  } catch (error) {
    console.error('Erreur crédit:', error);
    res.status(error.message.includes('bloqué') ? 403 : 500).json({ error: error.message });
  }
});

router.post('/reward', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { merchantClientId, notes, idempotencyKey, pin, qrVerifyToken } = req.body;
    if (!merchantClientId) return res.status(400).json({ error: 'ID client requis' });

    // Resolve QR verify token server-side (never trust a boolean from client)
    const qrVerified = resolveQrVerifyToken(qrVerifyToken);

    const result = redeemReward({ merchantId, merchantClientId: parseInt(merchantClientId), staffId: req.staff.id, notes: notes || null, idempotencyKey: idempotencyKey || null, pin: pin || null, qrVerified });
    if (!result.idempotent) logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId, action: 'reward_redeemed', targetType: 'merchant_client', targetId: parseInt(merchantClientId), details: { pointsDelta: result.transaction.points_delta, qrVerified } });
    res.json({ message: 'Récompense appliquée', client: result.merchantClient, transaction: result.transaction, rewardLabel: result.rewardLabel || null });
  } catch (error) {
    console.error('Erreur reward:', error);
    const msg = error.message;
    const status = msg.includes('insuffisant') ? 400 : msg.includes('PIN') ? 403 : 500;
    res.status(status).json({ error: msg });
  }
});

router.post('/adjust', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { merchantClientId, pointsDelta, reason } = req.body;
    if (!merchantClientId || pointsDelta === undefined) return res.status(400).json({ error: 'ID client et ajustement requis' });
    if (reason && reason.length > 500) return res.status(400).json({ error: 'Raison trop longue (max 500)' });
    const result = adjustPoints({ merchantId, merchantClientId: parseInt(merchantClientId), pointsDelta: parseInt(pointsDelta), staffId: req.staff.id, reason: reason || '' });
    logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId, action: 'points_adjusted', targetType: 'merchant_client', targetId: parseInt(merchantClientId), details: { pointsDelta: parseInt(pointsDelta), reason } });
    res.json({ message: 'Ajustement effectué', client: result.merchantClient, transaction: result.transaction });
  } catch (error) { console.error('Erreur adjustment:', error); res.status(400).json({ error: error.message }); }
});


// ═══════════════════════════════════════════════════════
// PUT /api/clients/:id/edit — Edit client info (owner/manager)
// ═══════════════════════════════════════════════════════

router.put('/:id/edit', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const mcId = parseInt(req.params.id);
    const { name, email, phone } = req.body;

    const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, merchantId);
    if (!mc) return res.status(404).json({ error: 'Client non trouvé' });

    const endUser = endUserQueries.findById.get(mc.end_user_id);
    if (!endUser) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    // Input length limits
    if (email && email.length > 254) return res.status(400).json({ error: 'Email trop long (max 254)' });
    if (phone && phone.length > 20) return res.status(400).json({ error: 'Téléphone trop long (max 20)' });
    if (name && name.length > 100) return res.status(400).json({ error: 'Nom trop long (max 100)' });

    // ── Email/phone edits: owner only (global impact on all merchants) ──
    const emailChanging = email !== undefined && normalizeEmail(email) !== endUser.email_lower;
    const phoneChanging = phone !== undefined && normalizePhone(phone) !== endUser.phone_e164;

    if ((emailChanging || phoneChanging) && req.staff.role !== 'owner') {
      return res.status(403).json({ error: 'Seul le propriétaire peut modifier l\'email ou le téléphone (impact multi-commerce)' });
    }

    const newEmailLower = email ? normalizeEmail(email) : endUser.email_lower;
    const newPhoneE164 = phone ? normalizePhone(phone) : endUser.phone_e164;

    if (!newEmailLower && !newPhoneE164) return res.status(400).json({ error: 'Au moins un email ou téléphone requis' });

    if (newEmailLower && newEmailLower !== endUser.email_lower) {
      const existing = endUserQueries.findByEmailLower.get(newEmailLower);
      if (existing && existing.id !== endUser.id) return res.status(400).json({ error: 'Cet email est déjà utilisé par un autre client' });
    }
    if (newPhoneE164 && newPhoneE164 !== endUser.phone_e164) {
      const existing = endUserQueries.findByPhoneE164.get(newPhoneE164);
      if (existing && existing.id !== endUser.id) return res.status(400).json({ error: 'Ce téléphone est déjà utilisé par un autre client' });
    }

    // ── FIX: null-safe trim ──
    const newName = name !== undefined ? ((name || '').trim() || null) : endUser.name;
    const newEmail = email !== undefined ? ((email || '').trim() || null) : endUser.email;
    const newPhone = phone !== undefined ? ((phone || '').trim() || null) : endUser.phone;

    // Reset email_validated if email actually changed
    const emailChanged = newEmailLower && newEmailLower !== endUser.email_lower;
    const keepValidated = emailChanged ? 0 : endUser.email_validated;

    endUserQueries.updateIdentifiers.run(newEmail, newPhone, newEmailLower || null, newPhoneE164 || null, keepValidated, endUser.id);
    if (name !== undefined) db.prepare("UPDATE end_users SET name = ?, updated_at = datetime('now') WHERE id = ?").run(newName, endUser.id);

    // ── Audit with cross-merchant impact tracking ──
    const otherMerchantCount = db.prepare(
      'SELECT COUNT(*) as count FROM merchant_clients WHERE end_user_id = ? AND merchant_id != ?'
    ).get(mc.end_user_id, merchantId).count;

    logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId, action: 'client_edited', targetType: 'end_user', targetId: endUser.id,
      details: { name: newName, email: newEmail, phone: newPhone, emailChanged, phoneChanged: phoneChanging, otherMerchantsAffected: otherMerchantCount } });

    const updated = endUserQueries.findById.get(endUser.id);
    const warning = otherMerchantCount > 0 && (emailChanged || phoneChanging)
      ? ` ⚠️ Ce client est inscrit chez ${otherMerchantCount} autre(s) commerce(s) — la modification s'applique partout.`
      : '';

    res.json({ message: 'Client mis à jour' + warning, client: { name: updated.name, email: updated.email, phone: updated.phone }, crossMerchantImpact: otherMerchantCount });
  } catch (error) {
    console.error('Erreur edit:', error);
    res.status(500).json({ error: error.message || 'Erreur lors de la mise à jour' });
  }
});


// ═══════════════════════════════════════════════════════
// PUT /api/clients/:id/notes — Update private notes (owner/manager)
// ═══════════════════════════════════════════════════════

router.put('/:id/notes', requireRole('owner', 'manager'), (req, res) => {
  try {
    const mc = merchantClientQueries.findByIdAndMerchant.get(parseInt(req.params.id), req.staff.merchant_id);
    if (!mc) return res.status(404).json({ error: 'Client non trouvé' });

    const notes = (req.body.notes || '').trim().substring(0, 500);
    db.prepare("UPDATE merchant_clients SET notes_private = ?, updated_at = datetime('now') WHERE id = ?")
      .run(notes || null, mc.id);

    res.json({ message: 'Notes mises à jour' });
  } catch (error) {
    console.error('Erreur notes:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/clients/:id/resend-email — Resend points summary email
// ═══════════════════════════════════════════════════════

router.post('/:id/resend-email', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const mcId = parseInt(req.params.id);

    const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, merchantId);
    if (!mc) return res.status(404).json({ error: 'Client non trouvé' });

    const endUser = endUserQueries.findById.get(mc.end_user_id);
    if (!endUser || !endUser.email) return res.status(400).json({ error: 'Ce client n\'a pas d\'email' });

    const merchant = merchantQueries.findById.get(merchantId);

    // Find last credit transaction for context
    const lastCredit = db.prepare(`
      SELECT points_delta, amount FROM transactions
      WHERE merchant_client_id = ? AND transaction_type = 'credit'
      ORDER BY created_at DESC LIMIT 1
    `).get(mcId);

    const pointsEarned = lastCredit ? lastCredit.points_delta : 0;

    if (!endUser.email_validated) {
      // Mark as validated (consent given by providing email) and send points summary
      db.prepare("UPDATE end_users SET email_validated = 1, consent_date = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(endUser.id);
    }

    // Resend points summary
    sendPointsCreditedEmail(
      endUser.email, pointsEarned, mc.points_balance,
      merchant.business_name,
      { points_for_reward: merchant.points_for_reward, reward_description: merchant.reward_description }
    );

    logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId, action: 'email_resent', targetType: 'merchant_client', targetId: mcId });

    res.json({ message: 'Email envoyé', type: 'points' });
  } catch (error) {
    console.error('Erreur resend:', error);
    res.status(500).json({ error: 'Erreur lors de l\'envoi' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/clients/:id/merge — Merge clients (owner only)
// ═══════════════════════════════════════════════════════

router.post('/:id/merge', requireRole('owner'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const targetMcId = parseInt(req.params.id);
    const { sourceMerchantClientId, reason } = req.body;

    if (!sourceMerchantClientId) return res.status(400).json({ error: 'ID du client source requis' });
    const sourceMcId = parseInt(sourceMerchantClientId);
    if (sourceMcId === targetMcId) return res.status(400).json({ error: 'Impossible de fusionner un client avec lui-même' });

    const run = db.transaction(() => {
      const target = merchantClientQueries.findByIdAndMerchant.get(targetMcId, merchantId);
      if (!target) throw new Error('Client cible non trouvé');
      const source = merchantClientQueries.findByIdAndMerchant.get(sourceMcId, merchantId);
      if (!source) throw new Error('Client source non trouvé');

      const targetEu = endUserQueries.findById.get(target.end_user_id);
      const sourceEu = endUserQueries.findById.get(source.end_user_id);

      merchantClientQueries.mergeStats.run(source.points_balance, source.total_spent, source.visit_count, source.first_visit, source.last_visit, targetMcId);
      transactionQueries.reassignClient.run(targetMcId, sourceMcId);
      transactionQueries.create.run(merchantId, targetMcId, req.staff.id, null, 0, 'merge', null, 'manual',
        `Fusion avec ${sourceEu?.name || sourceEu?.email || sourceEu?.phone || '#'+sourceMcId} — ${reason || 'Fusion manuelle'}`);

      // Reassign point vouchers (FK: sender_mc_id, claimer_mc_id → merchant_clients)
      voucherQueries.reassignSender.run(targetMcId, sourceMcId);
      voucherQueries.reassignClaimer.run(targetMcId, sourceMcId);

      merchantClientQueries.delete.run(sourceMcId);

      // Clean up orphaned end_user if source has no remaining merchant relations
      // (but never delete if same end_user as target!)
      if (source.end_user_id !== target.end_user_id) {
        const otherRelations = db.prepare(
          'SELECT COUNT(*) as count FROM merchant_clients WHERE end_user_id = ?'
        ).get(source.end_user_id);
        if (otherRelations.count === 0) {
          aliasQueries.deleteByUser.run(source.end_user_id);
          endUserQueries.softDelete.run(source.end_user_id);
        }
      }

      logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId, action: 'clients_merged', targetType: 'merchant_client', targetId: targetMcId,
        details: { sourceMcId, targetMcId, reason, pointsTransferred: source.points_balance, spentTransferred: source.total_spent } });

      return merchantClientQueries.findById.get(targetMcId);
    });

    const updated = run();
    res.json({ message: 'Clients fusionnés avec succès', client: updated });
  } catch (error) {
    console.error('Erreur merge:', error);
    res.status(400).json({ error: error.message || 'Erreur lors de la fusion' });
  }
});


// ═══════════════════════════════════════════════════════
// DELETE /api/clients/:id — Delete client (owner only, RGPD)
// ═══════════════════════════════════════════════════════

router.delete('/:id', requireRole('owner'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const mcId = parseInt(req.params.id);

    const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, merchantId);
    if (!mc) return res.status(404).json({ error: 'Client non trouvé' });

    const endUser = endUserQueries.findById.get(mc.end_user_id);

    const run = db.transaction(() => {
      // Delete point vouchers sent by this client (FK: sender_mc_id NOT NULL)
      voucherQueries.deleteBySender.run(mcId);
      // Detach as claimer on vouchers sent by others (FK: claimer_mc_id nullable)
      voucherQueries.nullifyClaimer.run(mcId);

      // Delete transactions (FK: merchant_client_id NOT NULL REFERENCES merchant_clients)
      db.prepare('DELETE FROM transactions WHERE merchant_client_id = ?').run(mcId);

      // Now safe to delete the merchant_client record
      merchantClientQueries.delete.run(mcId);

      const otherRelations = db.prepare(
        'SELECT COUNT(*) as count FROM merchant_clients WHERE end_user_id = ?'
      ).get(mc.end_user_id);

      let userDeleted = false;
      if (otherRelations.count === 0) {
        // Clean aliases pointing to this user
        aliasQueries.deleteByUser.run(mc.end_user_id);
        endUserQueries.softDelete.run(mc.end_user_id);
        userDeleted = true;
      }

      logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId,
        action: 'client_deleted', targetType: 'merchant_client', targetId: mcId,
        details: {
          endUserId: mc.end_user_id,
          email: endUser?.email, name: endUser?.name,
          userDeleted,
          pointsLost: mc.points_balance, totalSpent: mc.total_spent,
        } });

      return { userDeleted };
    });

    const result = run();

    res.json({
      message: result.userDeleted
        ? 'Client et données personnelles supprimés (RGPD)'
        : 'Client supprimé de votre commerce',
      userDeleted: result.userDeleted,
    });
  } catch (error) {
    console.error('Erreur delete:', error);
    res.status(500).json({ error: error.message || 'Erreur lors de la suppression' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/clients/near-duplicates — Fuzzy phone/email duplicate detection
// ═══════════════════════════════════════════════════════

router.get('/near-duplicates', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { email, phone } = req.query;
    if (!email && !phone) return res.json({ matches: [] });

    const matches = [];

    // Phone: match on last 7 digits (catches typos, format differences)
    if (phone) {
      const e164 = normalizePhone(phone);
      if (e164) {
        const digits = e164.replace(/\D/g, '');
        if (digits.length >= 7) {
          const suffix = digits.slice(-7);
          const phoneMatches = db.prepare(`
            SELECT eu.id, eu.name, eu.email, eu.phone, eu.phone_e164,
                   mc.points_balance, mc.visit_count
            FROM end_users eu
            LEFT JOIN merchant_clients mc ON mc.end_user_id = eu.id AND mc.merchant_id = ?
            WHERE eu.deleted_at IS NULL
              AND eu.phone_e164 IS NOT NULL
              AND eu.phone_e164 LIKE ?
              AND eu.phone_e164 != ?
            LIMIT 5
          `).all(merchantId, '%' + suffix, e164);
          phoneMatches.forEach(m => matches.push({ ...m, matchType: 'phone' }));
        }
      }
    }

    // Email: match on local part (before @)
    if (email) {
      const emailLower = normalizeEmail(email);
      if (emailLower) {
        const localPart = emailLower.split('@')[0];
        if (localPart && localPart.length >= 3) {
          const emailMatches = db.prepare(`
            SELECT eu.id, eu.name, eu.email, eu.phone, eu.email_lower,
                   mc.points_balance, mc.visit_count
            FROM end_users eu
            LEFT JOIN merchant_clients mc ON mc.end_user_id = eu.id AND mc.merchant_id = ?
            WHERE eu.deleted_at IS NULL
              AND eu.email_lower IS NOT NULL
              AND eu.email_lower LIKE ?
              AND eu.email_lower != ?
            LIMIT 5
          `).all(merchantId, localPart + '%@%', emailLower);
          emailMatches.forEach(m => {
            if (!matches.find(x => x.id === m.id)) matches.push({ ...m, matchType: 'email' });
          });
        }
      }
    }

    res.json({
      matches: matches.map(m => ({
        name: m.name,
        email: m.email,
        phone: m.phone,
        pointsBalance: m.points_balance || 0,
        visitCount: m.visit_count || 0,
        matchType: m.matchType,
      })),
    });
  } catch (error) {
    console.error('Near-duplicates error:', error);
    res.json({ matches: [] });
  }
});


// ═══════════════════════════════════════════════════════
// STANDARD ENDPOINTS (lookup, list, search, export, detail, block)
// ═══════════════════════════════════════════════════════

router.get('/lookup', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { email, phone } = req.query;
    if (!email && !phone) return res.status(400).json({ error: 'Email ou téléphone requis' });
    const emailLower = normalizeEmail(email); const phoneE164 = normalizePhone(phone);
    let endUser = null;
    if (emailLower) endUser = endUserQueries.findByEmailLower.get(emailLower);
    if (!endUser && phoneE164) endUser = endUserQueries.findByPhoneE164.get(phoneE164);
    if (!endUser && emailLower) { const a = aliasQueries.findByValue.get(emailLower); if (a) endUser = endUserQueries.findById.get(a.end_user_id); }
    if (!endUser && phoneE164) { const a = aliasQueries.findByValue.get(phoneE164); if (a) endUser = endUserQueries.findById.get(a.end_user_id); }
    if (!endUser) return res.json({ found: false });
    const mc = merchantClientQueries.find.get(merchantId, endUser.id);
    if (!mc) return res.json({ found: true, isNew: true, client: { name: endUser.name, email: endUser.email, phone: endUser.phone } });
    const merchant = merchantQueries.findById.get(merchantId);
    res.json({ found: true, isNew: false, client: { id: mc.id, name: endUser.name, email: endUser.email, phone: endUser.phone, points_balance: mc.points_balance, visit_count: mc.visit_count, is_blocked: mc.is_blocked, reward_threshold: merchant.points_for_reward, reward_description: mc.custom_reward || merchant.reward_description, custom_reward: mc.custom_reward || null, can_redeem: mc.points_balance >= merchant.points_for_reward, has_pin: !!endUser.pin_hash } });
  } catch (error) { res.status(500).json({ error: 'Erreur' }); }
});

router.get('/', requireRole('owner', 'manager'), (req, res) => {
  try { const clients = merchantClientQueries.getByMerchant.all(req.staff.merchant_id); res.json({ count: clients.length, clients }); }
  catch (error) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/search', requireRole('owner', 'manager'), (req, res) => {
  try { const { q } = req.query; if (!q || q.length < 2) return res.status(400).json({ error: 'Min 2 caractères' });
    const term = `%${q.toLowerCase()}%`; const clients = merchantClientQueries.searchByMerchant.all(req.staff.merchant_id, term, term, term);
    res.json({ count: clients.length, clients }); }
  catch (error) { res.status(500).json({ error: 'Erreur serveur' }); }
});


// ═══════════════════════════════════════════════════════
// GET /api/clients/search-global?q=... — Cross-merchant user search (all staff)
// ═══════════════════════════════════════════════════════

router.get('/search-global', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { q } = req.query;
    if (!q || q.length < 2) return res.status(400).json({ error: 'Min 2 caractères' });

    const term = `%${q.toLowerCase()}%`;
    const endUsers = endUserQueries.search.all(term, term, term);

    const results = endUsers.slice(0, 10).map(eu => {
      const mc = merchantClientQueries.find.get(merchantId, eu.id);
      return {
        email: eu.email,
        phone: eu.phone,
        name: eu.name,
        points_balance: mc ? mc.points_balance : 0,
        visit_count: mc ? mc.visit_count : 0,
        is_local: !!mc,
      };
    });

    res.json({ count: results.length, clients: results });
  } catch (error) {
    console.error('Erreur search-global:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/export/csv', requireRole('owner'), async (req, res) => {
  try {
    const clients = merchantClientQueries.getByMerchant.all(req.staff.merchant_id);
    const merchant = merchantQueries.findById.get(req.staff.merchant_id);

    // CSV injection protection: prefix dangerous first chars, escape double quotes
    const csvSafe = (val) => {
      if (!val) return '';
      let s = String(val).replace(/"/g, '""');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return s;
    };

    let csv = 'Email,Téléphone,Nom,Points,Total dépensé,Visites,Première visite,Dernière visite,Email validé,Bloqué,Récompense perso\n';
    clients.forEach(c => {
      csv += `"${csvSafe(c.email)}","${csvSafe(c.phone)}","${csvSafe(c.name)}",${c.points_balance},${c.total_spent},${c.visit_count},"${csvSafe(c.first_visit)}","${csvSafe(c.last_visit)}",${c.email_validated?'Oui':'Non'},${c.is_blocked?'Oui':'Non'},"${csvSafe(c.custom_reward)}"\n`;
    });

    const date = new Date().toISOString().slice(0, 10);
    const filename = `clients-${merchant.business_name.replace(/[^a-zA-Z0-9]/g, '-')}-${date}.csv`;

    const sent = await sendExportEmail(
      req.staff.email,
      merchant.business_name,
      filename,
      '\uFEFF' + csv,
      'text/csv'
    );

    if (sent) {
      res.json({ success: true, message: `Export envoyé à ${req.staff.email}` });
    } else {
      res.status(500).json({ error: 'Erreur lors de l\'envoi de l\'email' });
    }
  } catch (error) { res.status(500).json({ error: 'Erreur export' }); }
});

router.get('/:id', requireRole('owner', 'manager'), (req, res) => {
  try {
    const mc = merchantClientQueries.findByIdAndMerchant.get(parseInt(req.params.id), req.staff.merchant_id);
    if (!mc) return res.status(404).json({ error: 'Client non trouvé' });
    const eu = endUserQueries.findById.get(mc.end_user_id);
    const txs = transactionQueries.getByMerchantClient.all(mc.id);
    const m = merchantQueries.findById.get(req.staff.merchant_id);
    res.json({
      client: { ...mc, email: eu?.email, phone: eu?.phone, name: eu?.name, email_validated: eu?.email_validated,
        reward_threshold: m.points_for_reward, reward_description: mc.custom_reward || m.reward_description,
        custom_reward: mc.custom_reward || null, default_reward: m.reward_description,
        can_redeem: mc.points_balance >= m.points_for_reward, has_pin: !!eu?.pin_hash },
      transactions: txs,
    });
  } catch (error) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ═══════════════════════════════════════════════════════
// PUT /api/clients/:id/custom-reward — Set custom reward (owner/manager)
// ═══════════════════════════════════════════════════════

router.put('/:id/custom-reward', requireRole('owner', 'manager'), (req, res) => {
  try {
    const mcId = parseInt(req.params.id);
    const merchantId = req.staff.merchant_id;
    const { customReward } = req.body;

    const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, merchantId);
    if (!mc) return res.status(404).json({ error: 'Client non trouvé' });

    const value = (customReward && customReward.trim()) ? customReward.trim().substring(0, 200) : null;

    merchantClientQueries.setCustomReward.run(value, mcId);

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId,
      action: value ? 'custom_reward_set' : 'custom_reward_cleared',
      targetType: 'merchant_client',
      targetId: mcId,
      details: { customReward: value },
    });

    res.json({
      message: value ? 'Récompense personnalisée définie' : 'Récompense par défaut restaurée',
      customReward: value,
    });
  } catch (error) {
    console.error('Erreur custom-reward:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/:id/block', requireRole('owner', 'manager'), (req, res) => {
  try { const mcId = parseInt(req.params.id); const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, req.staff.merchant_id); if (!mc) return res.status(404).json({ error: 'Non trouvé' });
    merchantClientQueries.block.run(mcId); logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId: req.staff.merchant_id, action: 'client_blocked', targetType: 'merchant_client', targetId: mcId });
    res.json({ message: 'Client bloqué' }); } catch (error) { res.status(500).json({ error: 'Erreur' }); }
});

router.post('/:id/unblock', requireRole('owner', 'manager'), (req, res) => {
  try { const mcId = parseInt(req.params.id); const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, req.staff.merchant_id); if (!mc) return res.status(404).json({ error: 'Non trouvé' });
    merchantClientQueries.unblock.run(mcId); logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId: req.staff.merchant_id, action: 'client_unblocked', targetType: 'merchant_client', targetId: mcId });
    res.json({ message: 'Client débloqué' }); } catch (error) { res.status(500).json({ error: 'Erreur' }); }
});

// ═══════════════════════════════════════════════════════
// POST /api/clients/:id/pin — Set or update client PIN (owner/manager)
// ═══════════════════════════════════════════════════════

router.post('/:id/pin', requireRole('owner', 'manager'), async (req, res) => {
  try {
    const mcId = parseInt(req.params.id);
    const merchantId = req.staff.merchant_id;
    const { pin } = req.body;

    if (!pin || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'Le code PIN doit contenir exactement 4 chiffres' });
    }

    const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, merchantId);
    if (!mc) return res.status(404).json({ error: 'Client non trouvé' });

    const eu = endUserQueries.findById.get(mc.end_user_id);
    if (!eu) return res.status(404).json({ error: 'Client non trouvé' });

    const hadPin = !!eu.pin_hash;
    const pinHash = await bcrypt.hash(pin, 10);
    endUserQueries.setPin.run(pinHash, eu.id);

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId,
      action: hadPin ? 'pin_updated' : 'pin_set',
      targetType: 'end_user',
      targetId: eu.id,
    });

    // Fire-and-forget: notify client by email if validated
    if (eu.email && eu.email_validated) {
      const merchant = merchantQueries.findById.get(merchantId);
      sendPinChangedEmail(eu.email, merchant.business_name);
    }

    res.json({ message: 'Code PIN mis à jour', has_pin: true });
  } catch (error) {
    console.error('Erreur set PIN:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
