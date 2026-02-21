const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const {
  db,
  endUserQueries,
  aliasQueries,
  merchantClientQueries,
  merchantQueries,
  transactionQueries,
} = require('../database');
const { normalizeEmail, canonicalizeEmail, normalizePhone } = require('./normalizer');
const { pushPointsCredited, pushRewardAvailable, pushRewardRedeemed } = require('./push');

// ═══════════════════════════════════════════════════════
// FIND OR CREATE END USER
// 3-step lookup: end_users → aliases → create
// ═══════════════════════════════════════════════════════

function findOrCreateEndUser({ email, phone, name, pinHash = null }) {
  const emailLower = normalizeEmail(email);
  const emailCanonical = canonicalizeEmail(email);
  const phoneE164 = normalizePhone(phone);

  if (!emailLower && !phoneE164) {
    throw new Error('Email ou téléphone requis');
  }

  // ── Step 1: direct lookup on end_users ──
  let endUser = null;

  if (emailLower) {
    endUser = endUserQueries.findByEmailLower.get(emailLower);
  }
  if (!endUser && phoneE164) {
    endUser = endUserQueries.findByPhoneE164.get(phoneE164);
  }

  // ── Step 1b: Gmail dedup — canonical email lookup ──
  // hakim.abbes+75@gmail.com matches hakim.abbes@gmail.com
  if (!endUser && emailCanonical && emailCanonical !== emailLower) {
    endUser = endUserQueries.findByCanonicalEmail.get(emailCanonical);
  }

  if (endUser) {
    return { endUser, isNew: false };
  }

  // ── Step 2: search aliases (post-merge identifiers) ──
  if (emailLower) {
    const alias = aliasQueries.findByValue.get(emailLower);
    if (alias) {
      endUser = endUserQueries.findById.get(alias.end_user_id);
      if (endUser) return { endUser, isNew: false };
    }
  }
  if (phoneE164) {
    const alias = aliasQueries.findByValue.get(phoneE164);
    if (alias) {
      endUser = endUserQueries.findById.get(alias.end_user_id);
      if (endUser) return { endUser, isNew: false };
    }
  }

  // ── Step 3: create new end_user ──
  const validationToken = crypto.randomUUID();
  const result = endUserQueries.create.run(
    email || null,
    phone || null,
    emailLower,
    phoneE164,
    name || null,
    validationToken
  );

  endUser = endUserQueries.findById.get(result.lastInsertRowid);

  // Store canonical email for future dedup
  if (endUser && emailCanonical) {
    db.prepare("UPDATE end_users SET email_canonical = ? WHERE id = ?").run(emailCanonical, endUser.id);
  }

  // Generate unique QR token for client portal
  if (endUser) {
    const qrToken = crypto.randomBytes(8).toString('base64url');
    endUserQueries.setQrToken.run(qrToken, endUser.id);
    endUser = endUserQueries.findById.get(endUser.id);
  }

  // Auto-validate email — client is physically present at the merchant counter
  if (endUser && emailLower) {
    db.prepare("UPDATE end_users SET email_validated = 1, consent_date = datetime('now'), consent_method = 'merchant_credit', updated_at = datetime('now') WHERE id = ?")
      .run(endUser.id);
    endUser = endUserQueries.findById.get(endUser.id);
  }

  // Set PIN if provided (new client only)
  if (pinHash && endUser) {
    endUserQueries.setPin.run(pinHash, endUser.id);
    endUser = endUserQueries.findById.get(endUser.id);
  }

  return { endUser, isNew: true };
}


// ═══════════════════════════════════════════════════════
// FIND OR CREATE MERCHANT CLIENT
// ═══════════════════════════════════════════════════════

function findOrCreateMerchantClient(merchantId, endUserId) {
  let mc = merchantClientQueries.find.get(merchantId, endUserId);

  if (mc) {
    return { merchantClient: mc, isNew: false };
  }

  const result = merchantClientQueries.create.run(merchantId, endUserId);
  mc = merchantClientQueries.findById.get(result.lastInsertRowid);
  return { merchantClient: mc, isNew: true };
}


