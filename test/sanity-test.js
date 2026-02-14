#!/usr/bin/env node

// ═══════════════════════════════════════════════════════
// FIDDO V3.5 — Comprehensive Sanity Test Suite
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

// Test data identifiers (unique per run)
const RUN_ID = Date.now();
const TEST_PREFIX = `_sanity_${RUN_ID}`;
const TEST_SUFFIX = String(RUN_ID).slice(-6);

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
const TEST_CLIENT_3 = {
  email: `client3${TEST_PREFIX}@test-fiddo.be`,
  phone: `+324902${TEST_SUFFIX}`,
  name:  'Client Test Trois',
};
const TEST_CASHIER = {
  email:       `cashier${TEST_PREFIX}@test-fiddo.be`,
  password:    'Cashier123!',
  name:        'Caissier Test',
  role:        'cashier',
};
const TEST_MANAGER = {
  email:       `manager${TEST_PREFIX}@test-fiddo.be`,
  password:    'Manager123!',
  name:        'Manager Test',
  role:        'manager',
};

// ─── State ───────────────────────────────────────────
let adminCookies = '';
let ownerCookies = '';
let cashierCookies = '';
let managerCookies = '';
let createdMerchantId = null;
let createdAnnouncementId = null;
let testEndUserId1 = null;
let testEndUserId2 = null;
let testEndUserId3 = null;
let merchantClientId1 = null;
let merchantClientId2 = null;
let merchantClientId3 = null;
let createdCashierId = null;
let createdManagerId = null;

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

function assertStatus(r, expected, label) {
  assert(
    r.status === expected,
    `${label || 'Request'}: expected ${expected}, got ${r.status} — ${typeof r.data === 'object' ? JSON.stringify(r.data).slice(0, 100) : String(r.data).slice(0, 100)}`
  );
}

// ═══════════════════════════════════════════════════════
// 1. HEALTH & FRONTEND
// ═══════════════════════════════════════════════════════

async function suiteHealth() {
  console.log('\n🏥 HEALTH & INFRA');

  await test('API /health', async () => {
    const r = await api('GET', '/api/health');
    assertStatus(r, 200, '/health');
    assert(r.data.status === 'ok', `status="${r.data.status}"`);
    assert(r.data.version, 'version missing');
  });
}

