#!/usr/bin/env node

// ═══════════════════════════════════════════════════════
// FIDDO V3.5 — Sanity Test Suite
// ═══════════════════════════════════════════════════════
//
// Usage:
//   node sanity-test.js
//   node sanity-test.js --base=http://localhost:3000
//   node sanity-test.js --skip-cleanup
//   node sanity-test.js --verbose
//
// Requires: Node 18+ (native fetch)
// ═══════════════════════════════════════════════════════

const BASE = process.argv.find(a => a.startsWith('--base='))?.split('=')[1] || 'https://www.fiddo.be';
const VERBOSE = process.argv.includes('--verbose');
const SKIP_CLEANUP = process.argv.includes('--skip-cleanup');

// ─── Config ──────────────────────────────────────────
// ⚠️  Fill in your admin credentials before running
const ADMIN_EMAIL    = process.env.FIDDO_ADMIN_EMAIL    || 'CHANGE_ME';
const ADMIN_PASSWORD = process.env.FIDDO_ADMIN_PASSWORD || 'CHANGE_ME';

// Test data identifiers (unique to avoid collisions)
const TEST_PREFIX = `_sanity_${Date.now()}`;
const TEST_MERCHANT = {
  businessName:     `Test Sanity ${TEST_PREFIX}`,
  email:            `sanity${TEST_PREFIX}@test-fiddo.be`,
  vatNumber:        `BE0${String(Date.now()).slice(-9)}`,
  address:          '1 Rue du Test, 1000 Bruxelles',
  phone:            '+32400000000',
  ownerPhone:       '+32400000099',
  ownerEmail:       `owner${TEST_PREFIX}@test-fiddo.be`,
  ownerPassword:    'TestPass123!',
  ownerName:        'Sanity Tester',
  pointsPerEuro:    1,
  pointsForReward:  100,
  rewardDescription:'Récompense test',
};
const TEST_SUFFIX = String(Date.now()).slice(-6);
const TEST_CLIENT_1 = {
  email: `client1${TEST_PREFIX}@test-fiddo.be`,
  phone: `+324900${TEST_SUFFIX}`,
  name:  'Client Test Un',
};
const TEST_CLIENT_2 = {
  email: `client2${TEST_PREFIX}@test-fiddo.be`,
  phone: `+324901${TEST_SUFFIX}`,
  name:  'Client Test Deux',
};

// ─── State ───────────────────────────────────────────
let adminCookies = '';
let staffCookies = '';
let createdMerchantId = null;
let createdAnnouncementId = null;
let testEndUserId1 = null;
let testEndUserId2 = null;

// ─── Results ─────────────────────────────────────────
const results = { passed: 0, failed: 0, skipped: 0, errors: [] };
const startTime = Date.now();

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function extractCookies(resp) {
  const raw = resp.headers.getSetCookie?.() || [];
  return raw.map(c => c.split(';')[0]).join('; ');
}

function mergeCookies(existing, resp) {
  const newCookies = extractCookies(resp);
  if (!newCookies) return existing;
  const map = {};
  [existing, newCookies].forEach(str => {
    str.split('; ').filter(Boolean).forEach(c => {
      const [k] = c.split('=');
      map[k] = c;
    });
  });
  return Object.values(map).join('; ');
}

async function api(method, path, { body, cookies, expectStatus, raw } = {}) {
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (cookies) headers['Cookie'] = cookies;

  const opts = { method, headers, redirect: 'manual' };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  if (raw) return resp;

  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }

  if (VERBOSE) {
    console.log(`    ${method} ${path} → ${resp.status}`, typeof data === 'object' ? JSON.stringify(data).slice(0, 120) : '');
  }

  return { status: resp.status, data, resp };
}

async function test(name, fn) {
  try {
    await fn();
    results.passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    results.failed++;
    results.errors.push({ name, error: e.message });
    console.log(`  ❌ ${name} — ${e.message}`);
  }
}

