// ═══════════════════════════════════════════════════════
// FIDDO — Test Setup
// Sets DB_PATH before anything else loads
// ═══════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const os = require('os');

// Create a unique temp DB for this test run
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiddo-test-'));
const dbPath = path.join(tmpDir, 'test.db');

// Set env BEFORE requiring any app modules
process.env.DB_PATH = dbPath;
process.env.JWT_SECRET = 'test-secret-key-12345';
process.env.ADMIN_JWT_SECRET = 'test-admin-secret-12345';
process.env.SMTP_USER = ''; // Disable emails in tests

// Now require app modules
const app = require('../server');
const { db, merchantQueries, endUserQueries, merchantClientQueries } = require('../database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function createMerchant(overrides = {}) {
  const defaults = {
    business_name: 'Café Test',
    address: '1 Rue du Test, Bruxelles',
    vat_number: 'BE0123456789',
    email: 'cafe@test.be',
    phone: '+32470000000',
    owner_phone: '+32470000001',
    points_per_euro: 1,
    points_for_reward: 50,
    reward_description: 'Dessert offert',
  };
  const data = { ...defaults, ...overrides };

  const result = db.prepare(`
    INSERT INTO merchants (business_name, address, vat_number, email, phone, owner_phone,
      points_per_euro, points_for_reward, reward_description, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    data.business_name, data.address, data.vat_number, data.email,
    data.phone, data.owner_phone, data.points_per_euro,
    data.points_for_reward, data.reward_description
  );

  const merchant = merchantQueries.findById.get(result.lastInsertRowid);

  // Generate QR token
  const crypto = require('crypto');
  const qrToken = crypto.randomBytes(8).toString('base64url');
  db.prepare('UPDATE merchants SET qr_token = ? WHERE id = ?').run(qrToken, merchant.id);

  return { ...merchant, qr_token: qrToken };
}

function createStaff(merchantId, overrides = {}) {
  const defaults = {
    email: 'staff@test.be',
    display_name: 'Staff Test',
    role: 'owner',
    password: 'test1234',
  };
  const data = { ...defaults, ...overrides };
  const hash = bcrypt.hashSync(data.password, 10);

  const result = db.prepare(`
    INSERT INTO staff_accounts (merchant_id, email, display_name, password_hash, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(merchantId, data.email, data.display_name, hash, data.role);

  return db.prepare('SELECT * FROM staff_accounts WHERE id = ?').get(result.lastInsertRowid);
}

function getStaffToken(staff) {
  return jwt.sign(
    { staffId: staff.id, merchantId: staff.merchant_id, role: staff.role },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function getClientToken(endUserId) {
  return jwt.sign(
    { endUserId },
    process.env.JWT_SECRET,
    { expiresIn: '90d' }
  );
}

function createEndUser(overrides = {}) {
  const crypto = require('crypto');
  const defaults = {
    email: 'client@test.be',
    phone: '+32470111111',
    name: 'Jean Dupont',
  };
  const data = { ...defaults, ...overrides };
  const emailLower = data.email ? data.email.toLowerCase() : null;
  const qrToken = crypto.randomBytes(8).toString('base64url');

  const result = db.prepare(`
    INSERT INTO end_users (email, phone, email_lower, phone_e164, name, email_validated, qr_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))
  `).run(data.email, data.phone, emailLower, data.phone, data.name, qrToken);

  return endUserQueries.findById.get(result.lastInsertRowid);
}

function createMerchantClient(merchantId, endUserId, points = 0) {
  db.prepare(`
    INSERT INTO merchant_clients (merchant_id, end_user_id, points_balance, visit_count, total_spent, last_visit)
    VALUES (?, ?, ?, 1, 0, datetime('now'))
  `).run(merchantId, endUserId, points);

  return merchantClientQueries.find.get(merchantId, endUserId);
}

function cleanup() {
  try {
    // Delete all data in reverse dependency order
    db.exec('DELETE FROM transactions');
    db.exec('DELETE FROM merchant_clients');
    db.exec('DELETE FROM staff_accounts');
    db.exec('DELETE FROM end_users');
    db.exec('DELETE FROM merchants');
    db.exec('DELETE FROM super_admins');
  } catch (e) {
    // ignore
  }
}

module.exports = {
  app,
  db,
  createMerchant,
  createStaff,
  createEndUser,
  createMerchantClient,
  getStaffToken,
  getClientToken,
  cleanup,
  dbPath,
  tmpDir,
};
