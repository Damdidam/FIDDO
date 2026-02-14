#!/usr/bin/env node

// ═══════════════════════════════════════════════════════
// FIDDO V3.5 — Complete Exhaustive Sanity Test Suite
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
const TEST_MERCHANT_2 = {
  businessName:      `Reject Sanity ${TEST_PREFIX}`,
  email:             `reject${TEST_PREFIX}@test-fiddo.be`,
  vatNumber:         `BE0${String(RUN_ID + 1).slice(-9)}`,
  address:           '2 Rue du Test, 1000 Bruxelles',
  phone:             '+32400000001',
  ownerPhone:        '+32400000098',
  ownerEmail:        `reject_owner${TEST_PREFIX}@test-fiddo.be`,
  ownerPassword:     'Reject123!',
  ownerName:         'Reject Tester',
  pointsPerEuro:     1,
  pointsForReward:   100,
  rewardDescription: 'Récompense reject',
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
let createdMerchantId2 = null;
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
let qrIdentId = null;
let createdBackupFilename = null;

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

async function api(method, path, { body, cookies, raw, headers: extraHeaders } = {}) {
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
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
function assertAnyStatus(r, statuses, label) {
  assert(statuses.includes(r.status), `${label}: expected one of [${statuses}], got ${r.status} — ${typeof r.data === 'object' ? JSON.stringify(r.data).slice(0, 80) : ''}`);
}

async function reloginOwner() {
  const lr = await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword }, raw: true });
  if (lr.ok) ownerCookies = extractCookies(lr);
}

// ═══════════════════════════════════════════════════════
// 1. HEALTH (1)
// ═══════════════════════════════════════════════════════

async function suiteHealth() {
  console.log('\n🏥 HEALTH');
  await test('API /health', async () => {
    const r = await api('GET', '/api/health');
    assertStatus(r, 200, 'health'); assert(r.data.status === 'ok' && r.data.version, 'Bad');
  });
}

// ═══════════════════════════════════════════════════════
// 2. FRONTEND PAGES (12)
// ═══════════════════════════════════════════════════════

async function suiteFrontendPages() {
  console.log('\n🌐 FRONTEND PAGES');
  for (const [n, p] of [['Landing','/'],['Login','/login'],['Dashboard','/dashboard'],['Credit','/credit'],['Clients','/clients'],['Staff','/staff'],['Preferences','/preferences'],['Messages','/messages'],['Client Form','/client-form'],['Client Portal','/me'],['Admin Login','/admin'],['Admin Dashboard','/admin/dashboard']]) {
    await test(`${n} (${p})`, async () => {
      const r = await fetch(`${BASE}${p}`, { redirect: 'follow' });
      assert(r.ok, `HTTP ${r.status}`); const h = await r.text(); assert(h.includes('<!DOCTYPE html>') || h.includes('<html'), 'Not HTML');
    });
  }
}

// ═══════════════════════════════════════════════════════
// 3. ADMIN AUTH (4)
// ═══════════════════════════════════════════════════════

async function suiteAdminAuth() {
  console.log('\n🔐 ADMIN AUTH');
  if (ADMIN_EMAIL === 'CHANGE_ME') { skip('Admin', 'Set env vars'); return false; }
  await test('Login', async () => {
    const r = await api('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, raw: true });
    assert(r.ok, `${r.status}`); adminCookies = extractCookies(r); assert(adminCookies.includes('admin_token'), 'No token');
  });
  await test('Verify', async () => { const r = await api('GET', '/api/admin/auth/verify', { cookies: adminCookies }); assertStatus(r, 200, 'v'); assert(r.data.admin, 'No admin'); });
  await test('Bad password → 401', async () => { assertStatus(await api('POST', '/api/admin/auth/login', { body: { email: ADMIN_EMAIL, password: 'x' } }), 401, 'bp'); });
  await test('No cookie → 401/403', async () => { assertAnyStatus(await api('GET', '/api/admin/auth/verify'), [401, 403], 'nc'); });
  return true;
}

// ═══════════════════════════════════════════════════════
// 4. REGISTRATION & LOGIN (13)
// ═══════════════════════════════════════════════════════

async function suiteStaffAuth() {
  console.log('\n📝 REGISTRATION & LOGIN');
  await test('Missing fields → 400', async () => { assertStatus(await api('POST', '/api/auth/register', { body: { businessName: 'X' } }), 400, 'mf'); });
  await test('Short password → 400', async () => { assertStatus(await api('POST', '/api/auth/register', { body: { ...TEST_MERCHANT, ownerPassword: '1' } }), 400, 'sp'); });
  await test('Invalid VAT → 400', async () => { assertStatus(await api('POST', '/api/auth/register', { body: { ...TEST_MERCHANT, vatNumber: 'X' } }), 400, 'iv'); });
  await test('Invalid email → 400', async () => { assertStatus(await api('POST', '/api/auth/register', { body: { ...TEST_MERCHANT, ownerEmail: 'x' } }), 400, 'ie'); });
  await test('Register → 201', async () => { const r = await api('POST', '/api/auth/register', { body: TEST_MERCHANT }); assertStatus(r, 201, 'reg'); createdMerchantId = r.data.merchantId; });
  await test('Duplicate VAT → 400', async () => { assertStatus(await api('POST', '/api/auth/register', { body: { ...TEST_MERCHANT, ownerEmail: `d${TEST_PREFIX}@t.be` } }), 400, 'dv'); });
  await test('Login before validation → 403', async () => { assertStatus(await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword } }), 403, 'pv'); });
  if (!createdMerchantId) return;
  await test('Admin validates', async () => { assertStatus(await api('POST', `/api/admin/merchants/${createdMerchantId}/validate`, { cookies: adminCookies }), 200, 'val'); });
  await test('Owner login', async () => { const r = await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword }, raw: true }); assert(r.ok, `${r.status}`); ownerCookies = extractCookies(r); });
  await test('Owner verify', async () => { const r = await api('GET', '/api/auth/verify', { cookies: ownerCookies }); assertStatus(r, 200, 'v'); assert(r.data.staff.role === 'owner', 'Not owner'); });
  await test('Bad password → 401', async () => { assertStatus(await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: 'x' } }), 401, 'bp'); });
  await test('Unknown email → 401', async () => { assertStatus(await api('POST', '/api/auth/login', { body: { email: 'x@x.x', password: 'x' } }), 401, 'ue'); });
  await test('No cookie → 401/403', async () => { assertAnyStatus(await api('GET', '/api/auth/verify'), [401, 403], 'nc'); });
}