function skip(name, reason) {
  results.skipped++;
  console.log(`  ⏭️  ${name} — ${reason}`);
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertStatus(result, expected, label) {
  assert(
    result.status === expected,
    `${label || 'Request'}: expected ${expected}, got ${result.status} — ${typeof result.data === 'object' ? JSON.stringify(result.data).slice(0, 100) : result.data}`
  );
}

// ═══════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════

async function suiteHealth() {
  console.log('\n🏥 HEALTH & INFRA');

  await test('API /health returns 200', async () => {
    const r = await api('GET', '/api/health');
    assertStatus(r, 200, '/health');
    assert(r.data.status === 'ok', `status should be "ok", got "${r.data.status}"`);
    assert(r.data.version, 'version missing');
  });
}

async function suiteFrontendPages() {
  console.log('\n🌐 FRONTEND PAGES');

  const pages = [
    ['Landing',        '/'],
    ['Login',          '/login'],
    ['Dashboard',      '/dashboard'],
    ['Credit',         '/credit'],
    ['Clients',        '/clients'],
    ['Staff',          '/staff'],
    ['Preferences',    '/preferences'],
    ['Messages',       '/messages'],
    ['Client Form',    '/client-form'],
    ['Client Portal',  '/me'],
    ['Admin Login',    '/admin'],
    ['Admin Dashboard','/admin/dashboard'],
  ];

  for (const [name, path] of pages) {
    await test(`${name} (${path}) loads`, async () => {
      const resp = await fetch(`${BASE}${path}`, { redirect: 'follow' });
      assert(resp.ok, `HTTP ${resp.status}`);
      const html = await resp.text();
      assert(html.includes('<!DOCTYPE html>') || html.includes('<html'), 'Not an HTML page');
    });
  }
}

async function suiteAdminAuth() {
  console.log('\n🔐 ADMIN AUTH');

  if (ADMIN_EMAIL === 'CHANGE_ME') {
    skip('Admin login', 'Set FIDDO_ADMIN_EMAIL and FIDDO_ADMIN_PASSWORD env vars');
    return false;
  }

  await test('Admin login', async () => {
    const r = await api('POST', '/api/admin/auth/login', {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      raw: true,
    });
    assert(r.ok, `Login failed: ${r.status}`);
    adminCookies = extractCookies(r);
    assert(adminCookies.includes('admin_token'), 'No admin_token cookie');
  });

  await test('Admin verify', async () => {
    const r = await api('GET', '/api/admin/auth/verify', { cookies: adminCookies });
    assertStatus(r, 200, 'verify');
    assert(r.data.admin, 'No admin object');
  });

  return true;
}

async function suiteAdminStats() {
  console.log('\n📊 ADMIN STATS');

  await test('Global stats', async () => {
    const r = await api('GET', '/api/admin/merchants/stats/global', { cookies: adminCookies });
    assertStatus(r, 200, 'stats');
    assert(typeof r.data.merchants === 'object', 'merchants missing');
    assert(typeof r.data.endUsers === 'number', 'endUsers missing');
  });
}

async function suiteAdminMerchants() {
  console.log('\n🏪 ADMIN MERCHANTS');

  await test('List merchants', async () => {
    const r = await api('GET', '/api/admin/merchants', { cookies: adminCookies });
    assertStatus(r, 200, 'list');
    assert(Array.isArray(r.data.merchants), 'merchants not array');
  });

  await test('List pending', async () => {
    const r = await api('GET', '/api/admin/merchants?status=pending', { cookies: adminCookies });
    assertStatus(r, 200, 'pending');
  });

  await test('List active', async () => {
    const r = await api('GET', '/api/admin/merchants?status=active', { cookies: adminCookies });
    assertStatus(r, 200, 'active');
  });
}

async function suiteMerchantRegistration() {
  console.log('\n📝 MERCHANT REGISTRATION');

  await test('Register test merchant', async () => {
    const r = await api('POST', '/api/auth/register', {
      body: TEST_MERCHANT,
    });
    assertStatus(r, 201, 'register');
    assert(r.data.merchantId, 'No merchantId returned');
    createdMerchantId = r.data.merchantId;
  });

  if (!createdMerchantId) return;

  await test('Admin validates merchant', async () => {
    const r = await api('POST', `/api/admin/merchants/${createdMerchantId}/validate`, {
      cookies: adminCookies,
    });
    assertStatus(r, 200, 'validate');
  });

  await test('Staff login to test merchant', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword },
      raw: true,
    });
    assert(r.ok, `Staff login failed: ${r.status}`);
    staffCookies = extractCookies(r);
    assert(staffCookies.includes('staff_token'), 'No staff token cookie');
  });

  await test('Staff verify', async () => {
    const r = await api('GET', '/api/auth/verify', { cookies: staffCookies });
    assertStatus(r, 200, 'verify');
    assert(r.data.staff, 'No staff object');
    assert(r.data.merchant, 'No merchant object');
  });
}

