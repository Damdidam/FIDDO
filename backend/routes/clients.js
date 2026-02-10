const express = require('express');
const { db, merchantQueries, merchantClientQueries, transactionQueries, endUserQueries, aliasQueries } = require('../database');
const { authenticateStaff, requireRole } = require('../middleware/auth');
const { logAudit, auditCtx } = require('../middleware/audit');
const { creditPoints, redeemReward, adjustPoints } = require('../services/points');
const { sendValidationEmail, sendPointsCreditedEmail } = require('../services/email');
const { normalizeEmail, normalizePhone } = require('../services/normalizer');

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

    if (mode === 'phone') {
      const digits = q.replace(/[^\d]/g, '');
      if (digits.length < 3) return res.json({ results: [] });
      endUsers = db.prepare(`
        SELECT id, email, phone, phone_e164, name FROM end_users
        WHERE deleted_at IS NULL
          AND (REPLACE(REPLACE(REPLACE(REPLACE(phone_e164,'+',''),' ',''),'-',''),'.','') LIKE ? OR name LIKE ?)
        ORDER BY updated_at DESC LIMIT 10
      `).all(`%${digits}%`, termLike);
    } else {
      endUsers = db.prepare(`
        SELECT id, email, phone, phone_e164, name FROM end_users
        WHERE deleted_at IS NULL AND (email_lower LIKE ? OR name LIKE ?)
        ORDER BY updated_at DESC LIMIT 10
      `).all(termLike, termLike);
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
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const rows = db.prepare(`
      SELECT t.id, t.amount, t.points_delta, t.transaction_type, t.source, t.notes, t.created_at,
             eu.email as client_email, eu.phone as client_phone, eu.name as client_name,
             mc.points_balance as current_balance, mc.id as merchant_client_id,
             sa.display_name as staff_name
      FROM transactions t
      JOIN merchant_clients mc ON t.merchant_client_id = mc.id
      JOIN end_users eu ON mc.end_user_id = eu.id
      LEFT JOIN staff_accounts sa ON t.staff_id = sa.id
      WHERE t.merchant_id = ?
      ORDER BY t.created_at DESC LIMIT ?
    `).all(merchantId, limit);

    res.json({ transactions: rows, count: rows.length });
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

router.post('/credit', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const staffId = req.staff.id;
    const { email, phone, name, amount, notes, idempotencyKey } = req.body;

    if (!email && !phone) return res.status(400).json({ error: 'Email ou téléphone requis' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Montant invalide' });
    if (req.staff.role === 'cashier' && parseFloat(amount) > 200) return res.status(403).json({ error: 'Max 200€ pour un caissier' });

    const result = creditPoints({
      merchantId, staffId, email: email || null, phone: phone || null, name: name || null,
      amount: parseFloat(amount), notes: notes || null, idempotencyKey: idempotencyKey || null, source: 'manual',
    });

    if (!result.idempotent) {
      logAudit({ ...auditCtx(req), actorType: 'staff', actorId: staffId, merchantId, action: 'points_credited',
        targetType: 'merchant_client', targetId: result.merchantClient.id,
        details: { amount: parseFloat(amount), pointsDelta: result.transaction.points_delta, isNewClient: result.isNewClient } });

      const merchant = merchantQueries.findById.get(merchantId);
      if (result.isNewClient && result.endUser.email)
        sendValidationEmail(result.endUser.email, result.endUser.validation_token, merchant.business_name);
      if (result.endUser.email && result.endUser.email_validated)
        sendPointsCreditedEmail(result.endUser.email, result.transaction.points_delta, result.merchantClient.points_balance,
          merchant.business_name, { points_for_reward: merchant.points_for_reward, reward_description: merchant.reward_description });
    }

    res.json({
      message: result.isNewClient ? 'Nouveau client créé et points crédités' : 'Points crédités',
      client: { id: result.merchantClient.id, email: result.endUser.email, phone: result.endUser.phone,
        name: result.endUser.name, points_balance: result.merchantClient.points_balance,
        total_spent: result.merchantClient.total_spent, visit_count: result.merchantClient.visit_count },
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
    const { merchantClientId, notes, idempotencyKey } = req.body;
    if (!merchantClientId) return res.status(400).json({ error: 'ID client requis' });
    const result = redeemReward({ merchantId, merchantClientId: parseInt(merchantClientId), staffId: req.staff.id, notes: notes || null, idempotencyKey: idempotencyKey || null });
    if (!result.idempotent) logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId, action: 'reward_redeemed', targetType: 'merchant_client', targetId: parseInt(merchantClientId), details: { pointsDelta: result.transaction.points_delta } });
    res.json({ message: 'Récompense appliquée', client: result.merchantClient, transaction: result.transaction });
  } catch (error) { console.error('Erreur reward:', error); res.status(error.message.includes('insuffisant') ? 400 : 500).json({ error: error.message }); }
});

router.post('/adjust', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { merchantClientId, pointsDelta, reason } = req.body;
    if (!merchantClientId || pointsDelta === undefined) return res.status(400).json({ error: 'ID client et ajustement requis' });
    const result = adjustPoints({ merchantId, merchantClientId: parseInt(merchantClientId), pointsDelta: parseInt(pointsDelta), staffId: req.staff.id, reason: reason || '' });
    logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId, action: 'points_adjusted', targetType: 'merchant_client', targetId: parseInt(merchantClientId), details: { pointsDelta: parseInt(pointsDelta), reason } });
    res.json({ message: 'Ajustement effectué', client: result.merchantClient, transaction: result.transaction });
  } catch (error) { console.error('Erreur adjustment:', error); res.status(400).json({ error: error.message }); }
});

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
    res.json({ found: true, isNew: false, client: { id: mc.id, name: endUser.name, email: endUser.email, phone: endUser.phone, points_balance: mc.points_balance, visit_count: mc.visit_count, is_blocked: mc.is_blocked, reward_threshold: merchant.points_for_reward, reward_description: merchant.reward_description, can_redeem: mc.points_balance >= merchant.points_for_reward } });
  } catch (error) { console.error('Erreur lookup:', error); res.status(500).json({ error: 'Erreur lors de la recherche' }); }
});

