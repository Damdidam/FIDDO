/* ═══════════════════════════════════════════════════════
   FIDDO API Client (Complete Bundle)
   ═══════════════════════════════════════════════════════ */

const API = (() => {
  const BASE = window.FIDDO_API || 'https://www.fiddo.be';
  const KEYS = { access: 'fiddo_at', refresh: 'fiddo_rt' };

  function getAT() { return localStorage.getItem(KEYS.access); }
  function getRT() { return localStorage.getItem(KEYS.refresh); }
  function setTokens(at, rt) { localStorage.setItem(KEYS.access, at); localStorage.setItem(KEYS.refresh, rt); }
  function clearTokens() { localStorage.removeItem(KEYS.access); localStorage.removeItem(KEYS.refresh); }

  let refreshing = null;
  async function refreshToken() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const rt = getRT();
        if (!rt) return null;
        const r = await fetch(`${BASE}/api/me/refresh`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt })
        });
        if (!r.ok) { clearTokens(); return null; }
        const d = await r.json();
        localStorage.setItem(KEYS.access, d.accessToken);
        return d.accessToken;
      } catch { return null; }
      finally { refreshing = null; }
    })();
    return refreshing;
  }

  async function call(endpoint, opts = {}) {
    const { method = 'GET', body, noAuth = false } = opts;
    const headers = { 'Content-Type': 'application/json' };

    if (!noAuth) {
      let token = getAT();
      if (!token) token = await refreshToken();
      if (token) headers['Authorization'] = 'Bearer ' + token;
    }

    const cfg = { method, headers };
    if (body && method !== 'GET') cfg.body = JSON.stringify(body);

    let res = await fetch(`${BASE}${endpoint}`, cfg);

    if (res.status === 401 && !noAuth) {
      const newToken = await refreshToken();
      if (newToken) {
        headers['Authorization'] = 'Bearer ' + newToken;
        res = await fetch(`${BASE}${endpoint}`, { ...cfg, headers });
      }
    }

    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  return {
    // Auth
    login: (email) => call('/api/me/login', { method: 'POST', body: { email }, noAuth: true }),
    verify: (token) => call('/api/me/verify', { method: 'POST', body: { token, deviceName: 'PWA' }, noAuth: true }),
    logout: () => {
      const rt = getRT();
      call('/api/me/logout', { method: 'POST', body: { refreshToken: rt, pushToken: null } }).catch(() => {});
      clearTokens();
    },

    // Session
    hasSession: () => !!(getAT() || getRT()),
    setTokens,
    clearTokens,

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
