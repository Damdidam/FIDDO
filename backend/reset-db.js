#!/usr/bin/env node

/**
 * FIDDO — Reset Database
 * Vide toutes les tables sans toucher au schéma.
 * Usage: node reset-db.js [--yes]
 */

require('dotenv').config();
const { db } = require('./database');

const force = process.argv.includes('--yes');

if (!force) {
  console.log('⚠️  Ceci va SUPPRIMER toutes les données de la base !');
  console.log('   Relance avec --yes pour confirmer :');
  console.log('   node reset-db.js --yes');
  process.exit(0);
}

const tables = [
  'audit_logs',
  'end_user_merges',
  'transactions',
  'merchant_clients',
  'end_user_aliases',
  'end_users',
  'staff_accounts',
  'merchants',
  'super_admins',
];

db.pragma('foreign_keys = OFF');

const wipe = db.transaction(() => {
  for (const t of tables) {
    db.prepare(`DELETE FROM ${t}`).run();
    console.log(`  🗑️  ${t} vidée`);
  }
});

wipe();

db.pragma('foreign_keys = ON');

console.log('\n✅ Base de données vidée. Le schéma est intact.');
console.log('   Redémarre le serveur et crée un nouveau super admin via /admin.');
