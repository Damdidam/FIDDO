#!/usr/bin/env node

// ═══════════════════════════════════════════════════════
// FIDDO V3.5 — Complete Sanity Test Suite
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
const ADMIN_EMAIL    = process.env.FIDDO_ADMIN_EMAIL    || 'CHANGE_ME';
const ADMIN_PASSWORD = process.env.FIDDO_ADMIN_PASSWORD || 'CHANGE_ME';

// Unique per run
const RUN_ID = Date.now();
const TEST_PREFIX = `_sanity_${RUN_ID}`;
const TEST_SUFFIX = String(RUN_ID).slice(-6);
const TEST_PIN = '1234';

const TEST_MERCHANT = {
  businessName:      `Test Sanity ${TEST_PREFIX}`,
  email:             `sanity${TEST_PREFIX}@test-fiddo.be`,
  vatNumber:         `BE0${String(RUN_ID).slice(-9)}`,
  address:           '1 Rue du Test, 1000 Bruxelles',
  phone:             '+32400000000',
  ownerPhone:        '+32400000099',
  ownerEmail:        `owner${TEST_PREFIX}@test-fiddo.be`,
  ownerPassword:     'TestPass123!',
  ownerName:         'Sanity Tester',
  pointsPerEuro:     1,
  pointsForReward:   100,
  rewardDescription: 'Récompense test',
};
const TEST_CLIENT_1 = { email: `client1${TEST_PREFIX}@test-fiddo.be`, phone: `+324900${TEST_SUFFIX}`, name: 'Client Test Un' };
const TEST_CLIENT_2 = { email: `client2${TEST_PREFIX}@test-fiddo.be`, phone: `+324901${TEST_SUFFIX}`, name: 'Client Test Deux' };
const TEST_CLIENT_3 = { email: `client3${TEST_PREFIX}@test-fiddo.be`, phone: `+324902${TEST_SUFFIX}`, name: 'Client Test Trois' };
const TEST_CLIENT_4 = { email: `client4${TEST_PREFIX}@test-fiddo.be`, phone: `+324903${TEST_SUFFIX}`, name: 'Client Test Quatre' };
const TEST_CASHIER = { email: `cashier${TEST_PREFIX}@test-fiddo.be`, password: 'Cashier123!', name: 'Caissier Test', role: 'cashier' };
const TEST_MANAGER = { email: `manager${TEST_PREFIX}@test-fiddo.be`, password: 'Manager123!', name: 'Manager Test', role: 'manager' };

// ─── State ───────────────────────────────────────────
let adminCookies = '';
let ownerCookies = '';
let cashierCookies = '';
let managerCookies = '';
let createdMerchantId = null;
let createdAnnouncementId = null;
let testEndUserId1 = null;
let testEndUserId3 = null;
let merchantClientId1 = null;
let merchantClientId2 = null;
let merchantClientId3 = null;
let merchantClientId4 = null;
let createdCashierId = null;
let createdManagerId = null;
let merchantQrToken = null;

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

async function api(method, path, { body, cookies, raw } = {}) {
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
  if (VERBOSE) console.log(`    ${method} ${path} → ${resp.status}`, typeof data === 'object' ? JSON.stringify(data).slice(0, 120) : '');
  return { status: resp.status, data, resp };
}

async function test(name, fn) {
  try { await fn(); results.passed++; console.log(`  ✅ ${name}`); }
  catch (e) { results.failed++; results.errors.push({ name, error: e.message }); console.log(`  ❌ ${name} — ${e.message}`); }
}

