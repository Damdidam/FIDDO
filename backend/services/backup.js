// ═══════════════════════════════════════════════════════
// services/backup.js
// Full merchant data export & import
// ═══════════════════════════════════════════════════════

const { db, merchantQueries, merchantClientQueries, transactionQueries, endUserQueries, staffQueries } = require('../database');

// ═══════════════════════════════════════════════════════
// EXPORT — Generate complete merchant data snapshot
// ═══════════════════════════════════════════════════════

/**
 * Export ALL data for a merchant as a structured JSON object.
 * Includes: merchant settings, staff, clients, end_users, transactions, preferences.
 *
 * @param {number} merchantId
 * @returns {Object} Complete backup payload
 */
function exportMerchantData(merchantId) {
  const merchant = merchantQueries.findById.get(merchantId);
  if (!merchant) throw new Error('Commerce non trouvé');

  // Staff accounts (excluding passwords)
  const staff = staffQueries.getByMerchant.all(merchantId);

  // Merchant clients (with joined end_user data)
  const clients = merchantClientQueries.getByMerchant.all(merchantId);

  // All end_user IDs linked to this merchant
  const endUserIds = new Set(clients.map(c => c.end_user_id));

  // Full end_user records for these IDs
  const endUsers = [];
  for (const euId of endUserIds) {
    const eu = endUserQueries.findById.get(euId);
    if (eu) endUsers.push(eu);
  }

  // All transactions for this merchant
  const transactions = db.prepare(`
    SELECT t.*, sa.display_name as staff_name
    FROM transactions t
    LEFT JOIN staff_accounts sa ON t.staff_id = sa.id
    WHERE t.merchant_id = ?
    ORDER BY t.created_at ASC
  `).all(merchantId);

  // Merchant clients raw (without join, for full data)
  const merchantClients = db.prepare(`
    SELECT * FROM merchant_clients WHERE merchant_id = ?
  `).all(merchantId);

  // Preferences
  const preferences = db.prepare(
    'SELECT * FROM merchant_preferences WHERE merchant_id = ?'
  ).get(merchantId) || null;

  // Build export
  const backup = {
    _meta: {
      version: '3.3.0',
      type: 'fiddo_merchant_backup',
      exported_at: new Date().toISOString(),
      merchant_id: merchantId,
      business_name: merchant.business_name,
    },
    merchant: {
      business_name: merchant.business_name,
      address: merchant.address,
      vat_number: merchant.vat_number,
      email: merchant.email,
      phone: merchant.phone,
      owner_phone: merchant.owner_phone,
      points_per_euro: merchant.points_per_euro,
      points_for_reward: merchant.points_for_reward,
      reward_description: merchant.reward_description,
    },
    preferences,
    staff: staff.map(s => ({
      email: s.email,
      display_name: s.display_name,
      role: s.role,
      is_active: s.is_active,
      created_at: s.created_at,
    })),
    end_users: endUsers.map(eu => ({
      id: eu.id,
      email: eu.email,
      phone: eu.phone,
      email_lower: eu.email_lower,
      phone_e164: eu.phone_e164,
      name: eu.name,
      email_validated: eu.email_validated,
      consent_date: eu.consent_date,
      is_blocked: eu.is_blocked,
      created_at: eu.created_at,
    })),
    merchant_clients: merchantClients.map(mc => ({
      id: mc.id,
      end_user_id: mc.end_user_id,
      points_balance: mc.points_balance,
      total_spent: mc.total_spent,
      visit_count: mc.visit_count,
      is_blocked: mc.is_blocked,
      notes_private: mc.notes_private,
      custom_reward: mc.custom_reward,
      local_email: mc.local_email,
      local_phone: mc.local_phone,
      first_visit: mc.first_visit,
      last_visit: mc.last_visit,
      created_at: mc.created_at,
    })),
    transactions: transactions.map(t => ({
      id: t.id,
      merchant_client_id: t.merchant_client_id,
      staff_name: t.staff_name,
      amount: t.amount,
      points_delta: t.points_delta,
      transaction_type: t.transaction_type,
      source: t.source,
      notes: t.notes,
      created_at: t.created_at,
    })),
    _stats: {
      total_clients: merchantClients.length,
      total_end_users: endUsers.length,
      total_transactions: transactions.length,
      total_staff: staff.length,
    },
  };

  return backup;
}


