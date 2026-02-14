/* ═══════════════════════════════════════════════════════
   FIDDO API Client — V4 (single-token, matches backend)
   ═══════════════════════════════════════════════════════ */

const API = (() => {
  const BASE = window.FIDDO_API || 'https://www.fiddo.be';
  const KEY = 'fiddo_token';

  function getToken() { return localStorage.getItem(KEY); }
  function setToken(t) { localStorage.setItem(KEY, t); }
  function clearToken() { localStorage.removeItem(KEY); }

  async function call(endpoint, opts = {}) {
    const { method = 'GET', body, noAuth = false } = opts;
    const headers = { 'Content-Type': 'application/json' };

    if (!noAuth) {
      const token = getToken();
      if (token) headers['Authorization'] = 'Bearer ' + token;
    }

    const cfg = { method, headers };
    if (body && method !== 'GET') cfg.body = JSON.stringify(body);

    const res = await fetch(`${BASE}${endpoint}`, cfg);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  return {
    // Auth
    login: (email) => call('/api/me/login', { method: 'POST', body: { email }, noAuth: true }),
    verify: (token) => call('/api/me/verify', { method: 'POST', body: { token }, noAuth: true }),
    logout: () => { clearToken(); },

    // Session
    hasSession: () => !!getToken(),
    setToken,
    clearToken,

    // Cards
    getCards: () => call('/api/me/cards'),
    getCard: (id) => call(`/api/me/cards/${id}`),
    getHistory: (id, limit = 50, offset = 0) => call(`/api/me/cards/${id}/transactions?limit=${limit}&offset=${offset}`),

    // Profile
    updateProfile: (body) => call('/api/me/profile', { method: 'PUT', body }),
    updateEmail: (newEmail) => call('/api/me/email', { method: 'PUT', body: { newEmail } }),
    getQR: () => call('/api/me/qr'),

    // Notifications
    getNotifPrefs: () => call('/api/me/notifications/preferences'),
    setNotifPrefs: (body) => call('/api/me/notifications/preferences', { method: 'PUT', body }),

    // Gift
    createGift: (merchantId) => call(`/api/me/cards/${merchantId}/gift`, { method: 'POST' }),
    getGift: (token) => call(`/api/me/gift/${token}`, { noAuth: true }),
    claimGift: (token) => call(`/api/me/gift/${token}/claim`, { method: 'POST' }),
  };
})();
