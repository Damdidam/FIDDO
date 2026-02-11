const fs = require('fs');
const path = require('path');
const { db } = require('../database');

// ═══════════════════════════════════════════════════════
// BACKUP CONFIG
// ═══════════════════════════════════════════════════════

const BACKUP_DIR = process.env.NODE_ENV === 'production'
  ? '/data/backups'
  : path.join(__dirname, '../backups');

const MAX_BACKUPS = parseInt(process.env.BACKUP_MAX_KEEP) || 5;
const INTERVAL_HOURS = parseInt(process.env.BACKUP_INTERVAL_HOURS) || 6;
const INTERVAL_MS = INTERVAL_HOURS * 60 * 60 * 1000;

let backupTimer = null;


// ═══════════════════════════════════════════════════════
// ENSURE BACKUP DIR
// ═══════════════════════════════════════════════════════

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`📁 Backup directory created: ${BACKUP_DIR}`);
  }
}


// ═══════════════════════════════════════════════════════
// CREATE BACKUP
// Uses better-sqlite3 .backup() for WAL-safe hot backup
// ═══════════════════════════════════════════════════════

/**
 * Create a timestamped backup of the database.
 * @param {string} trigger - 'scheduled' | 'manual' | 'startup'
 * @returns {{ filename: string, filepath: string, size: number, timestamp: string }}
 */
async function createBackup(trigger = 'manual') {
  ensureBackupDir();

  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[T]/g, '_')
    .replace(/[:.]/g, '-')
    .substring(0, 19);

  const filename = `fiddo_${timestamp}_${trigger}.db`;
  const filepath = path.join(BACKUP_DIR, filename);

  try {
    // better-sqlite3 .backup() is safe with WAL mode
    await db.backup(filepath);

    const stats = fs.statSync(filepath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    console.log(`✅ Backup [${trigger}]: ${filename} (${sizeMB} MB)`);

    // Rotate old backups
    rotateBackups();

    return {
      filename,
      filepath,
      size: stats.size,
      sizeMB: parseFloat(sizeMB),
      timestamp: now.toISOString(),
      trigger,
    };
  } catch (error) {
    console.error(`❌ Backup failed [${trigger}]:`, error.message);
    throw error;
  }
}


// ═══════════════════════════════════════════════════════
// ROTATE — keep only last N backups
// ═══════════════════════════════════════════════════════

function rotateBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('fiddo_') && f.endsWith('.db'))
      .map(f => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime,
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(MAX_BACKUPS);
      toDelete.forEach(f => {
        fs.unlinkSync(f.path);
        console.log(`🗑️  Rotated old backup: ${f.name}`);
      });
    }
  } catch (error) {
    console.error('⚠️ Backup rotation error:', error.message);
  }
}


// ═══════════════════════════════════════════════════════
// LIST BACKUPS
// ═══════════════════════════════════════════════════════

/**
 * List all available backups, newest first.
 * @returns {Array<{ filename, size, sizeMB, created }>}
 */
function listBackups() {
  ensureBackupDir();

  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('fiddo_') && f.endsWith('.db'))
      .map(f => {
        const stats = fs.statSync(path.join(BACKUP_DIR, f));
        return {
          filename: f,
          size: stats.size,
          sizeMB: parseFloat((stats.size / (1024 * 1024)).toFixed(2)),
          created: stats.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
  } catch (error) {
    console.error('⚠️ List backups error:', error.message);
    return [];
  }
}


// ═══════════════════════════════════════════════════════
// GET BACKUP FILE PATH (for download)
// ═══════════════════════════════════════════════════════

/**
 * Get the full path of a backup file (validates it exists).
 * @param {string} filename
 * @returns {string|null} filepath or null
 */
function getBackupPath(filename) {
  // Security: prevent path traversal
  const sanitized = path.basename(filename);
  if (!sanitized.startsWith('fiddo_') || !sanitized.endsWith('.db')) {
    return null;
  }

  const filepath = path.join(BACKUP_DIR, sanitized);
  if (!fs.existsSync(filepath)) return null;

  return filepath;
}


// ═══════════════════════════════════════════════════════
// SCHEDULER
// ═══════════════════════════════════════════════════════

/**
 * Start the automatic backup scheduler.
 * Creates an immediate backup on startup, then every INTERVAL_HOURS.
 */
function startScheduler() {
  console.log(`⏰ Backup scheduler: every ${INTERVAL_HOURS}h, keeping last ${MAX_BACKUPS}`);

  // Startup backup (delayed 10s to let the app fully init)
  setTimeout(() => {
    createBackup('startup').catch(() => {});
  }, 10_000);

  // Recurring backups
  backupTimer = setInterval(() => {
    createBackup('scheduled').catch(() => {});
  }, INTERVAL_MS);
}


/**
 * Stop the backup scheduler (for graceful shutdown).
 */
function stopScheduler() {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
    console.log('⏹️  Backup scheduler stopped');
  }
}


module.exports = {
  createBackup,
  listBackups,
  getBackupPath,
  rotateBackups,
  startScheduler,
  stopScheduler,
  BACKUP_DIR,
  MAX_BACKUPS,
  INTERVAL_HOURS,
};