router.get('/', requireRole('owner', 'manager'), (req, res) => {
  try { const clients = merchantClientQueries.getByMerchant.all(req.staff.merchant_id); res.json({ count: clients.length, clients }); }
  catch (error) { console.error('Erreur liste:', error); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/search', requireRole('owner', 'manager'), (req, res) => {
  try { const { q } = req.query; if (!q || q.length < 2) return res.status(400).json({ error: 'Min 2 caractères' });
    const term = `%${q.toLowerCase()}%`; const clients = merchantClientQueries.searchByMerchant.all(req.staff.merchant_id, term, term, term);
    res.json({ count: clients.length, clients });
  } catch (error) { console.error('Erreur recherche:', error); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.get('/export/csv', requireRole('owner'), (req, res) => {
  try {
    const clients = merchantClientQueries.getByMerchant.all(req.staff.merchant_id);
    let csv = 'Email,Téléphone,Nom,Points,Total dépensé,Visites,Première visite,Dernière visite,Email validé,Bloqué\n';
    clients.forEach(c => { csv += `"${c.email||''}","${c.phone||''}","${c.name||''}",${c.points_balance},${c.total_spent},${c.visit_count},"${c.first_visit}","${c.last_visit}",${c.email_validated?'Oui':'Non'},${c.is_blocked?'Oui':'Non'}\n`; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=clients.csv');
    res.send('\uFEFF' + csv);
  } catch (error) { console.error('Erreur CSV:', error); res.status(500).json({ error: 'Erreur export' }); }
});

router.get('/:id', requireRole('owner', 'manager'), (req, res) => {
  try {
    const mc = merchantClientQueries.findByIdAndMerchant.get(parseInt(req.params.id), req.staff.merchant_id);
    if (!mc) return res.status(404).json({ error: 'Client non trouvé' });
    const eu = endUserQueries.findById.get(mc.end_user_id);
    const txs = transactionQueries.getByMerchantClient.all(mc.id);
    const m = merchantQueries.findById.get(req.staff.merchant_id);
    res.json({ client: { ...mc, email: eu?.email, phone: eu?.phone, name: eu?.name, email_validated: eu?.email_validated, reward_threshold: m.points_for_reward, reward_description: m.reward_description, can_redeem: mc.points_balance >= m.points_for_reward }, transactions: txs });
  } catch (error) { console.error('Erreur détails:', error); res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/:id/block', requireRole('owner', 'manager'), (req, res) => {
  try { const mcId = parseInt(req.params.id); const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, req.staff.merchant_id); if (!mc) return res.status(404).json({ error: 'Client non trouvé' });
    merchantClientQueries.block.run(mcId); logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId: req.staff.merchant_id, action: 'client_blocked', targetType: 'merchant_client', targetId: mcId });
    res.json({ message: 'Client bloqué' });
  } catch (error) { res.status(500).json({ error: 'Erreur' }); }
});

router.post('/:id/unblock', requireRole('owner', 'manager'), (req, res) => {
  try { const mcId = parseInt(req.params.id); const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, req.staff.merchant_id); if (!mc) return res.status(404).json({ error: 'Client non trouvé' });
    merchantClientQueries.unblock.run(mcId); logAudit({ ...auditCtx(req), actorType: 'staff', actorId: req.staff.id, merchantId: req.staff.merchant_id, action: 'client_unblocked', targetType: 'merchant_client', targetId: mcId });
    res.json({ message: 'Client débloqué' });
  } catch (error) { res.status(500).json({ error: 'Erreur' }); }
});

module.exports = router;