async function suiteClientFlow() {
  console.log('\n💳 CLIENT CREDIT/REWARD FLOW');

  if (!staffCookies) {
    skip('Client flow', 'No staff session');
    return;
  }

  // Credit client 1
  await test('Credit client 1 (new)', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: staffCookies,
      body: { email: TEST_CLIENT_1.email, phone: TEST_CLIENT_1.phone, name: TEST_CLIENT_1.name, amount: 25 },
    });
    assertStatus(r, 200, 'credit');
    assert(r.data.client, 'No client in response');
    assert(r.data.transaction && r.data.transaction.points_delta > 0, 'No points earned');
  });

  // Credit client 2
  await test('Credit client 2 (new)', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: staffCookies,
      body: { email: TEST_CLIENT_2.email, phone: TEST_CLIENT_2.phone, name: TEST_CLIENT_2.name, amount: 50 },
    });
    assertStatus(r, 200, 'credit');
  });

  // Lookup client 1
  await test('Lookup client 1 by email', async () => {
    const r = await api('GET', `/api/clients/lookup?email=${encodeURIComponent(TEST_CLIENT_1.email)}`, {
      cookies: staffCookies,
    });
    assertStatus(r, 200, 'lookup');
    assert(r.data.found === true, 'Client not found');
    assert(r.data.client.points_balance > 0, 'No points');
  });

  // List clients
  await test('List all clients', async () => {
    const r = await api('GET', '/api/clients', { cookies: staffCookies });
    assertStatus(r, 200, 'list');
    assert(r.data.clients.length >= 2, `Expected ≥2 clients, got ${r.data.clients.length}`);
  });

  // Search
  await test('Search clients', async () => {
    const r = await api('GET', `/api/clients/search?q=${encodeURIComponent('Client Test')}`, {
      cookies: staffCookies,
    });
    assertStatus(r, 200, 'search');
    assert(r.data.clients.length >= 1, 'Search returned nothing');
  });
}

async function suiteAdminUsers() {
  console.log('\n👤 ADMIN USERS');

  await test('List users', async () => {
    const r = await api('GET', '/api/admin/users', { cookies: adminCookies });
    assertStatus(r, 200, 'list');
    assert(Array.isArray(r.data.users), 'users not array');
  });

  // Find our test users
  await test('Search test user 1', async () => {
    const r = await api('GET', `/api/admin/users?q=${encodeURIComponent(TEST_CLIENT_1.email)}`, {
      cookies: adminCookies,
    });
    assertStatus(r, 200, 'search');
    assert(r.data.users.length >= 1, 'Test user 1 not found');
    testEndUserId1 = r.data.users[0].id;
  });

  await test('Search test user 2', async () => {
    const r = await api('GET', `/api/admin/users?q=${encodeURIComponent(TEST_CLIENT_2.email)}`, {
      cookies: adminCookies,
    });
    assertStatus(r, 200, 'search');
    assert(r.data.users.length >= 1, 'Test user 2 not found');
    testEndUserId2 = r.data.users[0].id;
  });

  if (!testEndUserId1) return;

  await test('User detail', async () => {
    const r = await api('GET', `/api/admin/users/${testEndUserId1}`, { cookies: adminCookies });
    assertStatus(r, 200, 'detail');
    assert(r.data.user, 'No user object');
    assert(Array.isArray(r.data.cards), 'No cards array');
  });

  // Block / Unblock
  await test('Block user', async () => {
    const r = await api('POST', `/api/admin/users/${testEndUserId1}/block`, { cookies: adminCookies });
    assertStatus(r, 200, 'block');
  });

  await test('Verify user is blocked', async () => {
    const r = await api('GET', `/api/admin/users/${testEndUserId1}`, { cookies: adminCookies });
    assertStatus(r, 200, 'detail');
    assert(r.data.user.is_blocked === 1 || r.data.user.is_blocked === true, 'User not blocked');
  });

  await test('Unblock user', async () => {
    const r = await api('POST', `/api/admin/users/${testEndUserId1}/unblock`, { cookies: adminCookies });
    assertStatus(r, 200, 'unblock');
  });

  // Merge preview
  if (testEndUserId1 && testEndUserId2) {
    await test('Merge preview', async () => {
      const r = await api('GET', `/api/admin/users/${testEndUserId1}/merge-preview?sourceId=${testEndUserId2}`, {
        cookies: adminCookies,
      });
      assertStatus(r, 200, 'merge-preview');
      assert(r.data.source, 'No source');
      assert(r.data.target, 'No target');
      assert(Array.isArray(r.data.actions), 'No actions');
    });

    await test('Execute merge', async () => {
      const r = await api('POST', `/api/admin/users/${testEndUserId1}/merge`, {
        cookies: adminCookies,
        body: { sourceId: testEndUserId2, reason: 'Sanity test merge' },
      });
      assertStatus(r, 200, 'merge');
      assert(typeof r.data.merged === 'number', 'No merged count');
      testEndUserId2 = null; // source deleted
    });
  }
}

