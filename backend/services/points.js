const crypto = require('crypto');
const {
  db,
  endUserQueries,
  aliasQueries,
  merchantClientQueries,
  merchantQueries,
  transactionQueries,
} = require('../database');
const { normalizeEmail, normalizePhone } = require('./normalizer');

// ═══════════════════════════════════════════════════════
// FIND OR CREATE END USER
// 3-step lookup: end_users → aliases → create
// ═══════════════════════════════════════════════════════

/**
 * Resolve an email/phone to an end_user, searching aliases if needed.
 * If no match exists, creates a new end_user.
 *
 * @param {Object} params
 * @param {string|null} params.email - raw email input
 * @param {string|null} params.phone - raw phone input
 * @param {string|null} params.name  - optional display name
 * @returns {{ endUser: Object, isNew: boolean }}
 */
function findOrCreateEndUser({ email, phone, name }) {
  const emailLower = normalizeEmail(email);
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
    email || null,       // raw display
    phone || null,       // raw display
    emailLower,          // normalized
    phoneE164,           // normalized
    name || null,
    validationToken
  );

  endUser = endUserQueries.findById.get(result.lastInsertRowid);
  return { endUser, isNew: true };
}


// ═══════════════════════════════════════════════════════
// FIND OR CREATE MERCHANT CLIENT
// ═══════════════════════════════════════════════════════

/**
 * Ensure a merchant_client link exists between a merchant and an end_user.
 *
 * @param {number} merchantId
 * @param {number} endUserId
 * @returns {{ merchantClient: Object, isNew: boolean }}
 */
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
// Full flow: resolve user → ensure link → insert tx → update balance
// All wrapped in a DB transaction for atomicity.
// ═══════════════════════════════════════════════════════

/**
 * Credit points to a client.
 *
 * @param {Object} params
 * @param {number}      params.merchantId
 * @param {number|null} params.staffId
 * @param {string|null} params.email
 * @param {string|null} params.phone
 * @param {string|null} params.name
 * @param {number}      params.amount       - euros spent
 * @param {string|null} params.notes
 * @param {string|null} params.idempotencyKey
 * @param {string}      params.source       - 'manual' | 'qr' | 'api'
 * @returns {Object} { endUser, merchantClient, transaction, isNewClient, isNewRelation }
 */
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
}) {
  // Validate
  if (!amount || amount <= 0) {
    throw new Error('Montant invalide');
  }

  // Get merchant settings
  const merchant = merchantQueries.findById.get(merchantId);
  if (!merchant) throw new Error('Commerce non trouvé');

  const pointsDelta = Math.floor(amount * merchant.points_per_euro);

  // Idempotency check (before the transaction, for early return)
  if (idempotencyKey) {
    const existing = transactionQueries.findByIdempotencyKey.get(merchantId, idempotencyKey);
    if (existing) {
      // Return the existing transaction — standard idempotent behavior
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

  // Run everything in a single DB transaction
  const run = db.transaction(() => {
    // 1. Resolve end_user (3-step lookup or create)
    const { endUser, isNew: isNewClient } = findOrCreateEndUser({ email, phone, name });

    // Check if end_user is blocked globally
    if (endUser.is_blocked) {
      throw new Error('Ce client est bloqué');
    }

    // 2. Ensure merchant_client relationship
    const { merchantClient, isNew: isNewRelation } = findOrCreateMerchantClient(merchantId, endUser.id);

    // Check if merchant_client is blocked locally
    if (merchantClient.is_blocked) {
      throw new Error('Ce client est bloqué dans votre commerce');
    }

    // 3. Insert ledger entry
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

    // 4. Update merchant_client balance + stats
    merchantClientQueries.updateAfterCredit.run(pointsDelta, amount, merchantClient.id);

    // Fetch updated records
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

  return run();
}


// ═══════════════════════════════════════════════════════
// REDEEM REWARD (debit points)
// ═══════════════════════════════════════════════════════

/**
 * Redeem a reward (debit points from a merchant_client).
 *
 * @param {Object} params
 * @param {number}      params.merchantId
 * @param {number}      params.merchantClientId
 * @param {number|null} params.staffId
 * @param {string|null} params.notes
 * @param {string|null} params.idempotencyKey
 * @returns {Object} { merchantClient, transaction }
 */
function redeemReward({
  merchantId,
  merchantClientId,
  staffId = null,
  notes = null,
  idempotencyKey = null,
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

  const run = db.transaction(() => {
    const mc = merchantClientQueries.findByIdAndMerchant.get(merchantClientId, merchantId);
    if (!mc) throw new Error('Client non trouvé');

    if (mc.points_balance < pointsToDeduct) {
      throw new Error(`Solde insuffisant (${mc.points_balance}/${pointsToDeduct} points)`);
    }

    // Insert negative transaction
    const txResult = transactionQueries.create.run(
      merchantId,
      mc.id,
      staffId,
      null,              // no monetary amount for rewards
      -pointsToDeduct,   // negative delta
      'reward',
      idempotencyKey,
      'manual',
      notes || `Récompense : ${merchant.reward_description}`
    );

    // Update balance
    merchantClientQueries.setPoints.run(mc.points_balance - pointsToDeduct, mc.id);

    const updatedMC = merchantClientQueries.findById.get(mc.id);
    return {
      merchantClient: updatedMC,
      transaction: { id: txResult.lastInsertRowid, points_delta: -pointsToDeduct },
      idempotent: false,
    };
  });

  return run();
}


// ═══════════════════════════════════════════════════════
// ADJUST POINTS (manual correction by owner/manager)
// ═══════════════════════════════════════════════════════

/**
 * @param {Object} params
 * @param {number}      params.merchantId
 * @param {number}      params.merchantClientId
 * @param {number}      params.pointsDelta - can be positive or negative
 * @param {number|null} params.staffId
 * @param {string}      params.reason
 * @returns {Object} { merchantClient, transaction }
 */
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
      null,        // no idempotency for manual adjustments
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