// ═══════════════════════════════════════════════════════
// CREDIT POINTS
// ═══════════════════════════════════════════════════════

function creditPoints({
  merchantId,
  staffId = null,
  email = null,
  phone = null,
  name = null,
  amount,
  notes = null,
  idempotencyKey = null,
  source = 'manual',
  pinHash = null,
}) {
  const merchant = merchantQueries.findById.get(merchantId);
  if (!merchant) throw new Error('Commerce non trouvé');

  const isVisits = merchant.loyalty_mode === 'visits';

  if (!isVisits && (!amount || amount <= 0)) {
    throw new Error('Montant invalide');
  }

  const pointsDelta = isVisits ? 1 : Math.floor(amount * merchant.points_per_euro);

  // Idempotency check
  if (idempotencyKey) {
    const existing = transactionQueries.findByIdempotencyKey.get(merchantId, idempotencyKey);
    if (existing) {
      const mc = merchantClientQueries.findById.get(existing.merchant_client_id);
      const eu = endUserQueries.findById.get(mc.end_user_id);
      return {
        endUser: eu,
        merchantClient: mc,
        transaction: existing,
        isNewClient: false,
        isNewRelation: false,
        idempotent: true,
      };
    }
  }

  const run = db.transaction(() => {
    const { endUser, isNew: isNewClient } = findOrCreateEndUser({ email, phone, name, pinHash });

    if (endUser.is_blocked) {
      throw new Error('Ce client est bloqué');
    }

    const { merchantClient, isNew: isNewRelation } = findOrCreateMerchantClient(merchantId, endUser.id);

    // (local_email/local_phone overrides removed — merchant can no longer dissociate identifiers)

    if (merchantClient.is_blocked) {
      throw new Error('Ce client est bloqué dans votre commerce');
    }

    const txResult = transactionQueries.create.run(
      merchantId,
      merchantClient.id,
      staffId,
      amount,
      pointsDelta,
      'credit',
      idempotencyKey,
      source,
      notes
    );

    merchantClientQueries.updateAfterCredit.run(pointsDelta, amount, merchantClient.id);

    const updatedMC = merchantClientQueries.findById.get(merchantClient.id);
    const tx = { id: txResult.lastInsertRowid, points_delta: pointsDelta, amount };

    return {
      endUser,
      merchantClient: updatedMC,
      transaction: tx,
      isNewClient,
      isNewRelation,
      idempotent: false,
    };
  });

  const result = run();

  // 🔔 Fire-and-forget push notifications
  if (!result.idempotent) {
    const merchant = merchantQueries.findById.get(merchantId);
    // Notify: points credited
    pushPointsCredited(
      result.endUser.id,
      merchant.business_name,
      result.transaction.points_delta,
      result.merchantClient.points_balance
    ).catch(() => {});

    // Notify: reward now available (if threshold just crossed)
    if (result.merchantClient.points_balance >= merchant.points_for_reward) {
      const prevBalance = result.merchantClient.points_balance - result.transaction.points_delta;
      if (prevBalance < merchant.points_for_reward) {
        pushRewardAvailable(
          result.endUser.id,
          merchant.business_name,
          result.merchantClient.custom_reward || merchant.reward_description
        ).catch(() => {});
      }
    }
  }

  return result;
}


// ═══════════════════════════════════════════════════════
// REDEEM REWARD (debit points)
// Uses custom_reward if set, otherwise default merchant reward
// ═══════════════════════════════════════════════════════