async function suiteAnnouncements() {
  console.log('\n📢 ANNOUNCEMENTS');

  await test('Create announcement', async () => {
    const r = await api('POST', '/api/admin/announcements', {
      cookies: adminCookies,
      body: {
        title: `Sanity Test ${TEST_PREFIX}`,
        content: 'Ceci est un test automatisé.',
        priority: 'info',
        targetType: 'all',
        merchantIds: [],
        expiresAt: null,
      },
    });
    assertStatus(r, 201, 'create');
    assert(r.data.id, 'No announcement id');
    createdAnnouncementId = r.data.id;
  });

  await test('List announcements', async () => {
    const r = await api('GET', '/api/admin/announcements', { cookies: adminCookies });
    assertStatus(r, 200, 'list');
    assert(Array.isArray(r.data.announcements), 'announcements not array');
  });

  if (createdAnnouncementId) {
    await test('Update announcement', async () => {
      const r = await api('PUT', `/api/admin/announcements/${createdAnnouncementId}`, {
        cookies: adminCookies,
        body: {
          title: `Sanity Test Updated ${TEST_PREFIX}`,
          content: 'Contenu mis à jour.',
          priority: 'warning',
          targetType: 'all',
          merchantIds: [],
          expiresAt: null,
        },
      });
      assertStatus(r, 200, 'update');
    });

    await test('Delete announcement', async () => {
      const r = await api('DELETE', `/api/admin/announcements/${createdAnnouncementId}`, {
        cookies: adminCookies,
      });
      assertStatus(r, 200, 'delete');
      createdAnnouncementId = null;
    });
  }
}

async function suiteMerchantSide() {
  console.log('\n🏪 MERCHANT-SIDE FEATURES');

  if (!staffCookies) {
    skip('Merchant-side', 'No staff session');
    return;
  }

  await test('Dashboard stats', async () => {
    const r = await api('GET', '/api/dashboard/stats', { cookies: staffCookies });
    assertStatus(r, 200, 'stats');
  });

  await test('Dashboard activity', async () => {
    const r = await api('GET', '/api/dashboard/activity', { cookies: staffCookies });
    assertStatus(r, 200, 'activity');
  });

  await test('Get preferences', async () => {
    const r = await api('GET', '/api/preferences', { cookies: staffCookies });
    assertStatus(r, 200, 'preferences');
  });

  await test('Merchant announcements', async () => {
    const r = await api('GET', '/api/announcements', { cookies: staffCookies });
    assertStatus(r, 200, 'announcements');
  });

  await test('Merchant messages', async () => {
    const r = await api('GET', '/api/messages', { cookies: staffCookies });
    assertStatus(r, 200, 'messages');
  });

  await test('Export CSV (email)', async () => {
    const r = await api('POST', '/api/clients/export/csv', { cookies: staffCookies });
    assertStatus(r, 200, 'csv');
    assert(r.data.success === true, 'Export not successful');
  });
}

async function suiteStaffManagement() {
  console.log('\n👥 STAFF MANAGEMENT');

  if (!staffCookies) {
    skip('Staff management', 'No staff session');
    return;
  }

  await test('List staff', async () => {
    const r = await api('GET', '/api/staff', { cookies: staffCookies });
    assertStatus(r, 200, 'list');
    assert(Array.isArray(r.data.staff), 'staff not array');
  });
}

async function suiteSuspendReactivate() {
  console.log('\n⏸️  SUSPEND / REACTIVATE');

  if (!createdMerchantId) {
    skip('Suspend/Reactivate', 'No test merchant');
    return;
  }

  await test('Suspend merchant', async () => {
    const r = await api('POST', `/api/admin/merchants/${createdMerchantId}/suspend`, {
      cookies: adminCookies,
      body: { reason: 'Sanity test suspension' },
    });
    assertStatus(r, 200, 'suspend');
  });

  await test('Reactivate merchant', async () => {
    const r = await api('POST', `/api/admin/merchants/${createdMerchantId}/reactivate`, {
      cookies: adminCookies,
    });
    assertStatus(r, 200, 'reactivate');
  });
}