function skip(name, reason) { results.skipped++; console.log(`  ⏭️  ${name} — ${reason}`); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertStatus(r, expected, label) {
  assert(r.status === expected, `${label}: expected ${expected}, got ${r.status} — ${typeof r.data === 'object' ? JSON.stringify(r.data).slice(0, 100) : String(r.data).slice(0, 100)}`);
}

// ═══════════════════════════════════════════════════════
// 1. HEALTH
// ═══════════════════════════════════════════════════════

async function suiteHealth() {
  console.log('\n🏥 HEALTH');
  await test('API /health', async () => {
    const r = await api('GET', '/api/health');
    assertStatus(r, 200, 'health');
    assert(r.data.status === 'ok', `status="${r.data.status}"`);
    assert(r.data.version, 'no version');
  });
}

// ═══════════════════════════════════════════════════════
// 2. FRONTEND PAGES
// ═══════════════════════════════════════════════════════

async function suiteFrontendPages() {
  console.log('\n🌐 FRONTEND PAGES');
  const pages = [
    ['Landing','/'], ['Login','/login'], ['Dashboard','/dashboard'], ['Credit','/credit'],
    ['Clients','/clients'], ['Staff','/staff'], ['Preferences','/preferences'], ['Messages','/messages'],
    ['Client Form','/client-form'], ['Client Portal','/me'], ['Admin Login','/admin'], ['Admin Dashboard','/admin/dashboard'],
  ];
  for (const [name, path] of pages) {
    await test(`${name} (${path})`, async () => {
      const resp = await fetch(`${BASE}${path}`, { redirect: 'follow' });
      assert(resp.ok, `HTTP ${resp.status}`);
      const html = await resp.text();
      assert(html.includes('<!DOCTYPE html>') || html.includes('<html'), 'Not HTML');
    });
  }
}

// ═══════════════════════════════════════════════════════
// 3. ADMIN AUTH
// ═══════════════════════════════════════════════════════

async function suiteAdminAuth() {
  console.log('\n🔐 ADMIN AUTH');
  if (ADMIN_EMAIL === 'CHANGE_ME') { skip('Admin login', 'Set FIDDO_ADMIN_EMAIL / FIDDO_ADMIN_PASSWORD'); return false; }

  await test('Admin login', async () => {
    const r = await api('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, raw: true });
    assert(r.ok, `Failed: ${r.status}`);
    adminCookies = extractCookies(r);
    assert(adminCookies.includes('admin_token'), 'No admin_token');
  });
  await test('Admin verify', async () => {
    const r = await api('GET', '/api/admin/auth/verify', { cookies: adminCookies });
    assertStatus(r, 200, 'verify');
    assert(r.data.admin, 'No admin');
  });
  await test('Admin bad password → 401', async () => {
    const r = await api('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: 'wrong' } });
    assertStatus(r, 401, 'bad-pass');
  });
  await test('Admin no cookie → 401/403', async () => {
    const r = await api('GET', '/api/admin/auth/verify');
    assert(r.status === 401 || r.status === 403, `Got ${r.status}`);
  });
  return true;
}

// ═══════════════════════════════════════════════════════
// 4. STAFF AUTH & REGISTRATION
// ═══════════════════════════════════════════════════════

async function suiteStaffAuth() {
  console.log('\n📝 REGISTRATION & LOGIN');

  await test('Register: missing fields → 400', async () => {
    assertStatus(await api('POST', '/api/auth/register', { body: { businessName: 'X' } }), 400, 'missing');
  });
  await test('Register: short password → 400', async () => {
    assertStatus(await api('POST', '/api/auth/register', { body: { ...TEST_MERCHANT, ownerPassword: '123' } }), 400, 'short');
  });
  await test('Register: invalid VAT → 400', async () => {
    assertStatus(await api('POST', '/api/auth/register', { body: { ...TEST_MERCHANT, vatNumber: 'NOPE' } }), 400, 'vat');
  });
  await test('Register: invalid email → 400', async () => {
    assertStatus(await api('POST', '/api/auth/register', { body: { ...TEST_MERCHANT, ownerEmail: 'bad' } }), 400, 'email');
  });
  await test('Register → 201', async () => {
    const r = await api('POST', '/api/auth/register', { body: TEST_MERCHANT });
    assertStatus(r, 201, 'register');
    createdMerchantId = r.data.merchantId;
  });
  await test('Register: duplicate VAT → 400', async () => {
    assertStatus(await api('POST', '/api/auth/register', { body: { ...TEST_MERCHANT, ownerEmail: `dup${TEST_PREFIX}@t.be` } }), 400, 'dup');
  });
  await test('Login before validation → 403', async () => {
    assertStatus(await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword } }), 403, 'pre');
  });

  if (!createdMerchantId) return;

  await test('Admin validates merchant', async () => {
    assertStatus(await api('POST', `/api/admin/merchants/${createdMerchantId}/validate`, { cookies: adminCookies }), 200, 'validate');
  });
  await test('Owner login', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword }, raw: true });
    assert(r.ok, `Failed: ${r.status}`);
    ownerCookies = extractCookies(r);
    assert(ownerCookies.includes('staff_token'), 'No token');
  });
  await test('Owner verify', async () => {
    const r = await api('GET', '/api/auth/verify', { cookies: ownerCookies });
    assertStatus(r, 200, 'verify');
    assert(r.data.staff.role === 'owner', `Role=${r.data.staff.role}`);
  });
  await test('Login bad password → 401', async () => {
    assertStatus(await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: 'wrong' } }), 401, 'bad');
  });
  await test('Login unknown → 401', async () => {
    assertStatus(await api('POST', '/api/auth/login', { body: { email: 'no@no.com', password: 'x' } }), 401, 'unknown');
  });
  await test('Verify no cookie → 401/403', async () => {
    const r = await api('GET', '/api/auth/verify');
    assert(r.status === 401 || r.status === 403, `Got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════
// 5. STAFF CRUD
// ═══════════════════════════════════════════════════════

async function suiteStaffCRUD() {
  console.log('\n👥 STAFF CRUD');
  if (!ownerCookies) { skip('Staff CRUD', 'No owner'); return; }

  await test('List staff', async () => {
    const r = await api('GET', '/api/staff', { cookies: ownerCookies });
    assertStatus(r, 200, 'list');
    assert(r.data.staff.length >= 1, 'No staff');
  });
  await test('Create cashier', async () => {
    const r = await api('POST', '/api/staff', { cookies: ownerCookies, body: TEST_CASHIER });
    assertStatus(r, 201, 'cashier');
    createdCashierId = r.data.staffId || r.data.staff?.id || r.data.id;
  });
  await test('Create manager', async () => {
    const r = await api('POST', '/api/staff', { cookies: ownerCookies, body: TEST_MANAGER });
    assertStatus(r, 201, 'manager');
    createdManagerId = r.data.staffId || r.data.staff?.id || r.data.id;
  });
  await test('Cashier login', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: TEST_CASHIER.email, password: TEST_CASHIER.password }, raw: true });
    assert(r.ok, `Failed: ${r.status}`);
    cashierCookies = extractCookies(r);
  });
  await test('Manager login', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: TEST_MANAGER.email, password: TEST_MANAGER.password }, raw: true });
    assert(r.ok, `Failed: ${r.status}`);
    managerCookies = extractCookies(r);
  });

  if (createdCashierId) {
    await test('Update role → manager', async () => {
      assertStatus(await api('PUT', `/api/staff/${createdCashierId}/role`, { cookies: ownerCookies, body: { role: 'manager' } }), 200, 'up');
    });
    await test('Revert role → cashier', async () => {
      assertStatus(await api('PUT', `/api/staff/${createdCashierId}/role`, { cookies: ownerCookies, body: { role: 'cashier' } }), 200, 'down');
    });
    await test('Toggle off', async () => {
      assertStatus(await api('PUT', `/api/staff/${createdCashierId}/toggle`, { cookies: ownerCookies }), 200, 'off');
    });
    await test('Toggle on', async () => {
      assertStatus(await api('PUT', `/api/staff/${createdCashierId}/toggle`, { cookies: ownerCookies }), 200, 'on');
    });
  }
}

// ═══════════════════════════════════════════════════════
// 6. RBAC
// ═══════════════════════════════════════════════════════

async function suiteRBAC() {
  console.log('\n🛡️  RBAC');
  if (!cashierCookies || !managerCookies) { skip('RBAC', 'No sessions'); return; }

  await test('Cashier: /clients → 403', async () => { assertStatus(await api('GET', '/api/clients', { cookies: cashierCookies }), 403, 'c'); });
  await test('Cashier: /clients/search → 403', async () => { assertStatus(await api('GET', '/api/clients/search?q=test', { cookies: cashierCookies }), 403, 'c'); });
  await test('Cashier: POST /staff → 403', async () => {
    assertStatus(await api('POST', '/api/staff', { cookies: cashierCookies, body: { email: 'x@t.be', password: 'Test1!', name: 'X', role: 'cashier' } }), 403, 'c');
  });
  await test('Cashier: export CSV → 403', async () => { assertStatus(await api('POST', '/api/clients/export/csv', { cookies: cashierCookies }), 403, 'c'); });
  await test('Manager: /clients → 200', async () => { assertStatus(await api('GET', '/api/clients', { cookies: managerCookies }), 200, 'm'); });
  await test('Manager: export CSV → 403', async () => { assertStatus(await api('POST', '/api/clients/export/csv', { cookies: managerCookies }), 403, 'm'); });
  await test('Manager: POST /staff → 403', async () => {
    assertStatus(await api('POST', '/api/staff', { cookies: managerCookies, body: { email: 'x@t.be', password: 'Test1!', name: 'X', role: 'cashier' } }), 403, 'm');
  });

  // Cashier credit within limit
  await test('Cashier: credit 50€ → 200', async () => {
    const r = await api('POST', '/api/clients/credit', { cookies: cashierCookies, body: { ...TEST_CLIENT_3, amount: 50 } });
    assertStatus(r, 200, 'c');
    if (r.data.client) merchantClientId3 = r.data.client.id;
  });
  await test('Cashier: credit 250€ → 403', async () => {
    assertStatus(await api('POST', '/api/clients/credit', { cookies: cashierCookies, body: { email: TEST_CLIENT_3.email, amount: 250 } }), 403, 'c');
  });
}

// ═══════════════════════════════════════════════════════
// 7. CLIENT CREDIT / LOOKUP / LIST
// ═══════════════════════════════════════════════════════

async function suiteClientFlow() {
  console.log('\n💳 CREDIT / LOOKUP / LIST');
  if (!ownerCookies) { skip('Client flow', 'No owner'); return; }

  // Credit clients
  await test('Credit client 1 (25€ new)', async () => {
    const r = await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { ...TEST_CLIENT_1, amount: 25 } });
    assertStatus(r, 200, 'c1');
    assert(r.data.isNewClient === true, 'Not new');
    merchantClientId1 = r.data.client.id;
  });
  await test('Credit client 2 (50€ new)', async () => {
    const r = await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { ...TEST_CLIENT_2, amount: 50 } });
    assertStatus(r, 200, 'c2');
    merchantClientId2 = r.data.client.id;
  });
  await test('Credit client 4 (10€ new)', async () => {
    const r = await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { ...TEST_CLIENT_4, amount: 10 } });
    assertStatus(r, 200, 'c4');
    merchantClientId4 = r.data.client.id;
  });
  await test('Credit client 1 again (30€)', async () => {
    const r = await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 30 } });
    assertStatus(r, 200, 'c1b');
    assert(r.data.isNewClient === false, 'Should be existing');
    assert(r.data.client.visit_count >= 2, 'Visits < 2');
  });
  // Client 1 = 55 pts. Need 100 for reward. Credit 50€ more.
  await test('Credit client 1 (50€ more)', async () => {
    const r = await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 50 } });
    assertStatus(r, 200, 'c1c');
    // Now client 1 = 105 pts
  });

  // Validation errors
  await test('Credit: no identifier → 400', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { amount: 10 } }), 400, 'no-id'); });
  await test('Credit: negative → 400', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: -5 } }), 400, 'neg'); });
  await test('Credit: zero → 400', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 0 } }), 400, 'zero'); });

  // Idempotency
  const iKey = `idem_${TEST_PREFIX}`;
  await test('Idempotent credit (first)', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 10, idempotencyKey: iKey } }), 200, 'i1'); });
  await test('Idempotent credit (dup)', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 10, idempotencyKey: iKey } }), 200, 'i2'); });

  // Lookup
  await test('Lookup by email', async () => {
    const r = await api('GET', `/api/clients/lookup?email=${encodeURIComponent(TEST_CLIENT_1.email)}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'le');
    assert(r.data.found === true, 'Not found');
  });
  await test('Lookup by phone', async () => {
    const r = await api('GET', `/api/clients/lookup?phone=${encodeURIComponent(TEST_CLIENT_1.phone)}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'lp');
    assert(r.data.found === true, 'Not found');
  });
  await test('Lookup unknown → false', async () => {
    const r = await api('GET', '/api/clients/lookup?email=nobody@x.invalid', { cookies: ownerCookies });
    assertStatus(r, 200, 'lu');
    assert(r.data.found === false, 'Should be false');
  });

  // List / Search
  await test('List clients', async () => {
    const r = await api('GET', '/api/clients', { cookies: ownerCookies });
    assertStatus(r, 200, 'list');
    assert(r.data.clients.length >= 3, `Got ${r.data.clients.length}`);
  });
  await test('Search clients', async () => {
    const r = await api('GET', `/api/clients/search?q=${encodeURIComponent('Client Test')}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'search');
    assert(r.data.clients.length >= 1, 'Empty');
  });
  await test('Search short → 400', async () => { assertStatus(await api('GET', '/api/clients/search?q=A', { cookies: ownerCookies }), 400, 'short'); });
  await test('Search global', async () => {
    const r = await api('GET', `/api/clients/search-global?q=${encodeURIComponent('Client Test')}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'global');
    assert(r.data.clients.length >= 1, 'Empty');
  });
  await test('Search global short → 400', async () => { assertStatus(await api('GET', '/api/clients/search-global?q=A', { cookies: ownerCookies }), 400, 'short'); });
  await test('Enriched', async () => { assertStatus(await api('GET', '/api/clients/enriched', { cookies: ownerCookies }), 200, 'enriched'); });
  await test('Quick search', async () => { assertStatus(await api('GET', `/api/clients/quick-search?q=${encodeURIComponent('Client')}`, { cookies: ownerCookies }), 200, 'quick'); });
  await test('Recent activity', async () => {
    const r = await api('GET', '/api/clients/recent-activity', { cookies: ownerCookies });
    assertStatus(r, 200, 'activity');
    assert(Array.isArray(r.data.transactions), 'Not array');
  });
  await test('Near-duplicates', async () => { assertStatus(await api('GET', '/api/clients/near-duplicates', { cookies: ownerCookies }), 200, 'dups'); });

  // Detail
  if (merchantClientId1) {
    await test('Client detail', async () => {
      const r = await api('GET', `/api/clients/${merchantClientId1}`, { cookies: ownerCookies });
      assertStatus(r, 200, 'detail');
      assert(r.data.client && Array.isArray(r.data.transactions), 'Bad shape');
    });
  }
  await test('Detail 999999 → 404', async () => { assertStatus(await api('GET', '/api/clients/999999', { cookies: ownerCookies }), 404, '404'); });

  // Adjust
  if (merchantClientId1) {
    await test('Adjust +20', async () => { assertStatus(await api('POST', '/api/clients/adjust', { cookies: ownerCookies, body: { merchantClientId: merchantClientId1, pointsDelta: 20, reason: 'Bonus' } }), 200, 'up'); });
    await test('Adjust -5', async () => { assertStatus(await api('POST', '/api/clients/adjust', { cookies: ownerCookies, body: { merchantClientId: merchantClientId1, pointsDelta: -5, reason: 'Correction' } }), 200, 'down'); });
    // Client 1 now = 105 + 10(idem) + 20 - 5 = 130 pts
  }
}

// ═══════════════════════════════════════════════════════
// 8. PIN & REWARD
// ═══════════════════════════════════════════════════════

async function suitePinReward() {
  console.log('\n🎁 PIN & REWARD');
  if (!ownerCookies || !merchantClientId1) { skip('PIN/Reward', 'No data'); return; }

  // Set PIN
  await test('Set PIN (1234)', async () => {
    const r = await api('POST', `/api/clients/${merchantClientId1}/pin`, { cookies: ownerCookies, body: { pin: TEST_PIN } });
    assertStatus(r, 200, 'set-pin');
    assert(r.data.has_pin === true, 'No has_pin');
  });
  await test('Set PIN: invalid (3 digits) → 400', async () => {
    assertStatus(await api('POST', `/api/clients/${merchantClientId1}/pin`, { cookies: ownerCookies, body: { pin: '123' } }), 400, 'bad-pin');
  });
  await test('Set PIN: invalid (letters) → 400', async () => {
    assertStatus(await api('POST', `/api/clients/${merchantClientId1}/pin`, { cookies: ownerCookies, body: { pin: 'abcd' } }), 400, 'bad-pin');
  });

  // Reward: no PIN → 403
  await test('Reward without PIN → 403', async () => {
    const r = await api('POST', '/api/clients/reward', { cookies: ownerCookies, body: { merchantClientId: merchantClientId1 } });
    assertStatus(r, 403, 'no-pin');
  });

  // Reward: wrong PIN → 403
  await test('Reward wrong PIN → 403', async () => {
    const r = await api('POST', '/api/clients/reward', { cookies: ownerCookies, body: { merchantClientId: merchantClientId1, pin: '9999' } });
    assertStatus(r, 403, 'wrong-pin');
  });

  // Reward: correct PIN → 200
  await test('Reward with PIN → 200', async () => {
    const r = await api('POST', '/api/clients/reward', { cookies: ownerCookies, body: { merchantClientId: merchantClientId1, pin: TEST_PIN } });
    assertStatus(r, 200, 'reward');
    assert(r.data.transaction, 'No transaction');
    assert(r.data.transaction.points_delta < 0, 'Points should decrease');
  });

  // Reward: insufficient points on client 4 (only 10 pts, threshold=100)
  if (merchantClientId4) {
    await test('Reward insufficient points → 400', async () => {
      const r = await api('POST', '/api/clients/reward', { cookies: ownerCookies, body: { merchantClientId: merchantClientId4, pin: '0000' } });
      assertStatus(r, 400, 'insufficient');
    });
  }

  // Reward: no merchantClientId → 400
  await test('Reward: no ID → 400', async () => {
    assertStatus(await api('POST', '/api/clients/reward', { cookies: ownerCookies, body: {} }), 400, 'no-id');
  });
}

// ═══════════════════════════════════════════════════════
// 9. CLIENT MANAGEMENT (edit, notes, custom reward, block)
// ═══════════════════════════════════════════════════════

async function suiteClientManagement() {
  console.log('\n✏️  CLIENT MANAGEMENT');
  if (!ownerCookies || !merchantClientId1) { skip('Mgmt', 'No data'); return; }

  await test('Edit name', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/edit`, { cookies: ownerCookies, body: { name: 'Renamed', email: TEST_CLIENT_1.email, phone: TEST_CLIENT_1.phone } }), 200, 'edit'); });
  await test('Restore name', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/edit`, { cookies: ownerCookies, body: { name: TEST_CLIENT_1.name, email: TEST_CLIENT_1.email, phone: TEST_CLIENT_1.phone } }), 200, 'restore'); });
  await test('Set notes', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/notes`, { cookies: ownerCookies, body: { notes: 'VIP sanity' } }), 200, 'notes'); });
  await test('Clear notes', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/notes`, { cookies: ownerCookies, body: { notes: '' } }), 200, 'notes-clr'); });
  await test('Set custom reward', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/custom-reward`, { cookies: ownerCookies, body: { customReward: 'Dessert' } }), 200, 'cust'); });
  await test('Clear custom reward', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/custom-reward`, { cookies: ownerCookies, body: { customReward: null } }), 200, 'cust-clr'); });

  await test('Block client', async () => { assertStatus(await api('POST', `/api/clients/${merchantClientId1}/block`, { cookies: ownerCookies }), 200, 'block'); });
  await test('Credit blocked → 403', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 10 } }), 403, 'blocked'); });
  await test('Unblock client', async () => { assertStatus(await api('POST', `/api/clients/${merchantClientId1}/unblock`, { cookies: ownerCookies }), 200, 'unblock'); });
  await test('Credit after unblock', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 5 } }), 200, 'ok'); });
  await test('Resend email', async () => {
    const r = await api('POST', `/api/clients/${merchantClientId1}/resend-email`, { cookies: ownerCookies });
    assert(r.status === 200 || r.status === 400, `Got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════
// 10. CLIENT DELETE
// ═══════════════════════════════════════════════════════

async function suiteClientDelete() {
  console.log('\n🗑️  CLIENT DELETE');
  if (!ownerCookies || !merchantClientId4) { skip('Delete', 'No data'); return; }

  await test('Delete client 4 (RGPD)', async () => {
    const r = await api('DELETE', `/api/clients/${merchantClientId4}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'delete');
    assert(r.data.message, 'No message');
  });
  await test('Deleted client → 404', async () => {
    assertStatus(await api('GET', `/api/clients/${merchantClientId4}`, { cookies: ownerCookies }), 404, '404');
    merchantClientId4 = null;
  });
}

// ═══════════════════════════════════════════════════════
// 11. CLIENT MERGE (merchant level)
// ═══════════════════════════════════════════════════════

async function suiteClientMerge() {
  console.log('\n🔀 CLIENT MERGE');
  if (!ownerCookies || !merchantClientId1 || !merchantClientId2) { skip('Merge', 'No data'); return; }

  await test('Merge client 2 → 1', async () => {
    const r = await api('POST', `/api/clients/${merchantClientId1}/merge`, { cookies: ownerCookies, body: { sourceMerchantClientId: merchantClientId2, reason: 'Sanity' } });
    assertStatus(r, 200, 'merge');
    merchantClientId2 = null;
  });
  await test('Verify merged points', async () => {
    const r = await api('GET', `/api/clients/${merchantClientId1}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'verify');
    assert(r.data.client.points_balance > 50, `Low: ${r.data.client.points_balance}`);
  });
}

// ═══════════════════════════════════════════════════════
// 12. PREFERENCES & SETTINGS
// ═══════════════════════════════════════════════════════

async function suitePreferences() {
  console.log('\n⚙️  PREFERENCES');
  if (!ownerCookies) { skip('Prefs', 'No owner'); return; }

  await test('Get preferences', async () => {
    const r = await api('GET', '/api/preferences', { cookies: ownerCookies });
    assertStatus(r, 200, 'get');
    assert(r.data.preferences, 'No prefs');
  });
  await test('Update preferences (theme)', async () => {
    const r = await api('PUT', '/api/preferences', { cookies: ownerCookies, body: { theme: 'blue' } });
    assertStatus(r, 200, 'theme');
  });
  await test('Revert preferences (theme)', async () => {
    assertStatus(await api('PUT', '/api/preferences', { cookies: ownerCookies, body: { theme: 'teal' } }), 200, 'revert');
  });
  await test('Update loyalty settings', async () => {
    assertStatus(await api('PUT', '/api/auth/settings', { cookies: ownerCookies, body: { pointsPerEuro: 2, pointsForReward: 200, rewardDescription: 'Double' } }), 200, 'up');
  });
  await test('Revert loyalty settings', async () => {
    assertStatus(await api('PUT', '/api/auth/settings', { cookies: ownerCookies, body: { pointsPerEuro: 1, pointsForReward: 100, rewardDescription: 'Test' } }), 200, 'rev');
  });
  await test('Invalid settings → 400', async () => {
    assertStatus(await api('PUT', '/api/auth/settings', { cookies: ownerCookies, body: { pointsPerEuro: -1 } }), 400, 'invalid');
  });

  // Merchant info
  await test('Get merchant info', async () => {
    const r = await api('GET', '/api/preferences/merchant-info', { cookies: ownerCookies });
    assertStatus(r, 200, 'info');
  });
  await test('Update merchant info', async () => {
    const r = await api('PUT', '/api/preferences/merchant-info', {
      cookies: ownerCookies,
      body: { businessName: TEST_MERCHANT.businessName, address: TEST_MERCHANT.address, phone: TEST_MERCHANT.phone },
    });
    assertStatus(r, 200, 'info-up');
  });

  // Password change
  await test('Change password (same)', async () => {
    const r = await api('PUT', '/api/preferences/password', {
      cookies: ownerCookies,
      body: { currentPassword: TEST_MERCHANT.ownerPassword, newPassword: TEST_MERCHANT.ownerPassword },
    });
    assertStatus(r, 200, 'pwd');
  });
  await test('Change password: wrong current → 401', async () => {
    const r = await api('PUT', '/api/preferences/password', {
      cookies: ownerCookies,
      body: { currentPassword: 'wrong', newPassword: 'New123!' },
    });
    assertStatus(r, 401, 'pwd-bad');
  });
}

// ═══════════════════════════════════════════════════════
// 13. MESSAGES
// ═══════════════════════════════════════════════════════

async function suiteMessages() {
  console.log('\n💬 MESSAGES');
  if (!ownerCookies) { skip('Messages', 'No owner'); return; }

  await test('Get messages', async () => {
    assertStatus(await api('GET', '/api/messages', { cookies: ownerCookies }), 200, 'list');
  });
  await test('Unread count', async () => {
    const r = await api('GET', '/api/messages/unread-count', { cookies: ownerCookies });
    assertStatus(r, 200, 'unread');
    assert(typeof r.data.count === 'number', 'No count');
  });
  await test('Read all', async () => {
    assertStatus(await api('POST', '/api/messages/read-all', { cookies: ownerCookies }), 200, 'read-all');
  });
  await test('Unread count after read-all', async () => {
    const r = await api('GET', '/api/messages/unread-count', { cookies: ownerCookies });
    assertStatus(r, 200, 'unread');
    assert(r.data.count === 0, `Still unread: ${r.data.count}`);
  });
}

// ═══════════════════════════════════════════════════════
// 14. QR CODE
// ═══════════════════════════════════════════════════════

async function suiteQR() {
  console.log('\n📱 QR CODE');
  if (!ownerCookies) { skip('QR', 'No owner'); return; }

  await test('Generate merchant QR', async () => {
    const r = await api('POST', '/api/qr/generate', { cookies: ownerCookies });
    assertStatus(r, 200, 'generate');
  });
  await test('Get merchant QR token', async () => {
    const r = await api('GET', '/api/qr/token', { cookies: ownerCookies });
    assertStatus(r, 200, 'token');
    assert(r.data.token, 'No token');
    merchantQrToken = r.data.token;
  });
  if (merchantQrToken) {
    await test('QR info (public)', async () => {
      const r = await api('GET', `/api/qr/info/${merchantQrToken}`);
      assertStatus(r, 200, 'info');
      assert(r.data.business_name || r.data.merchant, 'No business');
    });
  }
  await test('QR pending list', async () => {
    const r = await api('GET', '/api/qr/pending', { cookies: ownerCookies });
    assertStatus(r, 200, 'pending');
  });
}

// ═══════════════════════════════════════════════════════
// 15. MERCHANT SIDE FEATURES
// ═══════════════════════════════════════════════════════

async function suiteMerchantSide() {
  console.log('\n🏪 MERCHANT FEATURES');
  if (!ownerCookies) { skip('Merchant', 'No owner'); return; }

  await test('Dashboard stats', async () => {
    const r = await api('GET', '/api/dashboard/stats', { cookies: ownerCookies });
    assertStatus(r, 200, 'stats');
    assert(typeof r.data.totalClients === 'number', 'No totalClients');
  });
  await test('Dashboard activity', async () => { assertStatus(await api('GET', '/api/dashboard/activity', { cookies: ownerCookies }), 200, 'act'); });
  await test('Announcements', async () => { assertStatus(await api('GET', '/api/announcements', { cookies: ownerCookies }), 200, 'ann'); });
  await test('Export CSV', async () => {
    const r = await api('POST', '/api/clients/export/csv', { cookies: ownerCookies });
    assertStatus(r, 200, 'csv');
    assert(r.data.success === true, 'Failed');
  });
  await test('Logout', async () => { assertStatus(await api('POST', '/api/auth/logout', { cookies: ownerCookies }), 200, 'logout'); });
}

// ═══════════════════════════════════════════════════════
// 16. ADMIN STATS & MERCHANTS
// ═══════════════════════════════════════════════════════

async function suiteAdminStats() {
  console.log('\n📊 ADMIN STATS');

  await test('Global stats', async () => {
    const r = await api('GET', '/api/admin/merchants/stats/global', { cookies: adminCookies });
    assertStatus(r, 200, 'stats');
    assert(typeof r.data.merchants === 'object' && typeof r.data.endUsers === 'number', 'Bad shape');
  });
  await test('List merchants', async () => { assertStatus(await api('GET', '/api/admin/merchants', { cookies: adminCookies }), 200, 'all'); });
  await test('List pending', async () => { assertStatus(await api('GET', '/api/admin/merchants?status=pending', { cookies: adminCookies }), 200, 'pending'); });
  await test('List active', async () => { assertStatus(await api('GET', '/api/admin/merchants?status=active', { cookies: adminCookies }), 200, 'active'); });
  if (createdMerchantId) {
    await test('Merchant detail', async () => { assertStatus(await api('GET', `/api/admin/merchants/${createdMerchantId}`, { cookies: adminCookies }), 200, 'detail'); });
  }
  await test('No auth → 401/403', async () => {
    const r = await api('GET', '/api/admin/merchants');
    assert(r.status === 401 || r.status === 403, `Got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════
// 17. ADMIN USERS
// ═══════════════════════════════════════════════════════

async function suiteAdminUsers() {
  console.log('\n👤 ADMIN USERS');

  await test('List users', async () => { assertStatus(await api('GET', '/api/admin/users', { cookies: adminCookies }), 200, 'list'); });
  await test('Search user 1', async () => {
    const r = await api('GET', `/api/admin/users?q=${encodeURIComponent(TEST_CLIENT_1.email)}`, { cookies: adminCookies });
    assertStatus(r, 200, 'search');
    assert(r.data.users.length >= 1, 'Not found');
    testEndUserId1 = r.data.users[0].id;
  });
  await test('Search user 3', async () => {
    const r = await api('GET', `/api/admin/users?q=${encodeURIComponent(TEST_CLIENT_3.email)}`, { cookies: adminCookies });
    assertStatus(r, 200, 'search');
    if (r.data.users.length >= 1) testEndUserId3 = r.data.users[0].id;
  });

  if (!testEndUserId1) return;

  await test('User detail', async () => {
    const r = await api('GET', `/api/admin/users/${testEndUserId1}`, { cookies: adminCookies });
    assertStatus(r, 200, 'detail');
    assert(r.data.user && Array.isArray(r.data.cards), 'Bad shape');
  });
  await test('Global block', async () => { assertStatus(await api('POST', `/api/admin/users/${testEndUserId1}/block`, { cookies: adminCookies }), 200, 'block'); });
  await test('Verify blocked', async () => {
    const r = await api('GET', `/api/admin/users/${testEndUserId1}`, { cookies: adminCookies });
    assert(r.data.user.is_blocked === 1 || r.data.user.is_blocked === true, 'Not blocked');
  });

  // Re-login owner for credit test
  await test('Credit globally blocked → 403', async () => {
    const lr = await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword }, raw: true });
    if (lr.ok) ownerCookies = extractCookies(lr);
    assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 5 } }), 403, 'g-blocked');
  });

  await test('Global unblock', async () => { assertStatus(await api('POST', `/api/admin/users/${testEndUserId1}/unblock`, { cookies: adminCookies }), 200, 'unblock'); });

  // Merge with user 3
  if (testEndUserId1 && testEndUserId3) {
    await test('Admin merge preview', async () => { assertStatus(await api('GET', `/api/admin/users/${testEndUserId1}/merge-preview?sourceId=${testEndUserId3}`, { cookies: adminCookies }), 200, 'preview'); });
    await test('Admin merge execute', async () => {
      const r = await api('POST', `/api/admin/users/${testEndUserId1}/merge`, { cookies: adminCookies, body: { sourceId: testEndUserId3, reason: 'Sanity' } });
      assertStatus(r, 200, 'merge');
      testEndUserId3 = null;
    });
  }

  await test('No auth → 401/403', async () => {
    const r = await api('GET', '/api/admin/users');
    assert(r.status === 401 || r.status === 403, `Got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════
// 18. ANNOUNCEMENTS CRUD
// ═══════════════════════════════════════════════════════

async function suiteAnnouncements() {
  console.log('\n📢 ANNOUNCEMENTS');
  await test('Create', async () => {
    const r = await api('POST', '/api/admin/announcements', { cookies: adminCookies, body: { title: `Sanity ${TEST_PREFIX}`, content: 'Test.', priority: 'info', targetType: 'all', merchantIds: [], expiresAt: null } });
    assertStatus(r, 201, 'create');
    createdAnnouncementId = r.data.id;
  });
  await test('List', async () => { assertStatus(await api('GET', '/api/admin/announcements', { cookies: adminCookies }), 200, 'list'); });
  if (createdAnnouncementId) {
    await test('Update', async () => { assertStatus(await api('PUT', `/api/admin/announcements/${createdAnnouncementId}`, { cookies: adminCookies, body: { title: `Up ${TEST_PREFIX}`, content: 'Upd.', priority: 'warning', targetType: 'all', merchantIds: [], expiresAt: null } }), 200, 'up'); });
    await test('Delete', async () => { assertStatus(await api('DELETE', `/api/admin/announcements/${createdAnnouncementId}`, { cookies: adminCookies }), 200, 'del'); createdAnnouncementId = null; });
  }
}

// ═══════════════════════════════════════════════════════
// 19. MERCHANT LIFECYCLE
// ═══════════════════════════════════════════════════════

async function suiteMerchantLifecycle() {
  console.log('\n⏸️  LIFECYCLE');
  if (!createdMerchantId) { skip('Lifecycle', 'No merchant'); return; }

  await test('Suspend', async () => { assertStatus(await api('POST', `/api/admin/merchants/${createdMerchantId}/suspend`, { cookies: adminCookies, body: { reason: 'Test' } }), 200, 'sus'); });
  await test('Login suspended → 403', async () => { assertStatus(await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword } }), 403, 'sus-login'); });
  await test('Reactivate', async () => { assertStatus(await api('POST', `/api/admin/merchants/${createdMerchantId}/reactivate`, { cookies: adminCookies }), 200, 'react'); });
  await test('Double reactivate → 400', async () => { assertStatus(await api('POST', `/api/admin/merchants/${createdMerchantId}/reactivate`, { cookies: adminCookies }), 400, 'dbl'); });
  await test('Login after reactivation', async () => {
    const r = await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword }, raw: true });
    assert(r.ok, `Failed: ${r.status}`);
    ownerCookies = extractCookies(r);
  });
}