async function suiteFrontendPages() {
  console.log('\n🌐 FRONTEND PAGES');

  const pages = [
    ['Landing', '/'], ['Login', '/login'], ['Dashboard', '/dashboard'],
    ['Credit', '/credit'], ['Clients', '/clients'], ['Staff', '/staff'],
    ['Preferences', '/preferences'], ['Messages', '/messages'],
    ['Client Form', '/client-form'], ['Client Portal', '/me'],
    ['Admin Login', '/admin'], ['Admin Dashboard', '/admin/dashboard'],
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
// 2. AUTH — ADMIN
// ═══════════════════════════════════════════════════════

async function suiteAdminAuth() {
  console.log('\n🔐 ADMIN AUTH');

  if (ADMIN_EMAIL === 'CHANGE_ME') {
    skip('Admin login', 'Set FIDDO_ADMIN_EMAIL / FIDDO_ADMIN_PASSWORD');
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

  await test('Admin bad password → 401', async () => {
    const r = await api('POST', '/api/admin/auth/login', {
      body: { email: ADMIN_EMAIL, password: 'wrongpassword' },
    });
    assertStatus(r, 401, 'bad-pass');
  });

  await test('Admin no cookie → 401/403', async () => {
    const r = await api('GET', '/api/admin/auth/verify');
    assert(r.status === 401 || r.status === 403, `Expected 401/403, got ${r.status}`);
  });

  return true;
}

// ═══════════════════════════════════════════════════════
// 3. AUTH — STAFF (registration, login, error cases)
// ═══════════════════════════════════════════════════════

async function suiteStaffAuth() {
  console.log('\n📝 STAFF AUTH & REGISTRATION');

  // ── Registration validation errors ──
  await test('Register: missing fields → 400', async () => {
    const r = await api('POST', '/api/auth/register', {
      body: { businessName: 'Incomplete' },
    });
    assertStatus(r, 400, 'missing-fields');
  });

  await test('Register: short password → 400', async () => {
    const r = await api('POST', '/api/auth/register', {
      body: { ...TEST_MERCHANT, ownerPassword: '12345' },
    });
    assertStatus(r, 400, 'short-pass');
  });

  await test('Register: invalid VAT → 400', async () => {
    const r = await api('POST', '/api/auth/register', {
      body: { ...TEST_MERCHANT, vatNumber: 'INVALID' },
    });
    assertStatus(r, 400, 'bad-vat');
  });

  await test('Register: invalid email → 400', async () => {
    const r = await api('POST', '/api/auth/register', {
      body: { ...TEST_MERCHANT, ownerEmail: 'not-an-email' },
    });
    assertStatus(r, 400, 'bad-email');
  });

  // ── Successful registration ──
  await test('Register test merchant → 201', async () => {
    const r = await api('POST', '/api/auth/register', { body: TEST_MERCHANT });
    assertStatus(r, 201, 'register');
    assert(r.data.merchantId, 'No merchantId');
    createdMerchantId = r.data.merchantId;
  });

  await test('Register: duplicate VAT → 400', async () => {
    const r = await api('POST', '/api/auth/register', {
      body: { ...TEST_MERCHANT, ownerEmail: `dup${TEST_PREFIX}@test.be` },
    });
    assertStatus(r, 400, 'dup-vat');
  });

  // ── Login before validation → 403 ──
  await test('Login before validation → 403', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword },
    });
    assertStatus(r, 403, 'pre-validation');
  });

  // ── Admin validates ──
  if (!createdMerchantId) return;

  await test('Admin validates merchant', async () => {
    const r = await api('POST', `/api/admin/merchants/${createdMerchantId}/validate`, {
      cookies: adminCookies,
    });
    assertStatus(r, 200, 'validate');
  });

  // ── Login after validation ──
  await test('Owner login → 200', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword },
      raw: true,
    });
    assert(r.ok, `Login failed: ${r.status}`);
    ownerCookies = extractCookies(r);
    assert(ownerCookies.includes('staff_token'), 'No staff_token');
  });

  await test('Owner verify', async () => {
    const r = await api('GET', '/api/auth/verify', { cookies: ownerCookies });
    assertStatus(r, 200, 'verify');
    assert(r.data.staff.role === 'owner', `Role=${r.data.staff.role}`);
    assert(r.data.merchant, 'No merchant');
  });

  await test('Login bad password → 401', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: TEST_MERCHANT.ownerEmail, password: 'wrongpassword' },
    });
    assertStatus(r, 401, 'bad-pass');
  });

  await test('Login unknown email → 401', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: 'nobody@nowhere.com', password: 'whatever' },
    });
    assertStatus(r, 401, 'unknown');
  });

  await test('Verify no cookie → 401/403', async () => {
    const r = await api('GET', '/api/auth/verify');
    assert(r.status === 401 || r.status === 403, `Expected 401/403, got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════
// 4. STAFF MANAGEMENT (CRUD + roles)
// ═══════════════════════════════════════════════════════

async function suiteStaffCRUD() {
  console.log('\n👥 STAFF MANAGEMENT');

  if (!ownerCookies) { skip('Staff CRUD', 'No owner session'); return; }

  await test('List staff', async () => {
    const r = await api('GET', '/api/staff', { cookies: ownerCookies });
    assertStatus(r, 200, 'list');
    assert(Array.isArray(r.data.staff), 'Not array');
    assert(r.data.staff.length >= 1, 'Should have owner');
  });

  await test('Create cashier', async () => {
    const r = await api('POST', '/api/staff', {
      cookies: ownerCookies,
      body: TEST_CASHIER,
    });
    assertStatus(r, 201, 'create-cashier');
    createdCashierId = r.data.staff?.id || r.data.id;
  });

  await test('Create manager', async () => {
    const r = await api('POST', '/api/staff', {
      cookies: ownerCookies,
      body: TEST_MANAGER,
    });
    assertStatus(r, 201, 'create-manager');
    createdManagerId = r.data.staff?.id || r.data.id;
  });

  await test('Cashier login', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: TEST_CASHIER.email, password: TEST_CASHIER.password },
      raw: true,
    });
    assert(r.ok, `Cashier login failed: ${r.status}`);
    cashierCookies = extractCookies(r);
  });

  await test('Manager login', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: TEST_MANAGER.email, password: TEST_MANAGER.password },
      raw: true,
    });
    assert(r.ok, `Manager login failed: ${r.status}`);
    managerCookies = extractCookies(r);
  });

  if (createdCashierId) {
    await test('Update role cashier → manager', async () => {
      const r = await api('PUT', `/api/staff/${createdCashierId}/role`, {
        cookies: ownerCookies,
        body: { role: 'manager' },
      });
      assertStatus(r, 200, 'update-role');
    });

    await test('Revert role → cashier', async () => {
      const r = await api('PUT', `/api/staff/${createdCashierId}/role`, {
        cookies: ownerCookies,
        body: { role: 'cashier' },
      });
      assertStatus(r, 200, 'revert-role');
    });

    await test('Toggle staff off', async () => {
      const r = await api('PUT', `/api/staff/${createdCashierId}/toggle`, { cookies: ownerCookies });
      assertStatus(r, 200, 'toggle-off');
    });

    await test('Toggle staff on', async () => {
      const r = await api('PUT', `/api/staff/${createdCashierId}/toggle`, { cookies: ownerCookies });
      assertStatus(r, 200, 'toggle-on');
    });
  }
}

// ═══════════════════════════════════════════════════════
// 5. ROLE-BASED ACCESS CONTROL
// ═══════════════════════════════════════════════════════

async function suiteRBAC() {
  console.log('\n🛡️  ROLE-BASED ACCESS');

  if (!cashierCookies || !managerCookies) { skip('RBAC', 'No cashier/manager sessions'); return; }

  await test('Cashier: GET /clients → 403', async () => {
    const r = await api('GET', '/api/clients', { cookies: cashierCookies });
    assertStatus(r, 403, 'cashier-list');
  });

  await test('Cashier: GET /clients/search → 403', async () => {
    const r = await api('GET', '/api/clients/search?q=test', { cookies: cashierCookies });
    assertStatus(r, 403, 'cashier-search');
  });

  await test('Cashier: POST /staff → 403', async () => {
    const r = await api('POST', '/api/staff', {
      cookies: cashierCookies,
      body: { email: 'nope@test.be', password: 'Test123!', displayName: 'Nope', role: 'cashier' },
    });
    assertStatus(r, 403, 'cashier-staff');
  });

  await test('Cashier: POST /clients/export/csv → 403', async () => {
    const r = await api('POST', '/api/clients/export/csv', { cookies: cashierCookies });
    assertStatus(r, 403, 'cashier-csv');
  });

  await test('Manager: GET /clients → 200', async () => {
    const r = await api('GET', '/api/clients', { cookies: managerCookies });
    assertStatus(r, 200, 'manager-list');
  });

  await test('Manager: POST /clients/export/csv → 403', async () => {
    const r = await api('POST', '/api/clients/export/csv', { cookies: managerCookies });
    assertStatus(r, 403, 'manager-csv');
  });

  await test('Manager: POST /staff → 403', async () => {
    const r = await api('POST', '/api/staff', {
      cookies: managerCookies,
      body: { email: 'nope2@test.be', password: 'Test123!', displayName: 'Nope', role: 'cashier' },
    });
    assertStatus(r, 403, 'manager-staff');
  });

  await test('Cashier: credit 50€ → 200', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: cashierCookies,
      body: { email: TEST_CLIENT_3.email, phone: TEST_CLIENT_3.phone, name: TEST_CLIENT_3.name, amount: 50 },
    });
    assertStatus(r, 200, 'cashier-credit');
    if (r.data.client) merchantClientId3 = r.data.client.id;
  });

  await test('Cashier: credit 250€ → 403 (limit)', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: cashierCookies,
      body: { email: TEST_CLIENT_3.email, amount: 250 },
    });
    assertStatus(r, 403, 'cashier-limit');
  });
}

// ═══════════════════════════════════════════════════════
// 6. CLIENT CREDIT / LOOKUP / LIST FLOW
// ═══════════════════════════════════════════════════════

async function suiteClientFlow() {
  console.log('\n💳 CLIENT CREDIT / LOOKUP / LIST');

  if (!ownerCookies) { skip('Client flow', 'No owner session'); return; }

  await test('Credit client 1 (new, 25€)', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: ownerCookies,
      body: { email: TEST_CLIENT_1.email, phone: TEST_CLIENT_1.phone, name: TEST_CLIENT_1.name, amount: 25 },
    });
    assertStatus(r, 200, 'credit');
    assert(r.data.client, 'No client');
    assert(r.data.transaction.points_delta > 0, 'No points');
    assert(r.data.isNewClient === true, 'Should be new');
    merchantClientId1 = r.data.client.id;
  });

  await test('Credit client 2 (new, 50€)', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: ownerCookies,
      body: { email: TEST_CLIENT_2.email, phone: TEST_CLIENT_2.phone, name: TEST_CLIENT_2.name, amount: 50 },
    });
    assertStatus(r, 200, 'credit');
    merchantClientId2 = r.data.client.id;
  });

  await test('Credit client 1 again (existing, 30€)', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: ownerCookies,
      body: { email: TEST_CLIENT_1.email, amount: 30 },
    });
    assertStatus(r, 200, 'credit-again');
    assert(r.data.isNewClient === false, 'Should not be new');
    assert(r.data.client.visit_count >= 2, 'Visits < 2');
  });

  // ── Validation errors ──
  await test('Credit: no identifier → 400', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: ownerCookies, body: { amount: 10 },
    });
    assertStatus(r, 400, 'no-id');
  });

  await test('Credit: invalid amount → 400', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: -5 },
    });
    assertStatus(r, 400, 'bad-amount');
  });

  await test('Credit: zero → 400', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 0 },
    });
    assertStatus(r, 400, 'zero');
  });

  // ── Idempotency ──
  const idemKey = `idem_${TEST_PREFIX}_1`;
  await test('Credit with idempotency key', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: ownerCookies,
      body: { email: TEST_CLIENT_1.email, amount: 10, idempotencyKey: idemKey },
    });
    assertStatus(r, 200, 'idem-1');
  });

  await test('Duplicate idempotency → same result', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: ownerCookies,
      body: { email: TEST_CLIENT_1.email, amount: 10, idempotencyKey: idemKey },
    });
    assertStatus(r, 200, 'idem-dup');
  });

  // ── Lookup ──
  await test('Lookup by email', async () => {
    const r = await api('GET', `/api/clients/lookup?email=${encodeURIComponent(TEST_CLIENT_1.email)}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'lookup');
    assert(r.data.found === true, 'Not found');
  });

  await test('Lookup by phone', async () => {
    const r = await api('GET', `/api/clients/lookup?phone=${encodeURIComponent(TEST_CLIENT_1.phone)}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'lookup');
    assert(r.data.found === true, 'Not found');
  });

  await test('Lookup unknown → found:false', async () => {
    const r = await api('GET', '/api/clients/lookup?email=nobody@nowhere.invalid', { cookies: ownerCookies });
    assertStatus(r, 200, 'lookup');
    assert(r.data.found === false, 'Should not be found');
  });

  // ── List / Search / Enriched / Quick-search / Activity ──
  await test('List all clients', async () => {
    const r = await api('GET', '/api/clients', { cookies: ownerCookies });
    assertStatus(r, 200, 'list');
    assert(r.data.clients.length >= 2, `Got ${r.data.clients.length}`);
  });

  await test('Search clients', async () => {
    const r = await api('GET', `/api/clients/search?q=${encodeURIComponent('Client Test')}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'search');
    assert(r.data.clients.length >= 1, 'Empty');
  });

  await test('Search too short → 400', async () => {
    const r = await api('GET', '/api/clients/search?q=A', { cookies: ownerCookies });
    assertStatus(r, 400, 'short');
  });

  await test('Enriched clients', async () => {
    const r = await api('GET', '/api/clients/enriched', { cookies: ownerCookies });
    assertStatus(r, 200, 'enriched');
    assert(Array.isArray(r.data.clients), 'Not array');
  });

  await test('Quick search', async () => {
    const r = await api('GET', `/api/clients/quick-search?q=${encodeURIComponent(TEST_CLIENT_1.name.slice(0, 6))}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'quick');
  });

  await test('Recent activity', async () => {
    const r = await api('GET', '/api/clients/recent-activity', { cookies: ownerCookies });
    assertStatus(r, 200, 'activity');
    assert(Array.isArray(r.data.transactions), 'Not array');
  });

  // ── Detail ──
  if (merchantClientId1) {
    await test('Client detail', async () => {
      const r = await api('GET', `/api/clients/${merchantClientId1}`, { cookies: ownerCookies });
      assertStatus(r, 200, 'detail');
      assert(r.data.client, 'No client');
      assert(Array.isArray(r.data.transactions), 'No txs');
    });

    await test('Client 999999 → 404', async () => {
      const r = await api('GET', '/api/clients/999999', { cookies: ownerCookies });
      assertStatus(r, 404, '404');
    });
  }

  // ── Adjust ──
  if (merchantClientId1) {
    await test('Adjust +20', async () => {
      const r = await api('POST', '/api/clients/adjust', {
        cookies: ownerCookies,
        body: { merchantClientId: merchantClientId1, pointsDelta: 20, reason: 'Sanity bonus' },
      });
      assertStatus(r, 200, 'adjust-up');
    });

    await test('Adjust -5', async () => {
      const r = await api('POST', '/api/clients/adjust', {
        cookies: ownerCookies,
        body: { merchantClientId: merchantClientId1, pointsDelta: -5, reason: 'Sanity correction' },
      });
      assertStatus(r, 200, 'adjust-down');
    });
  }
}

// ═══════════════════════════════════════════════════════
// 7. CLIENT EDIT / NOTES / CUSTOM REWARD / BLOCK
// ═══════════════════════════════════════════════════════

async function suiteClientManagement() {
  console.log('\n✏️  CLIENT MANAGEMENT');

  if (!ownerCookies || !merchantClientId1) { skip('Client mgmt', 'No data'); return; }

  await test('Edit client name', async () => {
    const r = await api('PUT', `/api/clients/${merchantClientId1}/edit`, {
      cookies: ownerCookies,
      body: { name: 'Client Renamed', email: TEST_CLIENT_1.email, phone: TEST_CLIENT_1.phone },
    });
    assertStatus(r, 200, 'edit');
  });

  await test('Edit: restore original data', async () => {
    const r = await api('PUT', `/api/clients/${merchantClientId1}/edit`, {
      cookies: ownerCookies, body: { name: TEST_CLIENT_1.name, email: TEST_CLIENT_1.email, phone: TEST_CLIENT_1.phone },
    });
    assertStatus(r, 200, 'restore');
  });

  await test('Set notes', async () => {
    const r = await api('PUT', `/api/clients/${merchantClientId1}/notes`, {
      cookies: ownerCookies, body: { notes: 'VIP sanity' },
    });
    assertStatus(r, 200, 'notes');
  });

  await test('Clear notes', async () => {
    const r = await api('PUT', `/api/clients/${merchantClientId1}/notes`, {
      cookies: ownerCookies, body: { notes: '' },
    });
    assertStatus(r, 200, 'notes-clear');
  });

  await test('Set custom reward', async () => {
    const r = await api('PUT', `/api/clients/${merchantClientId1}/custom-reward`, {
      cookies: ownerCookies, body: { customReward: 'Dessert gratuit' },
    });
    assertStatus(r, 200, 'custom');
  });

  await test('Clear custom reward', async () => {
    const r = await api('PUT', `/api/clients/${merchantClientId1}/custom-reward`, {
      cookies: ownerCookies, body: { customReward: null },
    });
    assertStatus(r, 200, 'clear-custom');
  });

  await test('Block client (merchant)', async () => {
    const r = await api('POST', `/api/clients/${merchantClientId1}/block`, { cookies: ownerCookies });
    assertStatus(r, 200, 'block');
  });

  await test('Credit blocked → 403', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 10 },
    });
    assertStatus(r, 403, 'blocked');
  });

  await test('Unblock client (merchant)', async () => {
    const r = await api('POST', `/api/clients/${merchantClientId1}/unblock`, { cookies: ownerCookies });
    assertStatus(r, 200, 'unblock');
  });

  await test('Credit after unblock → 200', async () => {
    const r = await api('POST', '/api/clients/credit', {
      cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 5 },
    });
    assertStatus(r, 200, 'unblocked');
  });

  await test('Resend validation email', async () => {
    const r = await api('POST', `/api/clients/${merchantClientId1}/resend-email`, { cookies: ownerCookies });
    assert(r.status === 200 || r.status === 400, `Unexpected ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════
// 8. CLIENT MERGE (merchant level)
// ═══════════════════════════════════════════════════════

async function suiteClientMerge() {
  console.log('\n🔀 CLIENT MERGE');

  if (!ownerCookies || !merchantClientId1 || !merchantClientId2) { skip('Merge', 'No data'); return; }

  await test('Merge client 2 → client 1', async () => {
    const r = await api('POST', `/api/clients/${merchantClientId1}/merge`, {
      cookies: ownerCookies,
      body: { sourceMerchantClientId: merchantClientId2, reason: 'Sanity merge' },
    });
    assertStatus(r, 200, 'merge');
    merchantClientId2 = null;
  });

  await test('Verify merged points', async () => {
    const r = await api('GET', `/api/clients/${merchantClientId1}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'verify');
    assert(r.data.client.points_balance > 80, `Points=${r.data.client.points_balance}`);
  });
}

// ═══════════════════════════════════════════════════════
// 9. NEAR-DUPLICATES
// ═══════════════════════════════════════════════════════

async function suiteNearDuplicates() {
  console.log('\n🔍 NEAR-DUPLICATES');

  if (!ownerCookies) { skip('Dups', 'No session'); return; }

  await test('Near-duplicates endpoint', async () => {
    const r = await api('GET', '/api/clients/near-duplicates', { cookies: ownerCookies });
    assertStatus(r, 200, 'dups');
  });
}

// ═══════════════════════════════════════════════════════
// 10. PREFERENCES & SETTINGS
// ═══════════════════════════════════════════════════════

async function suitePreferences() {
  console.log('\n⚙️  PREFERENCES');

  if (!ownerCookies) { skip('Prefs', 'No session'); return; }

  await test('Get preferences', async () => {
    const r = await api('GET', '/api/preferences', { cookies: ownerCookies });
    assertStatus(r, 200, 'get');
    assert(r.data.preferences, 'No prefs');
  });

  await test('Update loyalty settings', async () => {
    const r = await api('PUT', '/api/auth/settings', {
      cookies: ownerCookies,
      body: { pointsPerEuro: 2, pointsForReward: 200, rewardDescription: 'Double points' },
    });
    assertStatus(r, 200, 'update');
  });

  await test('Revert loyalty settings', async () => {
    const r = await api('PUT', '/api/auth/settings', {
      cookies: ownerCookies,
      body: { pointsPerEuro: 1, pointsForReward: 100, rewardDescription: 'Récompense test' },
    });
    assertStatus(r, 200, 'revert');
  });

  await test('Invalid settings → 400', async () => {
    const r = await api('PUT', '/api/auth/settings', {
      cookies: ownerCookies,
      body: { pointsPerEuro: -1, pointsForReward: 0 },
    });
    assertStatus(r, 400, 'invalid');
  });
}

// ═══════════════════════════════════════════════════════
// 11. MERCHANT-SIDE FEATURES
// ═══════════════════════════════════════════════════════

async function suiteMerchantSide() {
  console.log('\n🏪 MERCHANT FEATURES');

  if (!ownerCookies) { skip('Merchant', 'No session'); return; }

  await test('Dashboard stats', async () => {
    const r = await api('GET', '/api/dashboard/stats', { cookies: ownerCookies });
    assertStatus(r, 200, 'stats');
    assert(typeof r.data.totalClients === 'number', 'No totalClients');
  });

  await test('Dashboard activity', async () => {
    const r = await api('GET', '/api/dashboard/activity', { cookies: ownerCookies });
    assertStatus(r, 200, 'activity');
  });

  await test('Merchant announcements', async () => {
    const r = await api('GET', '/api/announcements', { cookies: ownerCookies });
    assertStatus(r, 200, 'ann');
  });

  await test('Merchant messages', async () => {
    const r = await api('GET', '/api/messages', { cookies: ownerCookies });
    assertStatus(r, 200, 'msg');
  });

  await test('Export CSV (email)', async () => {
    const r = await api('POST', '/api/clients/export/csv', { cookies: ownerCookies });
    assertStatus(r, 200, 'csv');
    assert(r.data.success === true, 'Not successful');
  });

  await test('Logout', async () => {
    const r = await api('POST', '/api/auth/logout', { cookies: ownerCookies });
    assertStatus(r, 200, 'logout');
  });
}

// ═══════════════════════════════════════════════════════
// 12. ADMIN — STATS & MERCHANTS
// ═══════════════════════════════════════════════════════

async function suiteAdminStats() {
  console.log('\n📊 ADMIN STATS');

  await test('Global stats', async () => {
    const r = await api('GET', '/api/admin/merchants/stats/global', { cookies: adminCookies });
    assertStatus(r, 200, 'stats');
    assert(typeof r.data.merchants === 'object', 'No merchants');
    assert(typeof r.data.endUsers === 'number', 'No users');
  });

  await test('List merchants', async () => {
    const r = await api('GET', '/api/admin/merchants', { cookies: adminCookies });
    assertStatus(r, 200, 'list');
  });

  await test('List pending', async () => {
    const r = await api('GET', '/api/admin/merchants?status=pending', { cookies: adminCookies });
    assertStatus(r, 200, 'pending');
  });

  await test('List active', async () => {
    const r = await api('GET', '/api/admin/merchants?status=active', { cookies: adminCookies });
    assertStatus(r, 200, 'active');
  });

  if (createdMerchantId) {
    await test('Merchant detail', async () => {
      const r = await api('GET', `/api/admin/merchants/${createdMerchantId}`, { cookies: adminCookies });
      assertStatus(r, 200, 'detail');
    });
  }

  await test('Merchants without auth → 401/403', async () => {
    const r = await api('GET', '/api/admin/merchants');
    assert(r.status === 401 || r.status === 403, `Got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════
// 13. ADMIN — USERS
// ═══════════════════════════════════════════════════════

async function suiteAdminUsers() {
  console.log('\n👤 ADMIN USERS');

  await test('List users', async () => {
    const r = await api('GET', '/api/admin/users', { cookies: adminCookies });
    assertStatus(r, 200, 'list');
  });

  await test('Search test user 1', async () => {
    const r = await api('GET', `/api/admin/users?q=${encodeURIComponent(TEST_CLIENT_1.email)}`, { cookies: adminCookies });
    assertStatus(r, 200, 'search');
    assert(r.data.users.length >= 1, 'Not found');
    testEndUserId1 = r.data.users[0].id;
  });

  await test('Search test user 3', async () => {
    const r = await api('GET', `/api/admin/users?q=${encodeURIComponent(TEST_CLIENT_3.email)}`, { cookies: adminCookies });
    assertStatus(r, 200, 'search');
    if (r.data.users.length >= 1) testEndUserId3 = r.data.users[0].id;
  });

  if (!testEndUserId1) return;

  await test('User detail', async () => {
    const r = await api('GET', `/api/admin/users/${testEndUserId1}`, { cookies: adminCookies });
    assertStatus(r, 200, 'detail');
    assert(r.data.user, 'No user');
    assert(Array.isArray(r.data.cards), 'No cards');
  });

  await test('Global block', async () => {
    const r = await api('POST', `/api/admin/users/${testEndUserId1}/block`, { cookies: adminCookies });
    assertStatus(r, 200, 'block');
  });

  await test('Verify blocked', async () => {
    const r = await api('GET', `/api/admin/users/${testEndUserId1}`, { cookies: adminCookies });
    assert(r.data.user.is_blocked === 1 || r.data.user.is_blocked === true, 'Not blocked');
  });

  // Re-login owner for blocked credit test
  await test('Credit globally blocked → 403', async () => {
    const lr = await api('POST', '/api/auth/login', {
      body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword },
      raw: true,
    });
    if (lr.ok) ownerCookies = extractCookies(lr);

    const r = await api('POST', '/api/clients/credit', {
      cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 5 },
    });
    assertStatus(r, 403, 'global-blocked');
  });

  await test('Global unblock', async () => {
    const r = await api('POST', `/api/admin/users/${testEndUserId1}/unblock`, { cookies: adminCookies });
    assertStatus(r, 200, 'unblock');
  });

  // Merge with user 3
  if (testEndUserId1 && testEndUserId3) {
    await test('Admin merge preview', async () => {
      const r = await api('GET', `/api/admin/users/${testEndUserId1}/merge-preview?sourceId=${testEndUserId3}`, { cookies: adminCookies });
      assertStatus(r, 200, 'preview');
    });

    await test('Admin merge execute', async () => {
      const r = await api('POST', `/api/admin/users/${testEndUserId1}/merge`, {
        cookies: adminCookies,
        body: { sourceId: testEndUserId3, reason: 'Sanity global merge' },
      });
      assertStatus(r, 200, 'merge');
      testEndUserId3 = null;
    });
  }

  await test('Users without auth → 401/403', async () => {
    const r = await api('GET', '/api/admin/users');
    assert(r.status === 401 || r.status === 403, `Got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════
// 14. ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════

async function suiteAnnouncements() {
  console.log('\n📢 ANNOUNCEMENTS');

  await test('Create', async () => {
    const r = await api('POST', '/api/admin/announcements', {
      cookies: adminCookies,
      body: { title: `Sanity ${TEST_PREFIX}`, content: 'Test auto.', priority: 'info', targetType: 'all', merchantIds: [], expiresAt: null },
    });
    assertStatus(r, 201, 'create');
    createdAnnouncementId = r.data.id;
  });

  await test('List', async () => {
    const r = await api('GET', '/api/admin/announcements', { cookies: adminCookies });
    assertStatus(r, 200, 'list');
  });

  if (createdAnnouncementId) {
    await test('Update', async () => {
      const r = await api('PUT', `/api/admin/announcements/${createdAnnouncementId}`, {
        cookies: adminCookies,
        body: { title: `Updated ${TEST_PREFIX}`, content: 'Mis à jour.', priority: 'warning', targetType: 'all', merchantIds: [], expiresAt: null },
      });
      assertStatus(r, 200, 'update');
    });

    await test('Delete', async () => {
      const r = await api('DELETE', `/api/admin/announcements/${createdAnnouncementId}`, { cookies: adminCookies });
      assertStatus(r, 200, 'delete');
      createdAnnouncementId = null;
    });
  }
}

// ═══════════════════════════════════════════════════════
// 15. MERCHANT LIFECYCLE
// ═══════════════════════════════════════════════════════

async function suiteMerchantLifecycle() {
  console.log('\n⏸️  MERCHANT LIFECYCLE');

  if (!createdMerchantId) { skip('Lifecycle', 'No merchant'); return; }

  await test('Suspend', async () => {
    const r = await api('POST', `/api/admin/merchants/${createdMerchantId}/suspend`, {
      cookies: adminCookies, body: { reason: 'Sanity suspend' },
    });
    assertStatus(r, 200, 'suspend');
  });

  await test('Login suspended → 403', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword },
    });
    assertStatus(r, 403, 'suspended');
  });

  await test('Reactivate', async () => {
    const r = await api('POST', `/api/admin/merchants/${createdMerchantId}/reactivate`, { cookies: adminCookies });
    assertStatus(r, 200, 'reactivate');
  });

  await test('Double reactivate → 400', async () => {
    const r = await api('POST', `/api/admin/merchants/${createdMerchantId}/reactivate`, { cookies: adminCookies });
    assertStatus(r, 400, 'double');
  });

  await test('Login after reactivation', async () => {
    const r = await api('POST', '/api/auth/login', {
      body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword },
      raw: true,
    });
    assert(r.ok, `Failed: ${r.status}`);
    ownerCookies = extractCookies(r);
  });
}

// ═══════════════════════════════════════════════════════
// 16. BACKUP
// ═══════════════════════════════════════════════════════

async function suiteBackup() {
  console.log('\n💾 BACKUP');

  await test('Backup status', async () => {
    const r = await api('GET', '/api/admin/backups/status', { cookies: adminCookies });
    assert(r.status === 200 || r.status === 404, `Unexpected ${r.status}`);
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

  // Re-login owner for staff deletion
  try {
    const lr = await api('POST', '/api/auth/login', {
      body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword },
      raw: true,
    });
    if (lr.ok) ownerCookies = extractCookies(lr);
  } catch {}

  for (const [id, label] of [[createdCashierId, 'cashier'], [createdManagerId, 'manager']]) {
    if (id) {
      try { await api('DELETE', `/api/staff/${id}`, { cookies: ownerCookies }); console.log(`  🗑️  ${label} #${id}`); } catch {}
    }
  }

  if (createdMerchantId) {
    try {
      await api('POST', `/api/admin/merchants/${createdMerchantId}/reactivate`, { cookies: adminCookies }).catch(() => {});
      await api('POST', `/api/admin/merchants/${createdMerchantId}/suspend`, { cookies: adminCookies, body: { reason: 'Cleanup' } });
      console.log(`  🗑️  Merchant #${createdMerchantId} suspended`);
    } catch {}
  }

  for (const uid of [testEndUserId1, testEndUserId3]) {
    if (uid) {
      try { await api('POST', `/api/admin/users/${uid}/block`, { cookies: adminCookies }); console.log(`  🗑️  User #${uid} blocked`); } catch {}
    }
  }

  console.log(`  ℹ️  Search "${TEST_PREFIX}" in admin to review.`);
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(`  FIDDO Comprehensive Sanity Test — ${BASE}`);
  console.log(`  ${new Date().toLocaleString('fr-FR')}`);
  console.log('═══════════════════════════════════════════════');

  await suiteHealth();
  await suiteFrontendPages();

  const adminOk = await suiteAdminAuth();
  if (!adminOk) { console.log('\n⚠️  Set FIDDO_ADMIN_EMAIL / FIDDO_ADMIN_PASSWORD'); printReport(); return; }

  await suiteStaffAuth();
  await suiteStaffCRUD();
  await suiteRBAC();
  await suiteClientFlow();
  await suiteClientManagement();
  await suiteClientMerge();
  await suiteNearDuplicates();
  await suitePreferences();
  await suiteMerchantSide();
  await suiteAdminStats();
  await suiteAdminUsers();
  await suiteAnnouncements();
  await suiteMerchantLifecycle();
  await suiteBackup();

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
    results.errors.forEach(e => {
      console.log(`  ❌ ${e.name}`);
      console.log(`     ${e.error}`);
    });
  }

  console.log('═══════════════════════════════════════════════');
  if (results.failed > 0) { console.log('\n💥 Des tests ont échoué.'); process.exit(1); }
  else { console.log('\n🎉 Tous les tests passent !'); process.exit(0); }
}

main().catch(e => { console.error('\n💥 Erreur fatale:', e.message); process.exit(2); });
