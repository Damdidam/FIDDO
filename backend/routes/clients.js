const express = require('express');
const { db, merchantQueries, merchantClientQueries, transactionQueries, endUserQueries, aliasQueries } = require('../database');
const { authenticateStaff, requireRole } = require('../middleware/auth');
const { logAudit, auditCtx } = require('../middleware/audit');
const { creditPoints, redeemReward, adjustPoints } = require('../services/points');
const { sendValidationEmail, sendPointsCreditedEmail } = require('../services/email');
const { normalizeEmail, normalizePhone } = require('../services/normalizer');

const router = express.Router();

// All routes require authentication
router.use(authenticateStaff);


// ═══════════════════════════════════════════════════════
// POST /api/clients/credit — Credit points (cashier+)
// ═══════════════════════════════════════════════════════

router.post('/credit', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id; // ALWAYS from JWT
    const staffId = req.staff.id;
    const { email, phone, name, amount, notes, idempotencyKey } = req.body;

    // Validate input
    if (!email && !phone) {
      return res.status(400).json({ error: 'Email ou téléphone requis' });
    }
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    // Cashier transaction limit (200€)
    if (req.staff.role === 'cashier' && parseFloat(amount) > 200) {
      return res.status(403).json({ error: 'Montant maximum de 200€ pour un caissier' });
    }

    const result = creditPoints({
      merchantId,
      staffId,
      email: email || null,
      phone: phone || null,
      name: name || null,
      amount: parseFloat(amount),
      notes: notes || null,
      idempotencyKey: idempotencyKey || null,
      source: 'manual',
    });

    // Audit (skip if idempotent return)
    if (!result.idempotent) {
      logAudit({
        ...auditCtx(req),
        actorType: 'staff',
        actorId: staffId,
        merchantId,
        action: 'points_credited',
        targetType: 'merchant_client',
        targetId: result.merchantClient.id,
        details: {
          amount: parseFloat(amount),
          pointsDelta: result.transaction.points_delta,
          isNewClient: result.isNewClient,
        },
      });

      // Fire-and-forget emails
      const merchant = merchantQueries.findById.get(merchantId);
      if (result.isNewClient && result.endUser.email) {
        sendValidationEmail(result.endUser.email, result.endUser.validation_token, merchant.business_name);
      }
      if (result.endUser.email && result.endUser.email_validated) {
        sendPointsCreditedEmail(
          result.endUser.email,
          result.transaction.points_delta,
          result.merchantClient.points_balance,
          merchant.business_name,
          { points_for_reward: merchant.points_for_reward, reward_description: merchant.reward_description }
        );
      }
    }

    res.json({
      message: result.isNewClient ? 'Nouveau client créé et points crédités' : 'Points crédités',
      client: {
        id: result.merchantClient.id,
        email: result.endUser.email,
        phone: result.endUser.phone,
        name: result.endUser.name,
        points_balance: result.merchantClient.points_balance,
        total_spent: result.merchantClient.total_spent,
        visit_count: result.merchantClient.visit_count,
      },
      transaction: {
        amount: parseFloat(amount),
        points_delta: result.transaction.points_delta,
      },
      isNewClient: result.isNewClient,
    });
  } catch (error) {
    console.error('Erreur crédit:', error);
    res.status(error.message.includes('bloqué') ? 403 : 500).json({ error: error.message });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/clients/reward — Redeem reward (cashier+)
// ═══════════════════════════════════════════════════════

router.post('/reward', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { merchantClientId, notes, idempotencyKey } = req.body;

    if (!merchantClientId) {
      return res.status(400).json({ error: 'ID client requis' });
    }

    const result = redeemReward({
      merchantId,
      merchantClientId: parseInt(merchantClientId),
      staffId: req.staff.id,
      notes: notes || null,
      idempotencyKey: idempotencyKey || null,
    });

    if (!result.idempotent) {
      logAudit({
        ...auditCtx(req),
        actorType: 'staff',
        actorId: req.staff.id,
        merchantId,
        action: 'reward_redeemed',
        targetType: 'merchant_client',
        targetId: parseInt(merchantClientId),
        details: { pointsDelta: result.transaction.points_delta },
      });
    }

    res.json({
      message: 'Récompense appliquée',
      client: result.merchantClient,
      transaction: result.transaction,
    });
  } catch (error) {
    console.error('Erreur reward:', error);
    const status = error.message.includes('insuffisant') ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/clients/adjust — Manual adjustment (owner/manager)
// ═══════════════════════════════════════════════════════

router.post('/adjust', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { merchantClientId, pointsDelta, reason } = req.body;

    if (!merchantClientId || pointsDelta === undefined) {
      return res.status(400).json({ error: 'ID client et ajustement requis' });
    }

    const result = adjustPoints({
      merchantId,
      merchantClientId: parseInt(merchantClientId),
      pointsDelta: parseInt(pointsDelta),
      staffId: req.staff.id,
      reason: reason || '',
    });

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId,
      action: 'points_adjusted',
      targetType: 'merchant_client',
      targetId: parseInt(merchantClientId),
      details: { pointsDelta: parseInt(pointsDelta), reason },
    });

    res.json({
      message: 'Ajustement effectué',
      client: result.merchantClient,
      transaction: result.transaction,
    });
  } catch (error) {
    console.error('Erreur adjustment:', error);
    res.status(400).json({ error: error.message });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/clients/lookup?email=...&phone=...
// Minimal info for cashier credit screen.
// Returns: name, balance, reward progress. NOT full history.
// ═══════════════════════════════════════════════════════

router.get('/lookup', (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { email, phone } = req.query;

    if (!email && !phone) {
      return res.status(400).json({ error: 'Email ou téléphone requis' });
    }

    const emailLower = normalizeEmail(email);
    const phoneE164 = normalizePhone(phone);

    // Use the same 3-step lookup as the points service but read-only
    let endUser = null;
    if (emailLower) {
      endUser = endUserQueries.findByEmailLower.get(emailLower);
    }
    if (!endUser && phoneE164) {
      endUser = endUserQueries.findByPhoneE164.get(phoneE164);
    }
    // Check aliases (post-merge identifiers)
    if (!endUser && emailLower) {
      const alias = aliasQueries.findByValue.get(emailLower);
      if (alias) {
        endUser = endUserQueries.findById.get(alias.end_user_id);
      }
    }
    if (!endUser && phoneE164) {
      const alias = aliasQueries.findByValue.get(phoneE164);
      if (alias) {
        endUser = endUserQueries.findById.get(alias.end_user_id);
      }
    }

    if (!endUser) {
      return res.json({ found: false });
    }

    // Check merchant_client relationship
    const mc = merchantClientQueries.find.get(merchantId, endUser.id);
    if (!mc) {
      return res.json({
        found: true,
        isNew: true,
        client: { name: endUser.name, email: endUser.email, phone: endUser.phone },
      });
    }

    // Get merchant settings for reward progress
    const merchant = merchantQueries.findById.get(merchantId);

    res.json({
      found: true,
      isNew: false,
      client: {
        id: mc.id,
        name: endUser.name,
        email: endUser.email,
        phone: endUser.phone,
        points_balance: mc.points_balance,
        visit_count: mc.visit_count,
        is_blocked: mc.is_blocked,
        reward_threshold: merchant.points_for_reward,
        reward_description: merchant.reward_description,
        can_redeem: mc.points_balance >= merchant.points_for_reward,
      },
    });
  } catch (error) {
    console.error('Erreur lookup:', error);
    res.status(500).json({ error: 'Erreur lors de la recherche' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/clients — List all clients (owner/manager)
// ═══════════════════════════════════════════════════════

router.get('/', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const clients = merchantClientQueries.getByMerchant.all(merchantId);

    res.json({ count: clients.length, clients });
  } catch (error) {
    console.error('Erreur liste clients:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des clients' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/clients/search?q=... — Search clients (owner/manager)
// ═══════════════════════════════════════════════════════

router.get('/search', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Recherche trop courte (min 2 caractères)' });
    }

    const term = `%${q.toLowerCase()}%`;
    const clients = merchantClientQueries.searchByMerchant.all(merchantId, term, term, term);

    res.json({ count: clients.length, clients });
  } catch (error) {
    console.error('Erreur recherche:', error);
    res.status(500).json({ error: 'Erreur lors de la recherche' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/clients/export/csv — Export CSV (owner only)
// MUST be before /:id to avoid route collision
// ═══════════════════════════════════════════════════════

router.get('/export/csv', requireRole('owner'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const clients = merchantClientQueries.getByMerchant.all(merchantId);

    let csv = 'Email,Téléphone,Nom,Points,Total dépensé,Visites,Première visite,Dernière visite,Email validé,Bloqué\n';
    clients.forEach(c => {
      csv += `"${c.email || ''}","${c.phone || ''}","${c.name || ''}",${c.points_balance},${c.total_spent},${c.visit_count},"${c.first_visit}","${c.last_visit}",${c.email_validated ? 'Oui' : 'Non'},${c.is_blocked ? 'Oui' : 'Non'}\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=clients.csv');
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8
  } catch (error) {
    console.error('Erreur export CSV:', error);
    res.status(500).json({ error: 'Erreur lors de l\'export' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/clients/activity — Recent activity for dashboard
// Returns transactions enriched with client info + reward status
// MUST be before /:id to avoid route collision
// ═══════════════════════════════════════════════════════

const activityQuery = db.prepare(`
  SELECT t.id, t.amount, t.points_delta, t.transaction_type, t.source, t.notes, t.created_at,
         eu.email, eu.phone, eu.name as client_name,
         sa.display_name as staff_name,
         mc.points_balance
  FROM transactions t
  JOIN merchant_clients mc ON t.merchant_client_id = mc.id
  JOIN end_users eu ON mc.end_user_id = eu.id
  LEFT JOIN staff_accounts sa ON t.staff_id = sa.id
  WHERE t.merchant_id = ?
  ORDER BY t.created_at DESC
  LIMIT ?
`);

router.get('/activity', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const merchant = merchantQueries.findById.get(merchantId);

    const rows = activityQuery.all(merchantId, limit);

    const activity = rows.map(r => ({
      ...r,
      can_redeem: r.points_balance >= merchant.points_for_reward,
    }));

    res.json({ count: activity.length, activity });
  } catch (error) {
    console.error('Erreur activity:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de l\'activité' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/clients/:id — Client details + transaction history (owner/manager)
// ═══════════════════════════════════════════════════════

router.get('/:id', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const mcId = parseInt(req.params.id);

    const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, merchantId);
    if (!mc) {
      return res.status(404).json({ error: 'Client non trouvé' });
    }

    const endUser = endUserQueries.findById.get(mc.end_user_id);
    const transactions = transactionQueries.getByMerchantClient.all(mc.id);
    const merchant = merchantQueries.findById.get(merchantId);

    res.json({
      client: {
        ...mc,
        email: endUser?.email,
        phone: endUser?.phone,
        name: endUser?.name,
        email_validated: endUser?.email_validated,
        reward_threshold: merchant.points_for_reward,
        reward_description: merchant.reward_description,
        can_redeem: mc.points_balance >= merchant.points_for_reward,
      },
      transactions,
    });
  } catch (error) {
    console.error('Erreur détails client:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération du client' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/clients/:id/block — Block a client (owner/manager)
// ═══════════════════════════════════════════════════════

router.post('/:id/block', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const mcId = parseInt(req.params.id);

    const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, merchantId);
    if (!mc) {
      return res.status(404).json({ error: 'Client non trouvé' });
    }

    merchantClientQueries.block.run(mcId);

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId,
      action: 'client_blocked',
      targetType: 'merchant_client',
      targetId: mcId,
    });

    res.json({ message: 'Client bloqué' });
  } catch (error) {
    console.error('Erreur blocage:', error);
    res.status(500).json({ error: 'Erreur lors du blocage' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/clients/:id/unblock — Unblock a client (owner/manager)
// ═══════════════════════════════════════════════════════

router.post('/:id/unblock', requireRole('owner', 'manager'), (req, res) => {
  try {
    const merchantId = req.staff.merchant_id;
    const mcId = parseInt(req.params.id);

    const mc = merchantClientQueries.findByIdAndMerchant.get(mcId, merchantId);
    if (!mc) {
      return res.status(404).json({ error: 'Client non trouvé' });
    }

    merchantClientQueries.unblock.run(mcId);

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId,
      action: 'client_unblocked',
      targetType: 'merchant_client',
      targetId: mcId,
    });

    res.json({ message: 'Client débloqué' });
  } catch (error) {
    console.error('Erreur déblocage:', error);
    res.status(500).json({ error: 'Erreur lors du déblocage' });
  }
});


module.exports = router;
