const Database = require('better-sqlite3');
const path = require('path');

// ═══════════════════════════════════════════════════════
// DATABASE INIT
// ═══════════════════════════════════════════════════════

const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/data/fiddo.db'
  : path.join(__dirname, 'fiddo.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ═══════════════════════════════════════════════════════
// DDL — Schema V3.1 (post-review)
// ═══════════════════════════════════════════════════════

function initDatabase() {

  // ───────────────────────────────────────────
  // 1. SUPER ADMINS
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS super_admins (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ───────────────────────────────────────────
  // 2. MERCHANTS
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchants (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      business_name       TEXT NOT NULL,
      address             TEXT NOT NULL,
      vat_number          TEXT UNIQUE NOT NULL,
      email               TEXT NOT NULL,
      phone               TEXT NOT NULL,
      owner_phone         TEXT NOT NULL,

      status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','active','suspended','rejected','cancelled')),
      rejection_reason    TEXT,

      points_per_euro     REAL NOT NULL DEFAULT 1.0,
      points_for_reward   INTEGER NOT NULL DEFAULT 100,
      reward_description  TEXT NOT NULL DEFAULT 'Récompense offerte',

      billing_status      TEXT NOT NULL DEFAULT 'trial'
                          CHECK(billing_status IN ('trial','paid','overdue','cancelled')),

      validated_at        TEXT,
      validated_by        INTEGER REFERENCES super_admins(id),
      suspended_at        TEXT,
      cancelled_at        TEXT,
      cancellation_reason TEXT,

      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ───────────────────────────────────────────
  // 3. STAFF ACCOUNTS
  //    email = globalement unique (un humain = un login)
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_accounts (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_id               INTEGER NOT NULL REFERENCES merchants(id),
      email                     TEXT UNIQUE NOT NULL,
      password                  TEXT NOT NULL,
      display_name              TEXT NOT NULL,
      role                      TEXT NOT NULL CHECK(role IN ('owner','manager','cashier')),
      is_active                 INTEGER NOT NULL DEFAULT 0,

      last_login                TEXT,
      failed_login_count        INTEGER NOT NULL DEFAULT 0,
      locked_until              TEXT,

      password_reset_token      TEXT,
      password_reset_expires_at TEXT,

      created_at                TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ───────────────────────────────────────────
  // 4. END USERS (identité globale)
  //    email/phone   = valeurs brutes (affichage)
  //    email_lower/phone_e164 = normalisées (unicité + recherche)
  //    CHECK : au moins un identifiant, sauf si soft-deleted
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS end_users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,

      email             TEXT,
      phone             TEXT,
      email_lower       TEXT,
      phone_e164        TEXT,

      name              TEXT,

      email_validated   INTEGER NOT NULL DEFAULT 0,
      validation_token  TEXT,

      qr_token          TEXT,

      consent_date      TEXT,
      consent_version   TEXT,
      consent_method    TEXT,

      is_blocked        INTEGER NOT NULL DEFAULT 0,
      deleted_at        TEXT,

      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),

      CHECK (
        (email_lower IS NOT NULL OR phone_e164 IS NOT NULL)
        OR deleted_at IS NOT NULL
      )
    )
  `);

  // ───────────────────────────────────────────
  // 5. END USER ALIASES (identifiants historiques post-fusion)
  //    UNIQUE(alias_type, alias_value) → un alias ne peut pointer que vers un seul end_user
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS end_user_aliases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      end_user_id INTEGER NOT NULL REFERENCES end_users(id),
      alias_type  TEXT NOT NULL CHECK(alias_type IN ('email','phone')),
      alias_value TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ───────────────────────────────────────────
  // 6. MERCHANT CLIENTS (relation merchant ↔ end_user, points isolés)
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant_clients (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_id   INTEGER NOT NULL REFERENCES merchants(id),
      end_user_id   INTEGER NOT NULL REFERENCES end_users(id),

      points_balance INTEGER NOT NULL DEFAULT 0,
      total_spent    REAL NOT NULL DEFAULT 0,
      visit_count    INTEGER NOT NULL DEFAULT 0,

      is_blocked     INTEGER NOT NULL DEFAULT 0,
      notes_private  TEXT,

      first_visit    TEXT NOT NULL DEFAULT (datetime('now')),
      last_visit     TEXT NOT NULL DEFAULT (datetime('now')),
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),

      UNIQUE(merchant_id, end_user_id)
    )
  `);

  // ───────────────────────────────────────────
  // 7. TRANSACTIONS (ledger — source de vérité comptable)
  //    points_delta : signé (+credit, -reward, +/-adjustment, 0 merge-trace)
  //    amount : nullable (merge/adjustment n'ont pas de montant)
  //    idempotency_key : unique par merchant pour éviter les double-crédits
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_id        INTEGER NOT NULL REFERENCES merchants(id),
      merchant_client_id INTEGER NOT NULL REFERENCES merchant_clients(id),
      staff_id           INTEGER REFERENCES staff_accounts(id),

      amount             REAL,
      points_delta       INTEGER NOT NULL,
      transaction_type   TEXT NOT NULL
                         CHECK(transaction_type IN ('credit','reward','merge','adjustment')),
      idempotency_key    TEXT,
      source             TEXT,
      notes              TEXT,

      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ───────────────────────────────────────────
  // 8. AUDIT LOGS (immuable)
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_type  TEXT NOT NULL CHECK(actor_type IN ('super_admin','staff','system')),
      actor_id    INTEGER,
      merchant_id INTEGER,
      action      TEXT NOT NULL,
      target_type TEXT,
      target_id   INTEGER,
      details     TEXT,
      ip_address  TEXT,
      request_id  TEXT,
      user_agent  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ───────────────────────────────────────────
  // 9. END USER MERGES (traçabilité des fusions)
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS end_user_merges (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_user_id  INTEGER NOT NULL,
      target_user_id  INTEGER NOT NULL REFERENCES end_users(id),
      merged_by       INTEGER NOT NULL REFERENCES super_admins(id),
      reason          TEXT,
      details         TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ───────────────────────────────────────────
  // MIGRATIONS (colonnes ajoutées post-V3.1)
  // ───────────────────────────────────────────
  try { db.exec('ALTER TABLE end_users ADD COLUMN pin_hash TEXT'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE merchant_clients ADD COLUMN custom_reward TEXT'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE merchants ADD COLUMN qr_token TEXT'); } catch (e) { /* already exists */ }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_merchants_qr_token ON merchants(qr_token)');
  try { db.exec('ALTER TABLE end_users ADD COLUMN magic_token TEXT'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE end_users ADD COLUMN magic_token_expires TEXT'); } catch (e) { /* already exists */ }

  // Backfill qr_tokens for existing end_users
  const usersWithoutQr = db.prepare('SELECT id FROM end_users WHERE qr_token IS NULL AND deleted_at IS NULL').all();
  if (usersWithoutQr.length > 0) {
    const setQr = db.prepare("UPDATE end_users SET qr_token = ? WHERE id = ?");
    const backfill = db.transaction(() => {
      for (const u of usersWithoutQr) {
        setQr.run(require('crypto').randomBytes(8).toString('base64url'), u.id);
      }
    });
    backfill();
    console.log(`✅ Backfilled qr_token for ${usersWithoutQr.length} existing clients`);
  }

  // ───────────────────────────────────────────
  // 10. MERCHANT PREFERENCES (theme, notifications, backup)
  //     Missing from initial schema — needed by preferences route
  // ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant_preferences (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_id          INTEGER NOT NULL UNIQUE REFERENCES merchants(id),
      theme                TEXT NOT NULL DEFAULT 'teal',
      language             TEXT NOT NULL DEFAULT 'fr',
      timezone             TEXT NOT NULL DEFAULT 'Europe/Brussels',
      reward_message       TEXT NOT NULL DEFAULT 'Félicitations ! Vous avez gagné votre récompense ! 🎁',
      notify_new_client    INTEGER NOT NULL DEFAULT 1,
      notify_reward_ready  INTEGER NOT NULL DEFAULT 1,
      notify_weekly_report INTEGER NOT NULL DEFAULT 0,
      logo_url             TEXT,
      backup_frequency     TEXT NOT NULL DEFAULT 'manual',
      last_backup_at       TEXT,
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── Add credit_methods column if missing (V3.6) ──
  try {
    db.exec(`ALTER TABLE merchant_preferences ADD COLUMN credit_methods TEXT NOT NULL DEFAULT '{"email":true,"phone":true,"qr":true,"scan":true}'`);
  } catch (_) { /* column already exists */ }

  // ───────────────────────────────────────────
  // MIGRATIONS V4 — Mobile App
  // ───────────────────────────────────────────

  // ── Merchants: carte de visite (app mobile) ──
  try { db.exec('ALTER TABLE merchants ADD COLUMN website_url TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE merchants ADD COLUMN description TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE merchants ADD COLUMN opening_hours TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE merchants ADD COLUMN latitude REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE merchants ADD COLUMN longitude REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE merchants ADD COLUMN logo_url TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE merchants ADD COLUMN instagram_url TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE merchants ADD COLUMN facebook_url TEXT'); } catch (_) {}

  // ── End Users: profil enrichi + notif prefs ──
  try { db.exec('ALTER TABLE end_users ADD COLUMN date_of_birth TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE end_users ADD COLUMN profile_completed INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE end_users ADD COLUMN notif_credit INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
  try { db.exec('ALTER TABLE end_users ADD COLUMN notif_reward INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
  try { db.exec('ALTER TABLE end_users ADD COLUMN notif_promo INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
  try { db.exec('ALTER TABLE end_users ADD COLUMN notif_birthday INTEGER NOT NULL DEFAULT 1'); } catch (_) {}

  // ── Push tokens (Expo push notifications) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      end_user_id INTEGER NOT NULL REFERENCES end_users(id),
      token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL CHECK(platform IN ('ios','android')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS ix_push_tokens_user ON push_tokens(end_user_id)');

  // ── Refresh tokens (persistent auth) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      end_user_id INTEGER NOT NULL REFERENCES end_users(id),
      token TEXT NOT NULL UNIQUE,
      device_name TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS ix_refresh_tokens_user ON refresh_tokens(end_user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_refresh_tokens_token ON refresh_tokens(token)');

  console.log('✅ Database V4 (mobile) migrations applied');

  // ───────────────────────────────────────────
  // INDEXES
  // ───────────────────────────────────────────
  db.exec(`
    -- merchants
    CREATE INDEX IF NOT EXISTS ix_merchants_status ON merchants(status);
    CREATE INDEX IF NOT EXISTS ix_merchants_vat    ON merchants(vat_number);

    -- staff_accounts (email already has implicit UNIQUE index)
    CREATE INDEX IF NOT EXISTS ix_staff_merchant ON staff_accounts(merchant_id);

    -- end_users (normalized columns for lookup)
    CREATE UNIQUE INDEX IF NOT EXISTS ux_eu_email_lower ON end_users(email_lower);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_eu_phone_e164  ON end_users(phone_e164);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_eu_qr_token    ON end_users(qr_token);

    -- end_user_aliases (unique alias → one owner only)
    CREATE UNIQUE INDEX IF NOT EXISTS ux_alias_type_value ON end_user_aliases(alias_type, alias_value);
    CREATE INDEX IF NOT EXISTS ix_alias_end_user          ON end_user_aliases(end_user_id);

    -- merchant_clients
    CREATE INDEX IF NOT EXISTS ix_mc_merchant ON merchant_clients(merchant_id);
    CREATE INDEX IF NOT EXISTS ix_mc_enduser  ON merchant_clients(end_user_id);

    -- transactions (idempotency: unique per merchant, only when key is present)
    CREATE UNIQUE INDEX IF NOT EXISTS ux_tx_idempotency
      ON transactions(merchant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_tx_merchant_created ON transactions(merchant_id, created_at);
    CREATE INDEX IF NOT EXISTS ix_tx_mc_created       ON transactions(merchant_client_id, created_at);

    -- audit_logs
    CREATE INDEX IF NOT EXISTS ix_audit_merchant ON audit_logs(merchant_id);
    CREATE INDEX IF NOT EXISTS ix_audit_actor    ON audit_logs(actor_type, actor_id);
    CREATE INDEX IF NOT EXISTS ix_audit_request  ON audit_logs(request_id);
  `);

  console.log('✅ Database V3.4 initialized');
  console.log('✅ Database V4.0 (mobile app) ready');
}

// Init on require
initDatabase();


// ═══════════════════════════════════════════════════════
// PREPARED STATEMENTS
// ═══════════════════════════════════════════════════════

// ─── Super Admins ────────────────────────────────────

const adminQueries = {
  findByEmail: db.prepare('SELECT * FROM super_admins WHERE email = ?'),
  findById:    db.prepare('SELECT * FROM super_admins WHERE id = ?'),
  create:      db.prepare('INSERT INTO super_admins (email, password, name) VALUES (?, ?, ?)'),
  count:       db.prepare('SELECT COUNT(*) as count FROM super_admins'),
};

// ─── Merchants ───────────────────────────────────────

const merchantQueries = {
  create: db.prepare(`
    INSERT INTO merchants (business_name, address, vat_number, email, phone, owner_phone, points_per_euro, points_for_reward, reward_description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  findById:    db.prepare('SELECT * FROM merchants WHERE id = ?'),
  findByVat:   db.prepare('SELECT * FROM merchants WHERE vat_number = ?'),
  getAll:      db.prepare('SELECT * FROM merchants ORDER BY created_at DESC'),
  getByStatus: db.prepare('SELECT * FROM merchants WHERE status = ? ORDER BY created_at DESC'),

  updateStatus: db.prepare(`
    UPDATE merchants SET status = ?, validated_at = datetime('now'), validated_by = ? WHERE id = ?
  `),
  reject: db.prepare(`
    UPDATE merchants
    SET status = 'rejected', rejection_reason = ?, validated_at = datetime('now'), validated_by = ?
    WHERE id = ?
  `),
  suspend: db.prepare(`
    UPDATE merchants SET status = 'suspended', suspended_at = datetime('now') WHERE id = ?
  `),
  reactivate: db.prepare(`
    UPDATE merchants SET status = 'active', suspended_at = NULL WHERE id = ?
  `),
  updateSettings: db.prepare(`
    UPDATE merchants SET points_per_euro = ?, points_for_reward = ?, reward_description = ? WHERE id = ?
  `),
  findByQrToken: db.prepare('SELECT * FROM merchants WHERE qr_token = ?'),
  setQrToken:    db.prepare("UPDATE merchants SET qr_token = ? WHERE id = ?"),
};

// ─── Staff Accounts ──────────────────────────────────

const staffQueries = {
  create: db.prepare(`
    INSERT INTO staff_accounts (merchant_id, email, password, display_name, role, is_active)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  findByEmail:         db.prepare('SELECT * FROM staff_accounts WHERE email = ?'),
  findById:            db.prepare('SELECT * FROM staff_accounts WHERE id = ?'),
  findByIdAndMerchant: db.prepare('SELECT * FROM staff_accounts WHERE id = ? AND merchant_id = ?'),

  getByMerchant: db.prepare(`
    SELECT id, merchant_id, email, display_name, role, is_active, last_login, created_at
    FROM staff_accounts WHERE merchant_id = ? ORDER BY role, created_at
  `),

  updateLastLogin:     db.prepare("UPDATE staff_accounts SET last_login = datetime('now'), failed_login_count = 0 WHERE id = ?"),
  incrementFailedLogin: db.prepare('UPDATE staff_accounts SET failed_login_count = failed_login_count + 1 WHERE id = ?'),
  lockAccount:         db.prepare('UPDATE staff_accounts SET locked_until = ? WHERE id = ?'),
  resetFailedLogins:   db.prepare('UPDATE staff_accounts SET failed_login_count = 0, locked_until = NULL WHERE id = ?'),

  activate:   db.prepare('UPDATE staff_accounts SET is_active = 1 WHERE id = ?'),
  deactivate: db.prepare('UPDATE staff_accounts SET is_active = 0 WHERE id = ?'),
  updateRole: db.prepare('UPDATE staff_accounts SET role = ? WHERE id = ?'),
  updatePassword: db.prepare('UPDATE staff_accounts SET password = ? WHERE id = ?'),
  delete:     db.prepare('DELETE FROM staff_accounts WHERE id = ? AND merchant_id = ?'),

  countActiveOwners:       db.prepare("SELECT COUNT(*) as count FROM staff_accounts WHERE merchant_id = ? AND role = 'owner' AND is_active = 1"),
  deactivateAllByMerchant: db.prepare('UPDATE staff_accounts SET is_active = 0 WHERE merchant_id = ?'),
  activateOwnersByMerchant: db.prepare("UPDATE staff_accounts SET is_active = 1 WHERE merchant_id = ? AND role = 'owner'"),
};

// ─── End Users ───────────────────────────────────────

const endUserQueries = {
  create: db.prepare(`
    INSERT INTO end_users (email, phone, email_lower, phone_e164, name, validation_token)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  findById:         db.prepare('SELECT * FROM end_users WHERE id = ? AND deleted_at IS NULL'),
  findByEmailLower: db.prepare('SELECT * FROM end_users WHERE email_lower = ? AND deleted_at IS NULL'),
  findByPhoneE164:  db.prepare('SELECT * FROM end_users WHERE phone_e164 = ? AND deleted_at IS NULL'),

  validateEmail: db.prepare(`
    UPDATE end_users
    SET email_validated = 1, consent_date = datetime('now'), updated_at = datetime('now')
    WHERE validation_token = ? AND deleted_at IS NULL
  `),

  block:   db.prepare("UPDATE end_users SET is_blocked = 1, updated_at = datetime('now') WHERE id = ?"),
  unblock: db.prepare("UPDATE end_users SET is_blocked = 0, updated_at = datetime('now') WHERE id = ?"),

  softDelete: db.prepare(`
    UPDATE end_users
    SET deleted_at = datetime('now'),
        email = NULL, phone = NULL, email_lower = NULL, phone_e164 = NULL,
        name = NULL, qr_token = NULL, pin_hash = NULL, updated_at = datetime('now')
    WHERE id = ?
  `),

  getAll: db.prepare('SELECT * FROM end_users WHERE deleted_at IS NULL ORDER BY created_at DESC'),

  search: db.prepare(`
    SELECT * FROM end_users
    WHERE deleted_at IS NULL
      AND (email_lower LIKE ? OR phone_e164 LIKE ? OR name LIKE ?)
    ORDER BY created_at DESC
  `),

  updateIdentifiers: db.prepare(`
    UPDATE end_users
    SET email = ?, phone = ?, email_lower = ?, phone_e164 = ?,
        email_validated = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `),

  setPin: db.prepare("UPDATE end_users SET pin_hash = ?, updated_at = datetime('now') WHERE id = ?"),
  findByQrToken: db.prepare('SELECT * FROM end_users WHERE qr_token = ? AND deleted_at IS NULL'),
  setQrToken: db.prepare("UPDATE end_users SET qr_token = ?, updated_at = datetime('now') WHERE id = ?"),
  setMagicToken: db.prepare("UPDATE end_users SET magic_token = ?, magic_token_expires = ?, updated_at = datetime('now') WHERE id = ?"),
  findByMagicToken: db.prepare('SELECT * FROM end_users WHERE magic_token = ? AND deleted_at IS NULL'),
  clearMagicToken: db.prepare("UPDATE end_users SET magic_token = NULL, magic_token_expires = NULL, updated_at = datetime('now') WHERE id = ?"),

  // V4 — Mobile app profile
  updateProfile: db.prepare(`
    UPDATE end_users
    SET name = ?, phone = ?, phone_e164 = ?, date_of_birth = ?, profile_completed = 1, updated_at = datetime('now')
    WHERE id = ?
  `),
  updateNotifPrefs: db.prepare(`
    UPDATE end_users
    SET notif_credit = ?, notif_reward = ?, notif_promo = ?, notif_birthday = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
};

// ─── End User Aliases ────────────────────────────────

const aliasQueries = {
  create:           db.prepare('INSERT OR IGNORE INTO end_user_aliases (end_user_id, alias_type, alias_value) VALUES (?, ?, ?)'),
  findByValue:      db.prepare('SELECT * FROM end_user_aliases WHERE alias_value = ?'),
  findByTypeAndValue: db.prepare('SELECT * FROM end_user_aliases WHERE alias_type = ? AND alias_value = ?'),
  getByUser:        db.prepare('SELECT * FROM end_user_aliases WHERE end_user_id = ?'),
  deleteByUser:     db.prepare('DELETE FROM end_user_aliases WHERE end_user_id = ?'),
};

// ─── Merchant Clients ────────────────────────────────

const merchantClientQueries = {
  create: db.prepare('INSERT INTO merchant_clients (merchant_id, end_user_id) VALUES (?, ?)'),

  findById:           db.prepare('SELECT * FROM merchant_clients WHERE id = ?'),
  findByIdAndMerchant: db.prepare('SELECT * FROM merchant_clients WHERE id = ? AND merchant_id = ?'),
  find:               db.prepare('SELECT * FROM merchant_clients WHERE merchant_id = ? AND end_user_id = ?'),

  getByMerchant: db.prepare(`
    SELECT mc.*, eu.email, eu.phone, eu.name, eu.email_validated, eu.is_blocked as eu_blocked
    FROM merchant_clients mc
    JOIN end_users eu ON mc.end_user_id = eu.id
    WHERE mc.merchant_id = ? AND eu.deleted_at IS NULL
    ORDER BY mc.last_visit DESC
  `),

  searchByMerchant: db.prepare(`
    SELECT mc.*, eu.email, eu.phone, eu.name, eu.email_validated, eu.is_blocked as eu_blocked
    FROM merchant_clients mc
    JOIN end_users eu ON mc.end_user_id = eu.id
    WHERE mc.merchant_id = ? AND eu.deleted_at IS NULL
      AND (eu.email_lower LIKE ? OR eu.phone_e164 LIKE ? OR eu.name LIKE ?)
    ORDER BY mc.last_visit DESC
  `),

  lookupByMerchant: db.prepare(`
    SELECT mc.id, mc.points_balance, mc.visit_count, mc.is_blocked,
           eu.name, eu.email, eu.phone
    FROM merchant_clients mc
    JOIN end_users eu ON mc.end_user_id = eu.id
    WHERE mc.merchant_id = ? AND mc.end_user_id = ? AND eu.deleted_at IS NULL
  `),

  updateAfterCredit: db.prepare(`
    UPDATE merchant_clients
    SET points_balance = points_balance + ?,
        total_spent = total_spent + ?,
        visit_count = visit_count + 1,
        last_visit = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `),

  setPoints: db.prepare("UPDATE merchant_clients SET points_balance = ?, updated_at = datetime('now') WHERE id = ?"),
  block:     db.prepare("UPDATE merchant_clients SET is_blocked = 1, updated_at = datetime('now') WHERE id = ?"),
  unblock:   db.prepare("UPDATE merchant_clients SET is_blocked = 0, updated_at = datetime('now') WHERE id = ?"),

  setCustomReward: db.prepare("UPDATE merchant_clients SET custom_reward = ?, updated_at = datetime('now') WHERE id = ?"),

  mergeStats: db.prepare(`
    UPDATE merchant_clients
    SET points_balance = points_balance + ?,
        total_spent = total_spent + ?,
        visit_count = visit_count + ?,
        first_visit = MIN(first_visit, ?),
        last_visit = MAX(last_visit, ?),
        updated_at = datetime('now')
    WHERE id = ?
  `),

  delete:        db.prepare('DELETE FROM merchant_clients WHERE id = ?'),
  updateEndUser: db.prepare("UPDATE merchant_clients SET end_user_id = ?, updated_at = datetime('now') WHERE id = ?"),
};

// ─── Transactions (ledger) ───────────────────────────

const transactionQueries = {
  create: db.prepare(`
    INSERT INTO transactions
      (merchant_id, merchant_client_id, staff_id, amount, points_delta, transaction_type, idempotency_key, source, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  findByIdempotencyKey: db.prepare(
    'SELECT * FROM transactions WHERE merchant_id = ? AND idempotency_key = ?'
  ),

  getByMerchantClient: db.prepare(`
    SELECT t.*, sa.display_name as staff_name
    FROM transactions t
    LEFT JOIN staff_accounts sa ON t.staff_id = sa.id
    WHERE t.merchant_client_id = ?
    ORDER BY t.created_at DESC
  `),

  getByMerchant: db.prepare(`
    SELECT t.*, eu.email, eu.phone, eu.name as client_name, sa.display_name as staff_name
    FROM transactions t
    JOIN merchant_clients mc ON t.merchant_client_id = mc.id
    JOIN end_users eu ON mc.end_user_id = eu.id
    LEFT JOIN staff_accounts sa ON t.staff_id = sa.id
    WHERE t.merchant_id = ?
    ORDER BY t.created_at DESC
    LIMIT ?
  `),

  sumPointsByMerchantClient: db.prepare(
    'SELECT COALESCE(SUM(points_delta), 0) as total FROM transactions WHERE merchant_client_id = ?'
  ),

  reassignClient: db.prepare(
    'UPDATE transactions SET merchant_client_id = ? WHERE merchant_client_id = ?'
  ),
};

// ─── Audit Logs ──────────────────────────────────────

const auditQueries = {
  create: db.prepare(`
    INSERT INTO audit_logs
      (actor_type, actor_id, merchant_id, action, target_type, target_id, details, ip_address, request_id, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getByMerchant: db.prepare('SELECT * FROM audit_logs WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?'),
  getAll:        db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?'),
};

// ─── End User Merges ─────────────────────────────────

const mergeQueries = {
  create: db.prepare(
    'INSERT INTO end_user_merges (source_user_id, target_user_id, merged_by, reason, details) VALUES (?, ?, ?, ?, ?)'
  ),
  getAll: db.prepare('SELECT * FROM end_user_merges ORDER BY created_at DESC'),
};


// ─── Push Tokens ─────────────────────────────────────

const pushTokenQueries = {
  upsert: db.prepare(`
    INSERT INTO push_tokens (end_user_id, token, platform)
    VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET end_user_id = excluded.end_user_id, platform = excluded.platform, updated_at = datetime('now')
  `),
  deleteByToken: db.prepare('DELETE FROM push_tokens WHERE token = ?'),
  deleteByUser: db.prepare('DELETE FROM push_tokens WHERE end_user_id = ?'),
  getByUser: db.prepare('SELECT * FROM push_tokens WHERE end_user_id = ?'),
  getByUsers: (userIds) => {
    if (!userIds.length) return [];
    const placeholders = userIds.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM push_tokens WHERE end_user_id IN (${placeholders})`).all(...userIds);
  },
};

// ─── Refresh Tokens ──────────────────────────────────

const refreshTokenQueries = {
  create: db.prepare(`
    INSERT INTO refresh_tokens (end_user_id, token, device_name, expires_at)
    VALUES (?, ?, ?, ?)
  `),
  findByToken: db.prepare('SELECT * FROM refresh_tokens WHERE token = ?'),
  updateLastUsed: db.prepare("UPDATE refresh_tokens SET last_used_at = datetime('now') WHERE id = ?"),
  delete: db.prepare('DELETE FROM refresh_tokens WHERE id = ?'),
  deleteByToken: db.prepare('DELETE FROM refresh_tokens WHERE token = ?'),
  deleteByUser: db.prepare('DELETE FROM refresh_tokens WHERE end_user_id = ?'),
  deleteExpired: db.prepare("DELETE FROM refresh_tokens WHERE expires_at < datetime('now')"),
  getByUser: db.prepare('SELECT id, device_name, created_at, last_used_at FROM refresh_tokens WHERE end_user_id = ? ORDER BY last_used_at DESC'),
};


// ═══════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════

module.exports = {
  db,
  initDatabase,
  adminQueries,
  merchantQueries,
  staffQueries,
  endUserQueries,
  aliasQueries,
  merchantClientQueries,
  transactionQueries,
  auditQueries,
  mergeQueries,
  pushTokenQueries,
  refreshTokenQueries,
};