// ═══════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════

async function cleanup() {
  console.log('\n🧹 CLEANUP');

  if (SKIP_CLEANUP) {
    console.log('  ⏭️  Skipped (--skip-cleanup flag)');
    return;
  }

  // Delete announcement if still exists
  if (createdAnnouncementId) {
    try {
      await api('DELETE', `/api/admin/announcements/${createdAnnouncementId}`, { cookies: adminCookies });
      console.log('  🗑️  Deleted test announcement');
    } catch { console.log('  ⚠️  Could not delete announcement'); }
  }

  // Suspend test merchant (deactivates all staff, effectively disabling it)
  // Note: full deletion would require DB access — suspend is the safe admin-level action
  if (createdMerchantId) {
    try {
      // Make sure it's active first (might have been suspended in tests)
      await api('POST', `/api/admin/merchants/${createdMerchantId}/reactivate`, { cookies: adminCookies }).catch(() => {});
      await api('POST', `/api/admin/merchants/${createdMerchantId}/suspend`, {
        cookies: adminCookies,
        body: { reason: 'Sanity test cleanup' },
      });
      console.log(`  🗑️  Suspended test merchant #${createdMerchantId} (${TEST_MERCHANT.businessName})`);
    } catch { console.log('  ⚠️  Could not suspend merchant'); }
  }

  // Block merged test user (can't delete via API, but block marks it clearly)
  if (testEndUserId1) {
    try {
      await api('POST', `/api/admin/users/${testEndUserId1}/block`, { cookies: adminCookies });
      console.log(`  🗑️  Blocked test user #${testEndUserId1}`);
    } catch { console.log('  ⚠️  Could not block test user'); }
  }

  console.log('  ℹ️  Note: test data (merchant, users) is suspended/blocked but not deleted from DB.');
  console.log(`  ℹ️  Search "${TEST_PREFIX}" in admin to find and review test data.`);
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(`  FIDDO Sanity Test — ${BASE}`);
  console.log(`  ${new Date().toLocaleString('fr-FR')}`);
  console.log('═══════════════════════════════════════════════');

  // 1. Health & Frontend
  await suiteHealth();
  await suiteFrontendPages();

  // 2. Admin auth (required for most tests)
  const adminOk = await suiteAdminAuth();
  if (!adminOk) {
    console.log('\n⚠️  Admin auth failed — skipping admin-dependent tests');
    console.log('   Set env vars: FIDDO_ADMIN_EMAIL / FIDDO_ADMIN_PASSWORD');
    printReport();
    return;
  }

  // 3. Admin features
  await suiteAdminStats();
  await suiteAdminMerchants();

  // 4. Merchant registration + validation
  await suiteMerchantRegistration();

  // 5. Client flow (credit, lookup, search)
  await suiteClientFlow();

  // 6. Merchant-side features
  await suiteMerchantSide();
  await suiteStaffManagement();

  // 7. Admin user management (block/unblock/merge)
  await suiteAdminUsers();

  // 8. Announcements CRUD
  await suiteAnnouncements();

  // 9. Suspend/Reactivate
  await suiteSuspendReactivate();

  // 10. Cleanup
  await cleanup();

  // Report
  printReport();
}

function printReport() {
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const total = results.passed + results.failed + results.skipped;

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  RÉSULTATS: ${results.passed}/${total} passés  |  ${results.failed} échoués  |  ${results.skipped} ignorés`);
  console.log(`  Durée: ${duration}s`);

  if (results.errors.length > 0) {
    console.log('\n  ─── ÉCHECS ───');
    results.errors.forEach(e => {
      console.log(`  ❌ ${e.name}`);
      console.log(`     ${e.error}`);
    });
  }

  console.log('═══════════════════════════════════════════════');

  if (results.failed > 0) {
    console.log('\n💥 Des tests ont échoué — vérifiez les erreurs ci-dessus.');
    process.exit(1);
  } else {
    console.log('\n🎉 Tous les tests passent !');
    process.exit(0);
  }
}

main().catch(e => {
  console.error('\n💥 Erreur fatale:', e.message);
  process.exit(2);
});