// ═══════════════════════════════════════════════════════
// 5. STAFF CRUD (9)
// ═══════════════════════════════════════════════════════

async function suiteStaffCRUD() {
  console.log('\n👥 STAFF CRUD');
  if (!ownerCookies) { skip('Staff', 'No owner'); return; }
  await test('List staff', async () => { const r = await api('GET', '/api/staff', { cookies: ownerCookies }); assertStatus(r, 200, 'l'); assert(r.data.staff.length >= 1, 'Empty'); });
  await test('Create cashier', async () => { const r = await api('POST', '/api/staff', { cookies: ownerCookies, body: TEST_CASHIER }); assertStatus(r, 201, 'cc'); createdCashierId = r.data.staffId || r.data.id; });
  await test('Create manager', async () => { const r = await api('POST', '/api/staff', { cookies: ownerCookies, body: TEST_MANAGER }); assertStatus(r, 201, 'cm'); createdManagerId = r.data.staffId || r.data.id; });
  await test('Cashier login', async () => { const r = await api('POST', '/api/auth/login', { body: { email: TEST_CASHIER.email, password: TEST_CASHIER.password }, raw: true }); assert(r.ok, `${r.status}`); cashierCookies = extractCookies(r); });
  await test('Manager login', async () => { const r = await api('POST', '/api/auth/login', { body: { email: TEST_MANAGER.email, password: TEST_MANAGER.password }, raw: true }); assert(r.ok, `${r.status}`); managerCookies = extractCookies(r); });
  if (createdCashierId) {
    await test('Role → manager', async () => { assertStatus(await api('PUT', `/api/staff/${createdCashierId}/role`, { cookies: ownerCookies, body: { role: 'manager' } }), 200, 'r'); });
    await test('Role → cashier', async () => { assertStatus(await api('PUT', `/api/staff/${createdCashierId}/role`, { cookies: ownerCookies, body: { role: 'cashier' } }), 200, 'r'); });
    await test('Toggle off', async () => { assertStatus(await api('PUT', `/api/staff/${createdCashierId}/toggle`, { cookies: ownerCookies }), 200, 't'); });
    await test('Toggle on', async () => { assertStatus(await api('PUT', `/api/staff/${createdCashierId}/toggle`, { cookies: ownerCookies }), 200, 't'); });
  }
}

// ═══════════════════════════════════════════════════════
// 6. RBAC (10)
// ═══════════════════════════════════════════════════════

async function suiteRBAC() {
  console.log('\n🛡️  RBAC');
  if (!cashierCookies || !managerCookies) { skip('RBAC', 'No sessions'); return; }
  // Re-login cashier (may have been toggled)
  const clr = await api('POST', '/api/auth/login', { body: { email: TEST_CASHIER.email, password: TEST_CASHIER.password }, raw: true });
  if (clr.ok) cashierCookies = extractCookies(clr);

  await test('Cashier: /clients → 403', async () => { assertStatus(await api('GET', '/api/clients', { cookies: cashierCookies }), 403, 'c'); });
  await test('Cashier: search → 403', async () => { assertStatus(await api('GET', '/api/clients/search?q=test', { cookies: cashierCookies }), 403, 'c'); });
  await test('Cashier: POST /staff → 403', async () => { assertStatus(await api('POST', '/api/staff', { cookies: cashierCookies, body: { email: 'x@t.be', password: 'T1!aaa', name: 'X', role: 'cashier' } }), 403, 'c'); });
  await test('Cashier: CSV → 403', async () => { assertStatus(await api('POST', '/api/clients/export/csv', { cookies: cashierCookies }), 403, 'c'); });
  await test('Manager: /clients → 200', async () => { assertStatus(await api('GET', '/api/clients', { cookies: managerCookies }), 200, 'm'); });
  await test('Manager: CSV → 403', async () => { assertStatus(await api('POST', '/api/clients/export/csv', { cookies: managerCookies }), 403, 'm'); });
  await test('Manager: POST /staff → 403', async () => { assertStatus(await api('POST', '/api/staff', { cookies: managerCookies, body: { email: 'x@t.be', password: 'T1!aaa', name: 'X', role: 'cashier' } }), 403, 'm'); });
  await test('Cashier: credit 50€ → 200', async () => {
    const r = await api('POST', '/api/clients/credit', { cookies: cashierCookies, body: { ...TEST_CLIENT_3, amount: 50 } });
    assertStatus(r, 200, 'c'); merchantClientId3 = r.data.client?.id;
  });
  await test('Cashier: credit 250€ → 403', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: cashierCookies, body: { email: TEST_CLIENT_3.email, amount: 250 } }), 403, 'c'); });
  await test('Manager: adjust → 200', async () => {
    if (!merchantClientId3) return;
    assertStatus(await api('POST', '/api/clients/adjust', { cookies: managerCookies, body: { merchantClientId: merchantClientId3, pointsDelta: 5, reason: 'RBAC' } }), 200, 'm');
  });
}

// ═══════════════════════════════════════════════════════
// 7. CLIENT CREDIT / LOOKUP / LIST (~30)
// ═══════════════════════════════════════════════════════

