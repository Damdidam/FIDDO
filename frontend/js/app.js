// ═══════════════════════════════════════════════════════
// FIDDO V3.5 — Frontend Core
// ═══════════════════════════════════════════════════════

const API_BASE_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000/api'
  : '/api';

// ─── Auth ────────────────────────────────────────────

const Auth = {
  getStaff: () => {
    const s = sessionStorage.getItem('staff');
    return s ? JSON.parse(s) : null;
  },
  getMerchant: () => {
    const m = sessionStorage.getItem('merchant');
    return m ? JSON.parse(m) : null;
  },
  setSession: (staff, merchant) => {
    sessionStorage.setItem('staff', JSON.stringify(staff));
    sessionStorage.setItem('merchant', JSON.stringify(merchant));
  },
  clearSession: () => {
    sessionStorage.removeItem('staff');
    sessionStorage.removeItem('merchant');
  },
  isAuthenticated: () => !!Auth.getStaff(),
  hasRole: (...roles) => {
    const s = Auth.getStaff();
    return s && roles.includes(s.role);
  },
  logout: async () => {
    try { await API.auth.logout(); } catch (e) { /* ignore */ }
    Auth.clearSession();
    window.location.href = '/';
  },
};


// ─── API Wrapper ─────────────────────────────────────

const API = {
  async call(endpoint, options = {}) {
    const config = {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...options,
    };

    const response = await fetch(`${API_BASE_URL}${endpoint}`, config);

    if (response.status === 401 && !endpoint.startsWith('/auth/login') && !endpoint.startsWith('/auth/register')) {
      Auth.clearSession();
      window.location.href = '/';
      return;
    }

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Une erreur est survenue');
    return data;
  },

  auth: {
    register: (data) => API.call('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
    login: (creds) => API.call('/auth/login', { method: 'POST', body: JSON.stringify(creds) }),
    verify: () => API.call('/auth/verify'),
    logout: () => API.call('/auth/logout', { method: 'POST' }),
    updateSettings: (s) => API.call('/auth/settings', { method: 'PUT', body: JSON.stringify(s) }),
  },

  clients: {
    credit: (d) => API.call('/clients/credit', { method: 'POST', body: JSON.stringify(d) }),
    reward: (d) => API.call('/clients/reward', { method: 'POST', body: JSON.stringify(d) }),
    adjust: (d) => API.call('/clients/adjust', { method: 'POST', body: JSON.stringify(d) }),
    lookup: (params) => {
      const qs = new URLSearchParams(params).toString();
      return API.call(`/clients/lookup?${qs}`);
    },
    getAll: () => API.call('/clients'),
    search: (q) => API.call(`/clients/search?q=${encodeURIComponent(q)}`),
    searchGlobal: (q) => API.call(`/clients/search-global?q=${encodeURIComponent(q)}`),
    getById: (id) => API.call(`/clients/${id}`),
    block: (id) => API.call(`/clients/${id}/block`, { method: 'POST' }),
    unblock: (id) => API.call(`/clients/${id}/unblock`, { method: 'POST' }),
    setCustomReward: (id, customReward) => API.call(`/clients/${id}/custom-reward`, { method: 'PUT', body: JSON.stringify({ customReward }) }),
    exportCSV: () => { window.location.href = `${API_BASE_URL}/clients/export/csv`; },
  },

  preferences: {
    get: () => API.call('/preferences'),
    update: (d) => API.call('/preferences', { method: 'PUT', body: JSON.stringify(d) }),
    setTheme: (theme) => API.call('/preferences/theme', { method: 'PATCH', body: JSON.stringify({ theme }) }),
    changePassword: (d) => API.call('/preferences/password', { method: 'PUT', body: JSON.stringify(d) }),
    getMerchantInfo: () => API.call('/preferences/merchant-info'),
    updateMerchantInfo: (d) => API.call('/preferences/merchant-info', { method: 'PUT', body: JSON.stringify(d) }),
    exportBackup: () => {
      window.location.href = `${API_BASE_URL}/preferences/backup/export`;
    },
    validateBackup: (data) => API.call('/preferences/backup/validate', { method: 'POST', body: JSON.stringify(data) }),
    importBackup: (data) => API.call('/preferences/backup/import', { method: 'POST', body: JSON.stringify({ data, confirmReplace: true }) }),
  },

  // ← V3.5: Messages & Invoices
  messages: {
    getAll: (type) => {
      const qs = type && type !== 'all' ? `?type=${type}` : '';
      return API.call(`/messages${qs}`);
    },
    getUnreadCount: () => API.call('/messages/unread-count'),
    markRead: (id) => API.call(`/messages/${id}/read`, { method: 'POST' }),
    markAllRead: () => API.call('/messages/read-all', { method: 'POST' }),
    getInvoices: () => API.call('/messages/invoices'),
  },
};


// ─── Formatting ──────────────────────────────────────

const Format = {
  date: (d) => new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }),
  datetime: (d) => new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
  currency: (a) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(a),
  timeSince: (d) => {
    const days = Math.floor((Date.now() - new Date(d)) / 86400000);
    if (days === 0) return "Aujourd'hui";
    if (days === 1) return 'Hier';
    if (days < 7) return `Il y a ${days}j`;
    if (days < 30) return `Il y a ${Math.floor(days / 7)} sem.`;
    return `Il y a ${Math.floor(days / 30)} mois`;
  },
  phone: (p) => {
    if (!p) return '';
    if (p.startsWith('+32') && p.length === 12) {
      return `+32 ${p.slice(3, 6)} ${p.slice(6, 8)} ${p.slice(8, 10)} ${p.slice(10)}`;
    }
    return p;
  },
};