async function redeemReward({
  merchantId,
  merchantClientId,
  staffId = null,
  notes = null,
  idempotencyKey = null,
  pin = null,
  qrVerified = false,
}) {
  const merchant = merchantQueries.findById.get(merchantId);
  if (!merchant) throw new Error('Commerce non trouvé');

  const pointsToDeduct = merchant.points_for_reward;

  // Idempotency
  if (idempotencyKey) {
    const existing = transactionQueries.findByIdempotencyKey.get(merchantId, idempotencyKey);
    if (existing) {
      const mc = merchantClientQueries.findById.get(existing.merchant_client_id);
      return { merchantClient: mc, transaction: existing, idempotent: true };
    }
  }

  // ── PIN verification (before transaction for early fail) ──
  // QR scan bypasses PIN — the scan itself proves client presence & consent
  const mcCheck = merchantClientQueries.findByIdAndMerchant.get(merchantClientId, merchantId);
  if (!mcCheck) throw new Error('Client non trouvé');

  const endUser = endUserQueries.findById.get(mcCheck.end_user_id);
  if (!endUser) throw new Error('Client non trouvé');

  if (!qrVerified) {
    if (!endUser.pin_hash) {
      throw new Error('Ce client n\'a pas de code PIN. Veuillez en définir un avant de réclamer la récompense.');
    }
    if (!pin) {
      throw new Error('Code PIN requis pour appliquer la récompense');
    }
    if (!(await bcrypt.compare(pin, endUser.pin_hash))) {
      throw new Error('Code PIN incorrect');
    }
  }

  const run = db.transaction(() => {
    const mc = merchantClientQueries.findByIdAndMerchant.get(merchantClientId, merchantId);
    if (!mc) throw new Error('Client non trouvé');

    if (mc.points_balance < pointsToDeduct) {
      throw new Error(`Solde insuffisant (${mc.points_balance}/${pointsToDeduct} points)`);
    }

    // Use custom reward if set, otherwise merchant default
    const rewardLabel = mc.custom_reward || merchant.reward_description;

    const txResult = transactionQueries.create.run(
      merchantId,
      mc.id,
      staffId,
      null,
      -pointsToDeduct,
      'reward',
      idempotencyKey,
      'manual',
      notes || `Récompense : ${rewardLabel}`
    );

    merchantClientQueries.setPoints.run(mc.points_balance - pointsToDeduct, mc.id);

    const updatedMC = merchantClientQueries.findById.get(mc.id);
    return {
      merchantClient: updatedMC,
      transaction: { id: txResult.lastInsertRowid, points_delta: -pointsToDeduct },
      rewardLabel,
      idempotent: false,
    };
  });

  const result = run();

  // 🔔 Fire-and-forget push: reward redeemed
  if (!result.idempotent) {
    const merchant = merchantQueries.findById.get(merchantId);
    pushRewardRedeemed(
      endUser.id,
      merchant.business_name,
      result.rewardLabel,
      result.merchantClient.points_balance
    ).catch(() => {});
  }

  return result;
}


// ═══════════════════════════════════════════════════════
// ADJUST POINTS (manual correction by owner/manager)
// ═══════════════════════════════════════════════════════

function adjustPoints({ merchantId, merchantClientId, pointsDelta, staffId, reason }) {
  if (!pointsDelta || pointsDelta === 0) {
    throw new Error('Ajustement de 0 points non autorisé');
  }
  if (!reason || !reason.trim()) {
    throw new Error('Raison requise pour un ajustement');
  }

  const run = db.transaction(() => {
    const mc = merchantClientQueries.findByIdAndMerchant.get(merchantClientId, merchantId);
    if (!mc) throw new Error('Client non trouvé');

    const newBalance = mc.points_balance + pointsDelta;
    if (newBalance < 0) {
      throw new Error(`Ajustement impossible : le solde deviendrait négatif (${newBalance})`);
    }

    const txResult = transactionQueries.create.run(
      merchantId,
      mc.id,
      staffId,
      null,
      pointsDelta,
      'adjustment',
      null,
      'manual',
      reason.trim()
    );

    merchantClientQueries.setPoints.run(newBalance, mc.id);

    const updatedMC = merchantClientQueries.findById.get(mc.id);
    return {
      merchantClient: updatedMC,
      transaction: { id: txResult.lastInsertRowid, points_delta: pointsDelta },
    };
  });

  return run();
}


module.exports = {
  findOrCreateEndUser,
  findOrCreateMerchantClient,
  creditPoints,
  redeemReward,
  adjustPoints,
};