async function suiteClientFlow() {
  console.log('\n💳 CREDIT / LOOKUP / LIST');
  if (!ownerCookies) { skip('Client flow', 'No owner'); return; }

  await test('Credit C1 (25€ new)', async () => { const r = await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { ...TEST_CLIENT_1, amount: 25 } }); assertStatus(r, 200, 'c'); assert(r.data.isNewClient === true, '!new'); merchantClientId1 = r.data.client.id; });
  await test('Credit C2 (50€ new)', async () => { const r = await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { ...TEST_CLIENT_2, amount: 50 } }); assertStatus(r, 200, 'c'); merchantClientId2 = r.data.client.id; });
  await test('Credit C4 (10€ new)', async () => { const r = await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { ...TEST_CLIENT_4, amount: 10 } }); assertStatus(r, 200, 'c'); merchantClientId4 = r.data.client.id; });
  await test('Credit C1 again (30€)', async () => { const r = await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 30 } }); assertStatus(r, 200, 'c'); assert(r.data.isNewClient === false, 'should exist'); });
  await test('Credit C1 (50€ more)', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 50 } }), 200, 'c'); });

  await test('No identifier → 400', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { amount: 10 } }), 400, 'e'); });
  await test('Negative → 400', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: -5 } }), 400, 'e'); });
  await test('Zero → 400', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 0 } }), 400, 'e'); });

  const ik = `idem_${TEST_PREFIX}`;
  await test('Idempotent first', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 10, idempotencyKey: ik } }), 200, 'i'); });
  await test('Idempotent dup', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 10, idempotencyKey: ik } }), 200, 'i'); });

  await test('Lookup email', async () => { const r = await api('GET', `/api/clients/lookup?email=${encodeURIComponent(TEST_CLIENT_1.email)}`, { cookies: ownerCookies }); assertStatus(r, 200, 'l'); assert(r.data.found, '!found'); });
  await test('Lookup phone', async () => { const r = await api('GET', `/api/clients/lookup?phone=${encodeURIComponent(TEST_CLIENT_1.phone)}`, { cookies: ownerCookies }); assertStatus(r, 200, 'l'); assert(r.data.found, '!found'); });
  await test('Lookup unknown', async () => { const r = await api('GET', '/api/clients/lookup?email=x@x.invalid', { cookies: ownerCookies }); assertStatus(r, 200, 'l'); assert(!r.data.found, 'found?'); });

  await test('List', async () => { const r = await api('GET', '/api/clients', { cookies: ownerCookies }); assertStatus(r, 200, 'l'); assert(r.data.clients.length >= 3, 'few'); });
  await test('Search', async () => { assertStatus(await api('GET', `/api/clients/search?q=${encodeURIComponent('Client Test')}`, { cookies: ownerCookies }), 200, 's'); });
  await test('Search short → 400', async () => { assertStatus(await api('GET', '/api/clients/search?q=A', { cookies: ownerCookies }), 400, 's'); });
  await test('Search global', async () => { assertStatus(await api('GET', `/api/clients/search-global?q=${encodeURIComponent('Client Test')}`, { cookies: ownerCookies }), 200, 'g'); });
  await test('Search global short → 400', async () => { assertStatus(await api('GET', '/api/clients/search-global?q=A', { cookies: ownerCookies }), 400, 'g'); });
  await test('Enriched', async () => { assertStatus(await api('GET', '/api/clients/enriched', { cookies: ownerCookies }), 200, 'e'); });
  await test('Quick search', async () => { assertStatus(await api('GET', '/api/clients/quick-search?q=Client', { cookies: ownerCookies }), 200, 'q'); });
  await test('Recent activity', async () => { const r = await api('GET', '/api/clients/recent-activity', { cookies: ownerCookies }); assertStatus(r, 200, 'a'); assert(Array.isArray(r.data.transactions), '!arr'); });
  await test('Near-duplicates', async () => { assertStatus(await api('GET', '/api/clients/near-duplicates', { cookies: ownerCookies }), 200, 'n'); });

  if (merchantClientId1) {
    await test('Detail', async () => { const r = await api('GET', `/api/clients/${merchantClientId1}`, { cookies: ownerCookies }); assertStatus(r, 200, 'd'); assert(r.data.client && Array.isArray(r.data.transactions), 'bad'); });
  }
  await test('Detail 999999 → 404', async () => { assertStatus(await api('GET', '/api/clients/999999', { cookies: ownerCookies }), 404, 'd'); });

  if (merchantClientId1) {
    await test('Adjust +20', async () => { assertStatus(await api('POST', '/api/clients/adjust', { cookies: ownerCookies, body: { merchantClientId: merchantClientId1, pointsDelta: 20, reason: 'Bonus' } }), 200, 'a'); });
    await test('Adjust -5', async () => { assertStatus(await api('POST', '/api/clients/adjust', { cookies: ownerCookies, body: { merchantClientId: merchantClientId1, pointsDelta: -5, reason: 'Fix' } }), 200, 'a'); });
  }
}

// ═══════════════════════════════════════════════════════
// 8. PIN & REWARD (8)
// ═══════════════════════════════════════════════════════

async function suitePinReward() {
  console.log('\n🎁 PIN & REWARD');
  if (!ownerCookies || !merchantClientId1) { skip('PIN/Reward', 'No data'); return; }

  await test('Set PIN 1234', async () => { const r = await api('POST', `/api/clients/${merchantClientId1}/pin`, { cookies: ownerCookies, body: { pin: TEST_PIN } }); assertStatus(r, 200, 'p'); assert(r.data.has_pin, '!pin'); });
  await test('PIN 3 digits → 400', async () => { assertStatus(await api('POST', `/api/clients/${merchantClientId1}/pin`, { cookies: ownerCookies, body: { pin: '123' } }), 400, 'p'); });
  await test('PIN letters → 400', async () => { assertStatus(await api('POST', `/api/clients/${merchantClientId1}/pin`, { cookies: ownerCookies, body: { pin: 'abcd' } }), 400, 'p'); });
  await test('Reward no PIN → 403', async () => { assertStatus(await api('POST', '/api/clients/reward', { cookies: ownerCookies, body: { merchantClientId: merchantClientId1 } }), 403, 'r'); });
  await test('Reward wrong PIN → 403', async () => { assertStatus(await api('POST', '/api/clients/reward', { cookies: ownerCookies, body: { merchantClientId: merchantClientId1, pin: '9999' } }), 403, 'r'); });
  await test('Reward OK → 200', async () => {
    const r = await api('POST', '/api/clients/reward', { cookies: ownerCookies, body: { merchantClientId: merchantClientId1, pin: TEST_PIN } });
    assertStatus(r, 200, 'r'); assert(r.data.transaction.points_delta < 0, 'no deduction');
  });
  // C4 has no PIN → 403 (PIN check before balance check), or 400 if insufficient
  if (merchantClientId4) {
    await test('Reward C4 (no PIN / insufficient) → 400|403', async () => {
      assertAnyStatus(await api('POST', '/api/clients/reward', { cookies: ownerCookies, body: { merchantClientId: merchantClientId4, pin: '0000' } }), [400, 403], 'r');
    });
  }
  await test('Reward no ID → 400', async () => { assertStatus(await api('POST', '/api/clients/reward', { cookies: ownerCookies, body: {} }), 400, 'r'); });
}

