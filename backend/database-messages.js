const { db } = require('./database');

// ═══════════════════════════════════════════════════════
// MESSAGES & INVOICES — Additional tables
// Additive module: does not modify existing database.js
// ═══════════════════════════════════════════════════════

function initMessageTables() {

  // ───────────────────────────────────────────
  // ADMIN MESSAGES (broadcasts from super admin)
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_messages (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      title               TEXT NOT NULL,
      body                TEXT NOT NULL,
      msg_type            TEXT NOT NULL DEFAULT 'info'
                          CHECK(msg_type IN ('info','maintenance','urgent')),
      target_type         TEXT NOT NULL DEFAULT 'all'
                          CHECK(target_type IN ('all','selected')),
      target_merchant_ids TEXT,
      created_by          INTEGER REFERENCES super_admins(id),
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ───────────────────────────────────────────
  // MESSAGE READ TRACKING (per merchant)
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_message_reads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  INTEGER NOT NULL REFERENCES admin_messages(id) ON DELETE CASCADE,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id),
      read_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id, merchant_id)
    )
  `);

  // ───────────────────────────────────────────
  // MERCHANT INVOICES (uploaded by super admin)
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant_invoices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id),
      month       TEXT NOT NULL,
      label       TEXT NOT NULL,
      amount      REAL NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','paid','overdue')),
      file_data   TEXT,
      file_name   TEXT,
      notes       TEXT,
      created_by  INTEGER REFERENCES super_admins(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ───────────────────────────────────────────
  // INDEXES
  // ───────────────────────────────────────────
  // ───────────────────────────────────────────
  // ANNOUNCEMENTS (super admin broadcasts)
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      content         TEXT NOT NULL,
      target_type     TEXT NOT NULL DEFAULT 'all',
      priority        TEXT NOT NULL DEFAULT 'normal',
      created_by      INTEGER REFERENCES super_admins(id),
      expires_at      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS announcement_targets (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      merchant_id     INTEGER NOT NULL REFERENCES merchants(id),
      UNIQUE(announcement_id, merchant_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS announcement_reads (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      staff_id        INTEGER NOT NULL,
      read_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(announcement_id, staff_id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_msg_created     ON admin_messages(created_at);
    CREATE INDEX IF NOT EXISTS ix_msg_type         ON admin_messages(msg_type);
    CREATE INDEX IF NOT EXISTS ix_msg_read_msg     ON admin_message_reads(message_id);
    CREATE INDEX IF NOT EXISTS ix_msg_read_merch   ON admin_message_reads(merchant_id);
    CREATE INDEX IF NOT EXISTS ix_invoice_merchant ON merchant_invoices(merchant_id);
    CREATE INDEX IF NOT EXISTS ix_invoice_month    ON merchant_invoices(month);
  `);

  console.log('✅ Messages & Invoices tables initialized');
}

// Init on require
initMessageTables();


// ═══════════════════════════════════════════════════════
// PREPARED STATEMENTS
// ═══════════════════════════════════════════════════════

// ─── Admin Messages ──────────────────────────────────

const messageQueries = {
  create: db.prepare(`
    INSERT INTO admin_messages (title, body, msg_type, target_type, target_merchant_ids, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  findById: db.prepare('SELECT * FROM admin_messages WHERE id = ?'),

  getAll: db.prepare('SELECT * FROM admin_messages ORDER BY created_at DESC LIMIT ?'),

  // Messages visible to a specific merchant (all broadcasts + targeted ones)
  getForMerchant: db.prepare(`
    SELECT m.*,
      CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END as is_read,
      r.read_at
    FROM admin_messages m
    LEFT JOIN admin_message_reads r ON r.message_id = m.id AND r.merchant_id = ?
    WHERE m.target_type = 'all'
      OR (m.target_type = 'selected' AND EXISTS (
        SELECT 1 FROM json_each(m.target_merchant_ids) j WHERE CAST(j.value AS INTEGER) = ?
      ))
    ORDER BY m.created_at DESC
    LIMIT ?
  `),

  // Filter by type for a merchant
  getForMerchantByType: db.prepare(`
    SELECT m.*,
      CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END as is_read,
      r.read_at
    FROM admin_messages m
    LEFT JOIN admin_message_reads r ON r.message_id = m.id AND r.merchant_id = ?
    WHERE (m.target_type = 'all'
      OR (m.target_type = 'selected' AND EXISTS (
        SELECT 1 FROM json_each(m.target_merchant_ids) j WHERE CAST(j.value AS INTEGER) = ?
      )))
      AND m.msg_type = ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `),

  countUnreadForMerchant: db.prepare(`
    SELECT COUNT(*) as count FROM admin_messages m
    WHERE (m.target_type = 'all'
      OR (m.target_type = 'selected' AND EXISTS (
        SELECT 1 FROM json_each(m.target_merchant_ids) j WHERE CAST(j.value AS INTEGER) = ?
      )))
      AND NOT EXISTS (
        SELECT 1 FROM admin_message_reads r
        WHERE r.message_id = m.id AND r.merchant_id = ?
      )
  `),

  markRead: db.prepare('INSERT OR IGNORE INTO admin_message_reads (message_id, merchant_id) VALUES (?, ?)'),

  delete: db.prepare('DELETE FROM admin_messages WHERE id = ?'),
  deleteReads: db.prepare('DELETE FROM admin_message_reads WHERE message_id = ?'),
};


// ─── Merchant Invoices ───────────────────────────────

const invoiceQueries = {
  create: db.prepare(`
    INSERT INTO merchant_invoices (merchant_id, month, label, amount, status, file_data, file_name, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  findById: db.prepare('SELECT * FROM merchant_invoices WHERE id = ?'),
  findByIdAndMerchant: db.prepare('SELECT * FROM merchant_invoices WHERE id = ? AND merchant_id = ?'),

  getByMerchant: db.prepare(`
    SELECT id, merchant_id, month, label, amount, status, file_name, notes, created_at
    FROM merchant_invoices
    WHERE merchant_id = ?
    ORDER BY month DESC
    LIMIT ?
  `),

  getAll: db.prepare(`
    SELECT i.id, i.merchant_id, i.month, i.label, i.amount, i.status, i.file_name, i.notes, i.created_at,
           m.business_name
    FROM merchant_invoices i
    JOIN merchants m ON i.merchant_id = m.id
    ORDER BY i.created_at DESC
    LIMIT ?
  `),

  countByMerchant: db.prepare('SELECT COUNT(*) as count FROM merchant_invoices WHERE merchant_id = ?'),

  updateStatus: db.prepare("UPDATE merchant_invoices SET status = ?, updated_at = datetime('now') WHERE id = ?"),

  delete: db.prepare('DELETE FROM merchant_invoices WHERE id = ?'),
};


module.exports = {
  messageQueries,
  invoiceQueries,
};
