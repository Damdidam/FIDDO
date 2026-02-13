#!/usr/bin/env node
/**
 * FIDDO — One-shot cleanup: remove orphaned aliases
 * 
 * Orphaned aliases = aliases pointing to soft-deleted end_users,
 * or aliases that redirect to the wrong user.
 * 
 * Run once after deploying the alias security fix.
 * Safe to run multiple times (idempotent).
 * 
 * Usage: node scripts/cleanup-orphan-aliases.js
 */

require('dotenv').config();
const { db, aliasQueries } = require('../database');
const { initDatabase } = require('../database');

initDatabase();

console.log('🔍 Scanning for orphaned aliases...\n');

// 1. Aliases pointing to soft-deleted users
const orphanedDeleted = db.prepare(`
  SELECT a.*, eu.deleted_at
  FROM end_user_aliases a
  LEFT JOIN end_users eu ON eu.id = a.end_user_id
  WHERE eu.deleted_at IS NOT NULL OR eu.id IS NULL
`).all();

console.log(`Found ${orphanedDeleted.length} alias(es) pointing to deleted/missing users`);
orphanedDeleted.forEach(a => {
  console.log(`  - [${a.alias_type}] ${a.alias_value} → user #${a.end_user_id} (deleted)`);
});

// 2. Aliases that conflict with existing active end_users
// (alias redirects to user B, but the value still exists as a primary identifier on another active user A)
const conflicting = db.prepare(`
  SELECT a.*, 
    a.end_user_id AS alias_target,
    eu_direct.id AS direct_user_id,
    eu_direct.email_lower, eu_direct.phone_e164
  FROM end_user_aliases a
  LEFT JOIN end_users eu_direct ON (
    (a.alias_type = 'email' AND eu_direct.email_lower = a.alias_value AND eu_direct.deleted_at IS NULL)
    OR (a.alias_type = 'phone' AND eu_direct.phone_e164 = a.alias_value AND eu_direct.deleted_at IS NULL)
  )
  WHERE eu_direct.id IS NOT NULL AND eu_direct.id != a.end_user_id
`).all();

console.log(`Found ${conflicting.length} conflicting alias(es) (value exists on active user)`);
conflicting.forEach(a => {
  console.log(`  - [${a.alias_type}] ${a.alias_value} → alias says user #${a.alias_target}, but active user #${a.direct_user_id} has this identifier`);
});

// Summary
const total = orphanedDeleted.length + conflicting.length;
if (total === 0) {
  console.log('\n✅ No orphaned or conflicting aliases found. Database is clean.');
  process.exit(0);
}

console.log(`\n⚠️  Total: ${total} problematic alias(es)`);

// Confirm deletion
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('\nDelete these aliases? (yes/no): ', (answer) => {
  if (answer.toLowerCase() !== 'yes') {
    console.log('Aborted.');
    rl.close();
    process.exit(0);
  }

  const deleteStmt = db.prepare('DELETE FROM end_user_aliases WHERE id = ?');
  const run = db.transaction(() => {
    let deleted = 0;
    for (const a of [...orphanedDeleted, ...conflicting]) {
      deleteStmt.run(a.id);
      deleted++;
    }
    return deleted;
  });

  const deleted = run();
  console.log(`\n✅ Deleted ${deleted} orphaned/conflicting alias(es).`);
  rl.close();
});