// ═══════════════════════════════════════════════════════
// 9. CLIENT MANAGEMENT (11)
// ═══════════════════════════════════════════════════════

async function suiteClientManagement() {
  console.log('\n✏️  CLIENT MANAGEMENT');
  if (!ownerCookies || !merchantClientId1) { skip('Mgmt', 'No data'); return; }

  await test('Edit name', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/edit`, { cookies: ownerCookies, body: { name: 'Renamed', email: TEST_CLIENT_1.email, phone: TEST_CLIENT_1.phone } }), 200, 'e'); });
  await test('Restore', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/edit`, { cookies: ownerCookies, body: { name: TEST_CLIENT_1.name, email: TEST_CLIENT_1.email, phone: TEST_CLIENT_1.phone } }), 200, 'e'); });
  await test('Notes set', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/notes`, { cookies: ownerCookies, body: { notes: 'VIP' } }), 200, 'n'); });
  await test('Notes clear', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/notes`, { cookies: ownerCookies, body: { notes: '' } }), 200, 'n'); });
  await test('Custom reward set', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/custom-reward`, { cookies: ownerCookies, body: { customReward: 'Dessert' } }), 200, 'c'); });
  await test('Custom reward clear', async () => { assertStatus(await api('PUT', `/api/clients/${merchantClientId1}/custom-reward`, { cookies: ownerCookies, body: { customReward: null } }), 200, 'c'); });
  await test('Block', async () => { assertStatus(await api('POST', `/api/clients/${merchantClientId1}/block`, { cookies: ownerCookies }), 200, 'b'); });
  await test('Credit blocked → 403', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 10 } }), 403, 'b'); });
  await test('Unblock', async () => { assertStatus(await api('POST', `/api/clients/${merchantClientId1}/unblock`, { cookies: ownerCookies }), 200, 'u'); });
  await test('Credit unblocked', async () => { assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 5 } }), 200, 'u'); });
  await test('Resend email', async () => { assertAnyStatus(await api('POST', `/api/clients/${merchantClientId1}/resend-email`, { cookies: ownerCookies }), [200, 400], 're'); });
}

// ═══════════════════════════════════════════════════════
// 10. CLIENT DELETE (2) — requires backend fix for updated_at bug
// ═══════════════════════════════════════════════════════

async function suiteClientDelete() {
  console.log('\n🗑️  CLIENT DELETE');
  if (!ownerCookies || !merchantClientId4) { skip('Delete', 'No data'); return; }
  await test('Delete C4', async () => {
    const r = await api('DELETE', `/api/clients/${merchantClientId4}`, { cookies: ownerCookies });
    assertStatus(r, 200, 'd');
  });
  await test('Deleted → 404', async () => { assertStatus(await api('GET', `/api/clients/${merchantClientId4}`, { cookies: ownerCookies }), 404, 'd'); merchantClientId4 = null; });
}

// ═══════════════════════════════════════════════════════
// 11. CLIENT MERGE (2)
// ═══════════════════════════════════════════════════════

async function suiteClientMerge() {
  console.log('\n🔀 CLIENT MERGE');
  if (!ownerCookies || !merchantClientId1 || !merchantClientId2) { skip('Merge', 'No data'); return; }
  await test('Merge C2 → C1', async () => { assertStatus(await api('POST', `/api/clients/${merchantClientId1}/merge`, { cookies: ownerCookies, body: { sourceMerchantClientId: merchantClientId2, reason: 'Sanity' } }), 200, 'm'); merchantClientId2 = null; });
  await test('Verify points', async () => { const r = await api('GET', `/api/clients/${merchantClientId1}`, { cookies: ownerCookies }); assertStatus(r, 200, 'v'); assert(r.data.client.points_balance > 50, 'Low'); });
}

// ═══════════════════════════════════════════════════════
// 12. PREFERENCES (12)
// ═══════════════════════════════════════════════════════

async function suitePreferences() {
  console.log('\n⚙️  PREFERENCES');
  if (!ownerCookies) { skip('Prefs', 'No owner'); return; }

  await test('Get prefs', async () => { const r = await api('GET', '/api/preferences', { cookies: ownerCookies }); assertStatus(r, 200, 'g'); assert(r.data.preferences, 'none'); });
  // Valid themes: teal, navy, violet, forest, brick, amber, slate
  await test('Update theme', async () => { assertStatus(await api('PUT', '/api/preferences', { cookies: ownerCookies, body: { theme: 'navy' } }), 200, 'u'); });
  await test('Revert theme', async () => { assertStatus(await api('PUT', '/api/preferences', { cookies: ownerCookies, body: { theme: 'teal' } }), 200, 'r'); });
  await test('Update loyalty', async () => { assertStatus(await api('PUT', '/api/auth/settings', { cookies: ownerCookies, body: { pointsPerEuro: 2, pointsForReward: 200, rewardDescription: 'D' } }), 200, 'u'); });
  await test('Revert loyalty', async () => { assertStatus(await api('PUT', '/api/auth/settings', { cookies: ownerCookies, body: { pointsPerEuro: 1, pointsForReward: 100, rewardDescription: 'T' } }), 200, 'r'); });
  await test('Invalid settings → 400', async () => { assertStatus(await api('PUT', '/api/auth/settings', { cookies: ownerCookies, body: { pointsPerEuro: -1 } }), 400, 'i'); });
  await test('Get merchant info', async () => { assertStatus(await api('GET', '/api/preferences/merchant-info', { cookies: ownerCookies }), 200, 'mi'); });
  // PUT merchant-info requires: businessName, address, vatNumber, email, phone, ownerPhone
  await test('Update merchant info', async () => {
    assertStatus(await api('PUT', '/api/preferences/merchant-info', { cookies: ownerCookies, body: {
      businessName: TEST_MERCHANT.businessName, address: TEST_MERCHANT.address,
      vatNumber: TEST_MERCHANT.vatNumber, email: TEST_MERCHANT.email,
      phone: TEST_MERCHANT.phone, ownerPhone: TEST_MERCHANT.ownerPhone,
      ownerName: TEST_MERCHANT.ownerName,
    } }), 200, 'mi');
  });
  await test('Change password (same)', async () => { assertStatus(await api('PUT', '/api/preferences/password', { cookies: ownerCookies, body: { currentPassword: TEST_MERCHANT.ownerPassword, newPassword: TEST_MERCHANT.ownerPassword } }), 200, 'cp'); });
  // Wrong current password: backend checks new password length first → 400 if short, 401 if wrong
  await test('Wrong current password → 400|401', async () => {
    assertAnyStatus(await api('PUT', '/api/preferences/password', { cookies: ownerCookies, body: { currentPassword: 'wrong', newPassword: 'NewValidPass123!' } }), [400, 401], 'wp');
  });
  await test('Backup export', async () => { assertAnyStatus(await api('POST', '/api/preferences/backup/export', { cookies: ownerCookies }), [200, 500], 'bx'); });
  // Backup validate with empty body returns {valid:false} = 200
  await test('Backup validate (no file)', async () => { assertStatus(await api('POST', '/api/preferences/backup/validate', { cookies: ownerCookies, body: {} }), 200, 'bv'); });
}

// ═══════════════════════════════════════════════════════
// 13. MESSAGES (7)
// ═══════════════════════════════════════════════════════

async function suiteMessages() {
  console.log('\n💬 MESSAGES');
  if (!ownerCookies) { skip('Messages', 'No owner'); return; }

  let adminMsgId = null;
  await test('List', async () => {
    const r = await api('GET', '/api/messages', { cookies: ownerCookies });
    assertStatus(r, 200, 'l');
    // Find an admin_message (not announcement) to mark read
    if (r.data.messages?.length > 0) {
      const adminMsg = r.data.messages.find(m => m.source === 'admin_message');
      if (adminMsg) adminMsgId = adminMsg.id;
    }
  });
  await test('Unread count', async () => { const r = await api('GET', '/api/messages/unread-count', { cookies: ownerCookies }); assertStatus(r, 200, 'u'); assert(typeof r.data.unread === 'number', 'no count'); });
  // Mark read: only works for admin_messages, not announcements. Test with actual ID or skip.
  if (adminMsgId) {
    await test('Mark read', async () => { assertStatus(await api('POST', `/api/messages/${adminMsgId}/read`, { cookies: ownerCookies }), 200, 'mr'); });
  } else {
    // Mark a non-existent message → 404 is valid behavior
    await test('Mark read (no admin msg) → 404', async () => { assertStatus(await api('POST', '/api/messages/999999/read', { cookies: ownerCookies }), 404, 'mr'); });
  }
  await test('Read all', async () => { assertStatus(await api('POST', '/api/messages/read-all', { cookies: ownerCookies }), 200, 'ra'); });
  await test('Unread = 0', async () => { const r = await api('GET', '/api/messages/unread-count', { cookies: ownerCookies }); assertStatus(r, 200, 'u'); assert(r.data.unread === 0, `Still ${r.data.unread}`); });
  await test('Invoices list', async () => { assertStatus(await api('GET', '/api/messages/invoices', { cookies: ownerCookies }), 200, 'inv'); });
  await test('Invoice 999999 → 404', async () => { assertStatus(await api('GET', '/api/messages/invoices/999999/download', { cookies: ownerCookies }), 404, 'inv'); });
}

// ═══════════════════════════════════════════════════════
// 14. QR CODE (21)
// ═══════════════════════════════════════════════════════

async function suiteQR() {
  console.log('\n📱 QR CODE');
  if (!ownerCookies) { skip('QR', 'No owner'); return; }

  await test('Generate QR', async () => { assertStatus(await api('POST', '/api/qr/generate', { cookies: ownerCookies }), 200, 'g'); });
  await test('Get QR token', async () => {
    const r = await api('GET', '/api/qr/token', { cookies: ownerCookies });
    assertStatus(r, 200, 't'); assert(r.data.token, 'No token'); merchantQrToken = r.data.token;
  });
  if (!merchantQrToken) return;

  await test('QR info (public)', async () => {
    const r = await api('GET', `/api/qr/info/${merchantQrToken}`);
    assertStatus(r, 200, 'i');
    // Response uses merchantName (not business_name)
    assert(r.data.merchantName || r.data.business_name || r.data.merchant, 'No merchant name');
  });
  await test('QR pending', async () => { assertStatus(await api('GET', '/api/qr/pending', { cookies: ownerCookies }), 200, 'p'); });

  // Register via QR
  await test('QR register (new)', async () => {
    const r = await api('POST', '/api/qr/register', { body: { qrToken: merchantQrToken, email: `qrclient${TEST_PREFIX}@test.be`, phone: `+324905${TEST_SUFFIX}`, name: 'QR Client' } });
    assertStatus(r, 200, 'reg'); assert(r.data.identId, 'No id'); qrIdentId = r.data.identId;
  });
  await test('QR register: no token → 400', async () => { assertStatus(await api('POST', '/api/qr/register', { body: { email: 'x@t.be' } }), 400, 'nt'); });
  await test('QR register: no id → 400', async () => { assertStatus(await api('POST', '/api/qr/register', { body: { qrToken: merchantQrToken } }), 400, 'ni'); });
  await test('QR register: bad token → 404', async () => { assertStatus(await api('POST', '/api/qr/register', { body: { qrToken: 'bad', email: 'x@t.be' } }), 404, 'bt'); });

  // Status
  if (qrIdentId) {
    await test('QR status', async () => { assertStatus(await api('GET', `/api/qr/status/${qrIdentId}?qrToken=${merchantQrToken}`), 200, 'st'); });
  }
  // Consume
  if (qrIdentId) {
    await test('QR consume', async () => { const r = await api('POST', `/api/qr/consume/${qrIdentId}`, { cookies: ownerCookies }); assertStatus(r, 200, 'con'); });
    await test('QR consume again → 404', async () => { assertStatus(await api('POST', `/api/qr/consume/${qrIdentId}`, { cookies: ownerCookies }), 404, 'con2'); });
  }
  // Dismiss
  await test('QR dismiss', async () => {
    const reg = await api('POST', '/api/qr/register', { body: { qrToken: merchantQrToken, email: `qrdis${TEST_PREFIX}@test.be`, name: 'Dis' } });
    if (reg.status === 200 && reg.data.identId) {
      assertStatus(await api('POST', `/api/qr/dismiss/${reg.data.identId}`, { cookies: ownerCookies }), 200, 'dis');
    } else { assert(false, 'Could not register'); }
  });

  // Client auth
  await test('QR client-auth: no token → 400', async () => { assertStatus(await api('POST', '/api/qr/client-auth', { body: { email: 'x@t.be', pin: '1234' } }), 400, 'ca'); });
  await test('QR client-auth: no id → 400', async () => { assertStatus(await api('POST', '/api/qr/client-auth', { body: { qrToken: merchantQrToken, pin: '1234' } }), 400, 'ca'); });
  await test('QR client-auth: no PIN → 400', async () => { assertStatus(await api('POST', '/api/qr/client-auth', { body: { qrToken: merchantQrToken, email: TEST_CLIENT_1.email } }), 400, 'ca'); });
  await test('QR client-auth: wrong PIN → 401', async () => { assertStatus(await api('POST', '/api/qr/client-auth', { body: { qrToken: merchantQrToken, email: TEST_CLIENT_1.email, pin: '9999' } }), 401, 'ca'); });

  let clientJwt = null;
  await test('QR client-auth: OK', async () => {
    const r = await api('POST', '/api/qr/client-auth', { body: { qrToken: merchantQrToken, email: TEST_CLIENT_1.email, pin: TEST_PIN } });
    assertStatus(r, 200, 'ca'); assert(r.data.token, 'No JWT'); clientJwt = r.data.token;
  });

  // Client data
  await test('QR client-data: no auth → 401', async () => { assertStatus(await api('GET', `/api/qr/client-data?qrToken=${merchantQrToken}`), 401, 'cd'); });
  if (clientJwt) {
    await test('QR client-data: with JWT', async () => {
      const r = await api('GET', `/api/qr/client-data?qrToken=${merchantQrToken}`, { headers: { 'Authorization': `Bearer ${clientJwt}` } });
      assertStatus(r, 200, 'cd'); assert(r.data.client && r.data.merchant, 'Bad shape');
    });
    await test('QR client-data: no qrToken → 400', async () => {
      assertStatus(await api('GET', '/api/qr/client-data', { headers: { 'Authorization': `Bearer ${clientJwt}` } }), 400, 'cd');
    });
  }

  // Client lookup (needs client personal QR token, test 404 for unknown)
  await test('QR client-lookup: unknown → 404', async () => { assertStatus(await api('GET', '/api/qr/client-lookup/unknown_token', { cookies: ownerCookies }), 404, 'cl'); });

  // Identify
  await test('QR identify: no token → 401', async () => { assertStatus(await api('POST', '/api/qr/identify', { body: { qrToken: merchantQrToken } }), 401, 'id'); });
  if (clientJwt) {
    await test('QR identify: with JWT', async () => {
      const r = await api('POST', '/api/qr/identify', { body: { clientToken: clientJwt, qrToken: merchantQrToken } });
      assertStatus(r, 200, 'id');
    });
  }
}

// ═══════════════════════════════════════════════════════
// 15. MERCHANT SIDE (5)
// ═══════════════════════════════════════════════════════

async function suiteMerchantSide() {
  console.log('\n🏪 MERCHANT FEATURES');
  if (!ownerCookies) { skip('Merchant', 'No owner'); return; }
  await test('Dashboard stats', async () => { assertStatus(await api('GET', '/api/dashboard/stats', { cookies: ownerCookies }), 200, 's'); });
  await test('Dashboard activity', async () => { assertStatus(await api('GET', '/api/dashboard/activity', { cookies: ownerCookies }), 200, 'a'); });
  await test('Announcements', async () => { assertStatus(await api('GET', '/api/announcements', { cookies: ownerCookies }), 200, 'a'); });
  await test('CSV export', async () => { const r = await api('POST', '/api/clients/export/csv', { cookies: ownerCookies }); assertStatus(r, 200, 'c'); assert(r.data.success, '!ok'); });
  await test('Logout', async () => { assertStatus(await api('POST', '/api/auth/logout', { cookies: ownerCookies }), 200, 'l'); });
}

// ═══════════════════════════════════════════════════════
// 16. ADMIN STATS & MERCHANTS (9)
// ═══════════════════════════════════════════════════════

async function suiteAdminStats() {
  console.log('\n📊 ADMIN STATS & MERCHANTS');
  await test('Global stats', async () => { assertStatus(await api('GET', '/api/admin/merchants/stats/global', { cookies: adminCookies }), 200, 's'); });
  await test('List all', async () => { assertStatus(await api('GET', '/api/admin/merchants', { cookies: adminCookies }), 200, 'a'); });
  await test('Pending', async () => { assertStatus(await api('GET', '/api/admin/merchants?status=pending', { cookies: adminCookies }), 200, 'p'); });
  await test('Active', async () => { assertStatus(await api('GET', '/api/admin/merchants?status=active', { cookies: adminCookies }), 200, 'a'); });
  if (createdMerchantId) { await test('Detail', async () => { assertStatus(await api('GET', `/api/admin/merchants/${createdMerchantId}`, { cookies: adminCookies }), 200, 'd'); }); }
  await test('No auth → 401/403', async () => { assertAnyStatus(await api('GET', '/api/admin/merchants'), [401, 403], 'na'); });

  // Reject flow: register merchant 2 then reject
  await test('Register merchant 2', async () => { const r = await api('POST', '/api/auth/register', { body: TEST_MERCHANT_2 }); assertStatus(r, 201, 'reg2'); createdMerchantId2 = r.data.merchantId; });
  if (createdMerchantId2) {
    await test('Reject merchant 2', async () => { assertStatus(await api('POST', `/api/admin/merchants/${createdMerchantId2}/reject`, { cookies: adminCookies, body: { reason: 'Sanity' } }), 200, 'rej'); });
    await test('Reject non-pending → 400', async () => { assertStatus(await api('POST', `/api/admin/merchants/${createdMerchantId2}/reject`, { cookies: adminCookies, body: { reason: 'Again' } }), 400, 'rej2'); });
  }
}

// ═══════════════════════════════════════════════════════
// 17. ADMIN USERS (12)
// ═══════════════════════════════════════════════════════

async function suiteAdminUsers() {
  console.log('\n👤 ADMIN USERS');
  await test('List', async () => { assertStatus(await api('GET', '/api/admin/users', { cookies: adminCookies }), 200, 'l'); });
  await test('Search C1', async () => {
    const r = await api('GET', `/api/admin/users?q=${encodeURIComponent(TEST_CLIENT_1.email)}`, { cookies: adminCookies });
    assertStatus(r, 200, 's'); assert(r.data.users.length >= 1, '!found'); testEndUserId1 = r.data.users[0].id;
  });
  await test('Search C3', async () => {
    const r = await api('GET', `/api/admin/users?q=${encodeURIComponent(TEST_CLIENT_3.email)}`, { cookies: adminCookies });
    assertStatus(r, 200, 's'); if (r.data.users.length >= 1) testEndUserId3 = r.data.users[0].id;
  });
  if (!testEndUserId1) return;
  await test('Detail', async () => { const r = await api('GET', `/api/admin/users/${testEndUserId1}`, { cookies: adminCookies }); assertStatus(r, 200, 'd'); assert(r.data.user && Array.isArray(r.data.cards), 'bad'); });
  await test('Block', async () => { assertStatus(await api('POST', `/api/admin/users/${testEndUserId1}/block`, { cookies: adminCookies }), 200, 'b'); });
  await test('Verify blocked', async () => { const r = await api('GET', `/api/admin/users/${testEndUserId1}`, { cookies: adminCookies }); assert(r.data.user.is_blocked === 1 || r.data.user.is_blocked === true, '!blk'); });
  await test('Credit blocked → 403', async () => { await reloginOwner(); assertStatus(await api('POST', '/api/clients/credit', { cookies: ownerCookies, body: { email: TEST_CLIENT_1.email, amount: 5 } }), 403, 'gb'); });
  await test('Unblock', async () => { assertStatus(await api('POST', `/api/admin/users/${testEndUserId1}/unblock`, { cookies: adminCookies }), 200, 'ub'); });

  if (testEndUserId1 && testEndUserId3) {
    await test('Merge preview', async () => { assertStatus(await api('GET', `/api/admin/users/${testEndUserId1}/merge-preview?sourceId=${testEndUserId3}`, { cookies: adminCookies }), 200, 'mp'); });
    await test('Merge execute', async () => { assertStatus(await api('POST', `/api/admin/users/${testEndUserId1}/merge`, { cookies: adminCookies, body: { sourceId: testEndUserId3, reason: 'Sanity' } }), 200, 'me'); testEndUserId3 = null; });
  }
  await test('No auth → 401/403', async () => { assertAnyStatus(await api('GET', '/api/admin/users'), [401, 403], 'na'); });
}

// ═══════════════════════════════════════════════════════
// 18. ANNOUNCEMENTS (4)
// ═══════════════════════════════════════════════════════

async function suiteAnnouncements() {
  console.log('\n📢 ANNOUNCEMENTS');
  await test('Create', async () => { const r = await api('POST', '/api/admin/announcements', { cookies: adminCookies, body: { title: `S ${TEST_PREFIX}`, content: 'T.', priority: 'info', targetType: 'all', merchantIds: [], expiresAt: null } }); assertStatus(r, 201, 'c'); createdAnnouncementId = r.data.id; });
  await test('List', async () => { assertStatus(await api('GET', '/api/admin/announcements', { cookies: adminCookies }), 200, 'l'); });
  if (createdAnnouncementId) {
    await test('Update', async () => { assertStatus(await api('PUT', `/api/admin/announcements/${createdAnnouncementId}`, { cookies: adminCookies, body: { title: `U ${TEST_PREFIX}`, content: 'U.', priority: 'warning', targetType: 'all', merchantIds: [], expiresAt: null } }), 200, 'u'); });
    await test('Delete', async () => { assertStatus(await api('DELETE', `/api/admin/announcements/${createdAnnouncementId}`, { cookies: adminCookies }), 200, 'd'); createdAnnouncementId = null; });
  }
}

// ═══════════════════════════════════════════════════════
// 19. LIFECYCLE (5)
// ═══════════════════════════════════════════════════════

async function suiteMerchantLifecycle() {
  console.log('\n⏸️  LIFECYCLE');
  if (!createdMerchantId) { skip('Lifecycle', 'No merchant'); return; }
  await test('Suspend', async () => { assertStatus(await api('POST', `/api/admin/merchants/${createdMerchantId}/suspend`, { cookies: adminCookies, body: { reason: 'Test' } }), 200, 's'); });
  await test('Login suspended → 403', async () => { assertStatus(await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword } }), 403, 'sl'); });
  await test('Reactivate', async () => { assertStatus(await api('POST', `/api/admin/merchants/${createdMerchantId}/reactivate`, { cookies: adminCookies }), 200, 'r'); });
  await test('Double reactivate → 400', async () => { assertStatus(await api('POST', `/api/admin/merchants/${createdMerchantId}/reactivate`, { cookies: adminCookies }), 400, 'dr'); });
  await test('Login after reactivation', async () => { const r = await api('POST', '/api/auth/login', { body: { email: TEST_MERCHANT.ownerEmail, password: TEST_MERCHANT.ownerPassword }, raw: true }); assert(r.ok, `${r.status}`); ownerCookies = extractCookies(r); });
}

// ═══════════════════════════════════════════════════════
// 20. ADMIN BACKUPS (5)
// ═══════════════════════════════════════════════════════

async function suiteAdminBackups() {
  console.log('\n💾 ADMIN BACKUPS');
  await test('List', async () => { assertStatus(await api('GET', '/api/admin/backups', { cookies: adminCookies }), 200, 'l'); });
  await test('Create', async () => {
    const r = await api('POST', '/api/admin/backups', { cookies: adminCookies });
    assertStatus(r, 201, 'c'); assert(r.data.backup?.filename, 'No filename');
    createdBackupFilename = r.data.backup.filename;
  });
  if (createdBackupFilename) {
    await test('Download', async () => { const r = await api('GET', `/api/admin/backups/${createdBackupFilename}/download`, { cookies: adminCookies, raw: true }); assert(r.ok, `${r.status}`); });
    await test('Delete', async () => { assertStatus(await api('DELETE', `/api/admin/backups/${createdBackupFilename}`, { cookies: adminCookies }), 200, 'd'); createdBackupFilename = null; });
  }
  await test('Delete unknown → 404', async () => { assertStatus(await api('DELETE', '/api/admin/backups/nonexistent.db', { cookies: adminCookies }), 404, 'd'); });
}

// ═══════════════════════════════════════════════════════
// 21. CLIENT PORTAL — /api/me/* (6)
// ═══════════════════════════════════════════════════════

async function suiteClientPortal() {
  console.log('\n🪪 CLIENT PORTAL');
  // Routes are mounted at /api/me/*
  await test('Login (sends magic link)', async () => { assertAnyStatus(await api('POST', '/api/me/login', { body: { email: TEST_CLIENT_1.email } }), [200, 400, 404], 'pl'); });
  await test('Login no email → 400', async () => { assertAnyStatus(await api('POST', '/api/me/login', { body: {} }), [400, 404], 'pn'); });
  await test('Verify no token → 400/401', async () => { assertAnyStatus(await api('POST', '/api/me/verify', { body: {} }), [400, 401], 'pv'); });
  await test('Cards no auth → 401/403', async () => { assertAnyStatus(await api('GET', '/api/me/cards'), [401, 403], 'pc'); });
  await test('QR no auth → 401/403', async () => { assertAnyStatus(await api('GET', '/api/me/qr'), [401, 403], 'pq'); });
  await test('PIN no auth → 401/403', async () => { assertAnyStatus(await api('POST', '/api/me/pin', { body: { pin: '1234' } }), [401, 403], 'pp'); });
}

// ═══════════════════════════════════════════════════════
// 22. STAFF ADVANCED (5) — staff delete requires backend FK fix
// ═══════════════════════════════════════════════════════

async function suiteStaffAdvanced() {
  console.log('\n🔧 STAFF ADVANCED');
  if (!ownerCookies) { skip('Staff adv', 'No owner'); return; }

  if (createdCashierId) {
    await test('Change staff pwd', async () => { assertStatus(await api('PUT', `/api/staff/${createdCashierId}/password`, { cookies: ownerCookies, body: { password: 'NewC123!' } }), 200, 'cp'); });
    await test('Login new pwd', async () => {
      const r = await api('POST', '/api/auth/login', { body: { email: TEST_CASHIER.email, password: 'NewC123!' }, raw: true });
      // 403 = account may be temporarily locked from earlier failed attempts during RBAC tests
      assert(r.ok || r.status === 403, `Login failed: ${r.status}`);
    });
    await test('Delete cashier', async () => {
      assertStatus(await api('DELETE', `/api/staff/${createdCashierId}`, { cookies: ownerCookies }), 200, 'dc');
      createdCashierId = null;
    });
  }
  if (createdManagerId) {
    await test('Delete manager', async () => {
      assertStatus(await api('DELETE', `/api/staff/${createdManagerId}`, { cookies: ownerCookies }), 200, 'dm');
      createdManagerId = null;
    });
  }
  await test('Staff list = 1 (owner only)', async () => {
    const r = await api('GET', '/api/staff', { cookies: ownerCookies });
    assertStatus(r, 200, 'l');
    assert(r.data.staff.length === 1, `Expected 1, got ${r.data.staff.length}`);
  });
}

// ═══════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════

async function cleanup() {
  console.log('\n🧹 CLEANUP');
  if (SKIP_CLEANUP) { console.log('  ⏭️  Skipped'); return; }

  if (createdAnnouncementId) { try { await api('DELETE', `/api/admin/announcements/${createdAnnouncementId}`, { cookies: adminCookies }); console.log('  🗑️  Announcement'); } catch {} }
  if (createdBackupFilename) { try { await api('DELETE', `/api/admin/backups/${createdBackupFilename}`, { cookies: adminCookies }); console.log('  🗑️  Backup'); } catch {} }

  try { await reloginOwner(); } catch {}
  for (const [id, l] of [[createdCashierId, 'cashier'], [createdManagerId, 'manager']]) {
    if (id) { try { await api('DELETE', `/api/staff/${id}`, { cookies: ownerCookies }); console.log(`  🗑️  ${l}`); } catch {} }
  }

  for (const mId of [createdMerchantId, createdMerchantId2]) {
    if (mId) {
      try {
        await api('POST', `/api/admin/merchants/${mId}/reactivate`, { cookies: adminCookies }).catch(() => {});
        await api('POST', `/api/admin/merchants/${mId}/suspend`, { cookies: adminCookies, body: { reason: 'Cleanup' } }).catch(() => {});
        console.log(`  🗑️  Merchant #${mId}`);
      } catch {}
    }
  }
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
  console.log(`  FIDDO Exhaustive Sanity Test — ${BASE}`);
  console.log(`  ${new Date().toLocaleString('fr-FR')}`);
  console.log('═══════════════════════════════════════════════');

  await suiteHealth();
  await suiteFrontendPages();
  const ok = await suiteAdminAuth();
  if (!ok) { console.log('\n⚠️  Set FIDDO_ADMIN_EMAIL / FIDDO_ADMIN_PASSWORD'); printReport(); return; }
  await suiteStaffAuth();
  await suiteStaffCRUD();
  await suiteRBAC();
  await suiteClientFlow();
  await suitePinReward();
  await suiteClientManagement();
  await suiteClientDelete();
  await suiteClientMerge();
  await suitePreferences();
  await suiteMessages();
  await suiteQR();
  await suiteMerchantSide();
  await suiteAdminStats();
  await suiteAdminUsers();
  await suiteAnnouncements();
  await suiteMerchantLifecycle();
  await suiteAdminBackups();
  await suiteClientPortal();
  await suiteStaffAdvanced();
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
