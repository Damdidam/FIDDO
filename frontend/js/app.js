// ═══════════════════════════════════════════════════════
// FIDDO V3.3 — Frontend Core
// Theme system + Preferences + Backup
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


// ─── Theme System ────────────────────────────────────

const Theme = {
  /**
   * Apply the saved theme on page load.
   * Priority: sessionStorage → fetch from API → default 'teal'
   */
  init() {
    // 1. Try sessionStorage (instant, no flicker)
    const cached = sessionStorage.getItem('fiddo_theme');
    if (cached) {
      document.documentElement.setAttribute('data-theme', cached);
      return;
    }

    // 2. If authenticated, fetch from API (async, may have brief flicker)
    if (Auth.isAuthenticated()) {
      Theme.fetchAndApply();
    }
  },

  async fetchAndApply() {
    try {
      const data = await API.call('/preferences');
      const theme = data.preferences?.theme || 'teal';
      document.documentElement.setAttribute('data-theme', theme);
      sessionStorage.setItem('fiddo_theme', theme);
    } catch (e) {
      // Silently fallback to default
    }
  },

  set(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    sessionStorage.setItem('fiddo_theme', theme);
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

    if (response.status === 401) {
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
    getById: (id) => API.call(`/clients/${id}`),
    block: (id) => API.call(`/clients/${id}/block`, { method: 'POST' }),
    unblock: (id) => API.call(`/clients/${id}/unblock`, { method: 'POST' }),
    exportCSV: () => { window.location.href = `${API_BASE_URL}/clients/export/csv`; },
  },

  preferences: {
    get: () => API.call('/preferences'),
    update: (prefs) => API.call('/preferences', { method: 'PUT', body: JSON.stringify(prefs) }),
    setTheme: (theme) => API.call('/preferences/theme', { method: 'PATCH', body: JSON.stringify({ theme }) }),
    validateBackup: (data) => API.call('/preferences/backup/validate', { method: 'POST', body: JSON.stringify(data) }),
    importBackup: (data) => API.call('/preferences/backup/import', { method: 'POST', body: JSON.stringify({ data, confirmReplace: true }) }),
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

  menu.innerHTML = links.map(l =>
    `<a href="${l.href}" class="navbar-link${path === l.href ? ' active' : ''}">${l.label}</a>`
  ).join('');

  // User info + logout
  const userInfo = document.createElement('div');
  userInfo.className = 'navbar-user';
  userInfo.innerHTML = `
    <span class="navbar-role">${staff.display_name} (${staff.role})</span>
    <button class="btn btn-outline btn-sm" onclick="Auth.logout()">Déconnexion</button>
  `;
  menu.appendChild(userInfo);
}


// ─── Init ────────────────────────────────────────────

// Apply theme immediately (before DOMContentLoaded) to avoid flash
Theme.init();

document.addEventListener('DOMContentLoaded', setupNavbar);