// ─── Validation ──────────────────────────────────────

const Validate = {
  email: (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e),
  phone: (p) => {
    const c = p.replace(/[\s\-.()+]/g, '');
    return c.length >= 9 && c.length <= 13;
  },
  password: (p) => p.length >= 6,
};


// ─── UI Utilities ────────────────────────────────────

const UI = {
  showAlert: (elId, message, type = 'info') => {
    const el = document.getElementById(elId);
    if (!el) return;
    const icons = { success: '✅', error: '⚠️', info: 'ℹ️', warning: '⚠️' };
    el.innerHTML = `<div class="alert alert-${type === 'error' ? 'error' : type}">${icons[type] || ''} ${message}</div>`;
  },
  clearAlert: (elId) => {
    const el = document.getElementById(elId);
    if (el) el.innerHTML = '';
  },
  showLoading: (elId, msg = 'Chargement...') => {
    const el = document.getElementById(elId);
    if (el) el.innerHTML = `<div class="loading"><div class="spinner"></div>${msg}</div>`;
  },
  showEmptyState: (elId, icon, msg) => {
    const el = document.getElementById(elId);
    if (el) el.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${icon}</div><p>${msg}</p></div>`;
  },
  showError: (elId, msg) => {
    const el = document.getElementById(elId);
    if (el) el.innerHTML = `<div class="alert alert-error">⚠️ ${msg}</div>`;
  },
};


// ─── Auth Guard ──────────────────────────────────────

function requireAuth() {
  if (!Auth.isAuthenticated()) {
    window.location.href = '/';
    return false;
  }
  return true;
}

function requireOwner() {
  if (!requireAuth()) return false;
  if (!Auth.hasRole('owner')) {
    window.location.href = '/dashboard';
    return false;
  }
  return true;
}

function requireManager() {
  if (!requireAuth()) return false;
  if (!Auth.hasRole('owner', 'manager')) {
    window.location.href = '/credit';
    return false;
  }
  return true;
}


// ─── Navbar Setup ────────────────────────────────────

function setupNavbar() {
  const staff = Auth.getStaff();
  const merchant = Auth.getMerchant();
  if (!staff || !merchant) return;

  // Update brand
  const brand = document.querySelector('.navbar-brand span');
  if (brand) brand.textContent = ' | ' + merchant.business_name;

  // Build navigation based on role
  const menu = document.querySelector('.navbar-menu');
  if (!menu) return;

  const links = [];
  const path = window.location.pathname;

  // All staff can credit
  links.push({ href: '/credit', label: 'Créditer', icon: '➕' });

  // Owner & manager can see dashboard + clients
  if (['owner', 'manager'].includes(staff.role)) {
    links.push({ href: '/dashboard', label: 'Tableau de bord', icon: '📊' });
    links.push({ href: '/clients', label: 'Clients', icon: '👥' });
  }

  // Owner only: staff management + preferences
  if (staff.role === 'owner') {
    links.push({ href: '/staff', label: 'Équipe', icon: '🏷️' });
    links.push({ href: '/preferences', label: 'Préférences', icon: '⚙️' });
  }

  // V3.5: All staff can see messages
  links.push({ href: '/messages', label: 'Messages', icon: '✉️', id: 'nav-messages' });

  menu.innerHTML = links.map(l =>
    `<a href="${l.href}" class="navbar-link${path === l.href ? ' active' : ''}"${l.id ? ` id="${l.id}"` : ''}>${l.label}</a>`
  ).join('');

  // User info + logout
  const userInfo = document.createElement('div');
  userInfo.className = 'navbar-user';
  userInfo.innerHTML = `
    <span class="navbar-role">${staff.display_name} (${staff.role})</span>
    <button class="btn btn-outline btn-sm" onclick="Auth.logout()">Déconnexion</button>
  `;
  menu.appendChild(userInfo);

  // V3.5: Fetch unread badge
  loadUnreadBadge();
}


// ─── Unread Messages Badge (V3.5) ───────────────────

/**
 * Fetch unread message count and show red badge on Messages nav link.
 * Silent on error — badge is non-critical UI.
 */
async function loadUnreadBadge() {
  try {
    const data = await API.messages.getUnreadCount();
    if (data.unread > 0) {
      const navLink = document.getElementById('nav-messages');
      if (navLink) {
        navLink.innerHTML = `Messages <span style="
          background:#EF4444;color:#fff;font-size:.55rem;font-weight:700;
          padding:1px 5px;border-radius:8px;margin-left:3px;vertical-align:top;
        ">${data.unread}</span>`;
      }
    }
  } catch (e) {
    // Silent — badge is non-critical
  }
}


// ─── Init ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', setupNavbar);