// ═══════════════════════════════════════════════════════
// VALIDATE — Check backup file structure before import
// ═══════════════════════════════════════════════════════

/**
 * Validate a backup payload and return a preview summary.
 *
 * @param {Object} data - Parsed JSON backup
 * @returns {{ valid: boolean, errors: string[], preview: Object }}
 */
function validateBackup(data) {
  const errors = [];

  // Structure checks
  if (!data._meta || data._meta.type !== 'fiddo_merchant_backup') {
    errors.push('Fichier invalide : ce n\'est pas un backup FIDDO');
    return { valid: false, errors, preview: null };
  }

  if (!data.merchant) errors.push('Section "merchant" manquante');
  if (!data.end_users || !Array.isArray(data.end_users)) errors.push('Section "end_users" manquante ou invalide');
  if (!data.merchant_clients || !Array.isArray(data.merchant_clients)) errors.push('Section "merchant_clients" manquante ou invalide');
  if (!data.transactions || !Array.isArray(data.transactions)) errors.push('Section "transactions" manquante ou invalide');

  if (errors.length > 0) {
    return { valid: false, errors, preview: null };
  }

  // Data integrity checks
  const euIds = new Set(data.end_users.map(eu => eu.id));
  const mcIds = new Set(data.merchant_clients.map(mc => mc.id));

  // Check that all merchant_clients reference valid end_users
  for (const mc of data.merchant_clients) {
    if (!euIds.has(mc.end_user_id)) {
      errors.push(`merchant_client #${mc.id} référence un end_user #${mc.end_user_id} absent du backup`);
    }
  }

  // Check that all transactions reference valid merchant_clients
  for (const tx of data.transactions) {
    if (!mcIds.has(tx.merchant_client_id)) {
      errors.push(`Transaction #${tx.id} référence un merchant_client #${tx.merchant_client_id} absent du backup`);
    }
  }

  // Limit error reporting
  if (errors.length > 10) {
    errors.splice(10);
    errors.push('... (erreurs supplémentaires tronquées)');
  }

  const preview = {
    exported_at: data._meta.exported_at,
    business_name: data._meta.business_name,
    version: data._meta.version,
    clients: data.merchant_clients.length,
    end_users: data.end_users.length,
    transactions: data.transactions.length,
    staff: data.staff ? data.staff.length : 0,
    total_points: data.merchant_clients.reduce((s, mc) => s + mc.points_balance, 0),
    total_spent: data.merchant_clients.reduce((s, mc) => s + mc.total_spent, 0),
  };

  return { valid: errors.length === 0, errors, preview };
}


// ═══════════════════════════════════════════════════════
// IMPORT — Restore merchant data from backup
// ⚠️ DESTRUCTIVE: replaces ALL current data for this merchant
// ═══════════════════════════════════════════════════════

/**
 * Import a validated backup, replacing all client/transaction data.
 * Wrapped in a single transaction for atomicity.
 *
 * Strategy:
 * 1. Delete existing transactions for this merchant
 * 2. Delete existing merchant_clients for this merchant
 * 3. For each end_user in backup: find-or-create by email/phone
 * 4. Re-create merchant_clients with backup balances
 * 5. Re-create transactions
 *
 * @param {number} merchantId
 * @param {Object} data - Validated backup payload
 * @returns {Object} Import summary
 */