// ═══════════════════════════════════════════════════════
// 20. ADMIN BACKUPS
// ═══════════════════════════════════════════════════════

async function suiteAdminBackups() {
  console.log('\n💾 ADMIN BACKUPS');
  await test('List backups', async () => {
    const r = await api('GET', '/api/admin/backups', { cookies: adminCookies });
    assert(r.status === 200 || r.status === 404, `Got ${r.status}`);
  });
  await test('Backup status', async () => {
    const r = await api('GET', '/api/admin/backups/status', { cookies: adminCookies });
    assert(r.status === 200 || r.status === 404, `Got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════
// 21. CLIENT PORTAL (basic)
// ═══════════════════════════════════════════════════════

async function suiteClientPortal() {
  console.log('\n🪪 CLIENT PORTAL');

  // Login sends magic link — we can test the endpoint responds
  await test('Portal login (sends link)', async () => {
    const r = await api('POST', '/api/portal/login', { body: { email: TEST_CLIENT_1.email } });
    // 200 = link sent, 404 = not found, either is valid behavior
    assert(r.status === 200 || r.status === 404 || r.status === 400, `Got ${r.status}`);
  });
  await test('Portal login no email → 400', async () => {
    const r = await api('POST', '/api/portal/login', { body: {} });
    assert(r.status === 400 || r.status === 404, `Got ${r.status}`);
  });
  await test('Portal cards no auth → 401', async () => {
    const r = await api('GET', '/api/portal/cards');
    assert(r.status === 401 || r.status === 403, `Got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════
// 22. STAFF PASSWORD & DELETE
// ═══════════════════════════════════════════════════════

async function suiteStaffAdvanced() {
  console.log('\n🔧 STAFF ADVANCED');
  if (!ownerCookies) { skip('Staff adv', 'No owner'); return; }

  // Staff password change (owner changes for a staff member)
  if (createdCashierId) {
    await test('Change staff password', async () => {
      const r = await api('PUT', `/api/staff/${createdCashierId}/password`, { cookies: ownerCookies, body: { password: 'NewCash123!' } });
      assertStatus(r, 200, 'pwd');
    });
    await test('Cashier login with new password', async () => {
      const r = await api('POST', '/api/auth/login', { body: { email: TEST_CASHIER.email, password: 'NewCash123!' }, raw: true });
      assert(r.ok, `Failed: ${r.status}`);
    });
  }

  // Delete staff
  if (createdCashierId) {
    await test('Delete cashier', async () => {
      assertStatus(await api('DELETE', `/api/staff/${createdCashierId}`, { cookies: ownerCookies }), 200, 'del-cashier');
      createdCashierId = null;
    });
  }
  if (createdManagerId) {
    await test('Delete manager', async () => {
      assertStatus(await api('DELETE', `/api/staff/${createdManagerId}`, { cookies: ownerCookies }), 200, 'del-manager');
      createdManagerId = null;
    });
  }

  // Verify staff list reduced
  await test('Staff list after deletes', async () => {
    const r = await api('GET', '/api/staff', { cookies: ownerCookies });
    assertStatus(r, 200, 'list');
    assert(r.data.staff.length === 1, `Expected 1 (owner), got ${r.data.staff.length}`);
  });
}

// ═══════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════

async function cleanup() {
  console.log('\n🧹 CLEANUP');
  if (SKIP_CLEANUP) { console.log('  ⏭️  Skipped'); return; }

  if (createdAnnouncementId) {
    try { await api('DELETE', `/api/admin/announcements/${createdAnnouncementId}`, { cookies: adminCookies }); console.log('  🗑️  Announcement'); } catch {}
  }

  // Re-login owner if needed
  try {
    const lr = await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword }, raw: true });
    if (lr.ok) ownerCookies = extractCookies(lr);
  } catch {}

  // Delete remaining staff
  for (const [id, label] of [[createdCashierId, 'cashier'], [createdManagerId, 'manager']]) {
    if (id) { try { await api('DELETE', `/api/staff/${id}`, { cookies: ownerCookies }); console.log(`  🗑️  ${label}`); } catch {} }
  }

  // Suspend merchant
  if (createdMerchantId) {
    try {
      await api('POST', `/api/admin/merchants/${createdMerchantId}/reactivate`, { cookies: adminCookies }).catch(() => {});
      await api('POST', `/api/admin/merchants/${createdMerchantId}/suspend`, { cookies: adminCookies, body: { reason: 'Cleanup' } });
      console.log(`  🗑️  Merchant #${createdMerchantId}`);
    } catch {}
  }

  // Block test users
  for (const uid of [testEndUserId1, testEndUserId3]) {
    if (uid) { try { await api('POST', `/api/admin/users/${uid}/block`, { cookies: adminCookies }); console.log(`  🗑️  User #${uid}`); } catch {} }
  }

  console.log(`  ℹ️  Search "${TEST_PREFIX}" to review.`);
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(`  FIDDO Complete Sanity Test — ${BASE}`);
  console.log(`  ${new Date().toLocaleString('fr-FR')}`);
  console.log('═══════════════════════════════════════════════');

  await suiteHealth();                // 1
  await suiteFrontendPages();         // 12
  const ok = await suiteAdminAuth();  // 4
  if (!ok) { console.log('\n⚠️  Set FIDDO_ADMIN_EMAIL / FIDDO_ADMIN_PASSWORD'); printReport(); return; }

  await suiteStaffAuth();             // 13
  await suiteStaffCRUD();             // 9
  await suiteRBAC();                  // 10
  await suiteClientFlow();            // ~30
  await suitePinReward();             // 7
  await suiteClientManagement();      // 11
  await suiteClientDelete();          // 2
  await suiteClientMerge();           // 2
  await suitePreferences();           // 10
  await suiteMessages();              // 4
  await suiteQR();                    // 4
  await suiteMerchantSide();          // 5
  await suiteAdminStats();            // 6
  await suiteAdminUsers();            // ~12
  await suiteAnnouncements();         // 4
  await suiteMerchantLifecycle();     // 5
  await suiteAdminBackups();          // 2
  await suiteClientPortal();          // 3
  await suiteStaffAdvanced();         // 5

  await cleanup();
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
    results.errors.forEach(e => { console.log(`  ❌ ${e.name}`); console.log(`     ${e.error}`); });
  }
  console.log('═══════════════════════════════════════════════');
  if (results.failed > 0) { console.log('\n💥 Des tests ont échoué.'); process.exit(1); }
  else { console.log('\n🎉 Tous les tests passent !'); process.exit(0); }
}

main().catch(e => { console.error('\n💥 Erreur fatale:', e.message); process.exit(2); });