function importMerchantData(merchantId, data) {
  const { valid, errors } = validateBackup(data);
  if (!valid) {
    throw new Error('Backup invalide : ' + errors.join(', '));
  }

  const run = db.transaction(() => {
    // ── Phase 1: Clean existing data ──
    const existingMCs = db.prepare('SELECT id FROM merchant_clients WHERE merchant_id = ?').all(merchantId);
    const existingMCIds = existingMCs.map(mc => mc.id);

    // Delete transactions for this merchant
    db.prepare('DELETE FROM transactions WHERE merchant_id = ?').run(merchantId);

    // Delete merchant_clients for this merchant
    db.prepare('DELETE FROM merchant_clients WHERE merchant_id = ?').run(merchantId);

    // ── Phase 2: Restore end_users (find-or-create) ──
    // Maps old end_user IDs → new IDs
    const euIdMap = new Map();

    const findByEmail = db.prepare('SELECT id FROM end_users WHERE email_lower = ? AND deleted_at IS NULL');
    const findByPhone = db.prepare('SELECT id FROM end_users WHERE phone_e164 = ? AND deleted_at IS NULL');
    const createEndUser = db.prepare(`
      INSERT INTO end_users (email, phone, email_lower, phone_e164, name, email_validated, consent_date, is_blocked, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    for (const eu of data.end_users) {
      let existingId = null;

      // Try to find existing end_user by email or phone
      if (eu.email_lower) {
        const found = findByEmail.get(eu.email_lower);
        if (found) existingId = found.id;
      }
      if (!existingId && eu.phone_e164) {
        const found = findByPhone.get(eu.phone_e164);
        if (found) existingId = found.id;
      }

      if (existingId) {
        euIdMap.set(eu.id, existingId);
      } else {
        // Create new end_user
        const result = createEndUser.run(
          eu.email, eu.phone, eu.email_lower, eu.phone_e164,
          eu.name, eu.email_validated || 0, eu.consent_date,
          eu.is_blocked || 0, eu.created_at || new Date().toISOString()
        );
        euIdMap.set(eu.id, result.lastInsertRowid);
      }
    }

    // ── Phase 3: Restore merchant_clients ──
    const mcIdMap = new Map(); // old mc ID → new mc ID

    const createMC = db.prepare(`
      INSERT INTO merchant_clients
        (merchant_id, end_user_id, points_balance, total_spent, visit_count,
         is_blocked, notes_private, custom_reward, local_email, local_phone,
         first_visit, last_visit, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    for (const mc of data.merchant_clients) {
      const newEuId = euIdMap.get(mc.end_user_id);
      if (!newEuId) continue; // Skip if end_user wasn't found/created

      const result = createMC.run(
        merchantId, newEuId,
        mc.points_balance, mc.total_spent, mc.visit_count,
        mc.is_blocked || 0, mc.notes_private,
        mc.custom_reward || null, mc.local_email || null, mc.local_phone || null,
        mc.first_visit, mc.last_visit, mc.created_at
      );
      mcIdMap.set(mc.id, result.lastInsertRowid);
    }

    // ── Phase 4: Restore transactions ──
    const createTx = db.prepare(`
      INSERT INTO transactions
        (merchant_id, merchant_client_id, staff_id, amount, points_delta,
         transaction_type, idempotency_key, source, notes, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?)
    `);

    let txCount = 0;
    for (const tx of data.transactions) {
      const newMcId = mcIdMap.get(tx.merchant_client_id);
      if (!newMcId) continue; // Skip orphan transactions

      createTx.run(
        merchantId, newMcId,
        tx.amount, tx.points_delta, tx.transaction_type,
        tx.source, tx.notes, tx.created_at
      );
      txCount++;
    }

    // ── Phase 5: Restore merchant settings (optional) ──
    if (data.merchant) {
      db.prepare(`
        UPDATE merchants SET
          points_per_euro = ?, points_for_reward = ?, reward_description = ?
        WHERE id = ?
      `).run(
        data.merchant.points_per_euro,
        data.merchant.points_for_reward,
        data.merchant.reward_description || 'Récompense offerte',
        merchantId
      );
    }

    return {
      end_users_restored: euIdMap.size,
      clients_restored: mcIdMap.size,
      transactions_restored: txCount,
    };
  });

  return run();
}


module.exports = {
  exportMerchantData,
  validateBackup,
  importMerchantData,
};
