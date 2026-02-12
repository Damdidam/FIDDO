// ═══════════════════════════════════════════════════════
// FIDDO V3.5 — Frontend Core
// ═══════════════════════════════════════════════════════

const API_BASE_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000/api'
  : '/api';

// ─── Theme Colors ────────────────────────────────────

const THEME_COLORS = {
  teal:   ['#0891B2', '#0E7490'],
  navy:   ['#2563EB', '#1D4ED8'],
  violet: ['#7C3AED', '#6D28D9'],
  forest: ['#059669', '#047857'],
  brick:  ['#DC2626', '#B91C1C'],
  amber:  ['#D97706', '#B45309'],
  slate:  ['#475569', '#334155'],
};

/**
 * Apply a theme globally: set CSS variables + persist in sessionStorage.
 * Called from setupNavbar() on every page load and from preferences selectTheme().
 */
function applyTheme(themeId) {
  const colors = THEME_COLORS[themeId];
  if (!colors) return;
  document.documentElement.style.setProperty('--primary', colors[0]);
  document.documentElement.style.setProperty('--primary-dark', colors[1]);
  sessionStorage.setItem('fiddo_theme', themeId);
}

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
    sessionStorage.removeItem('fiddo_theme');
  },
  isAuthenticated: () => !!Auth.getStaff(),
  hasRole: (...roles) => {
    const s = Auth.getStaff();
    return s && roles.includes(s.role);
  },
  logout: async () => {
    try { await API.auth.logout(); } catch (e) { /* ignore */ }
    Auth.clearSession();
    window.location.href = '/login';
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
      window.location.href = '/login';
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
    quickSearch: (q, mode) => API.call(`/clients/quick-search?q=${encodeURIComponent(q)}&mode=${mode || 'email'}`),
    enriched: () => API.call('/clients/enriched'),
    recentActivity: (limit) => API.call(`/clients/recent-activity?limit=${limit || 50}`),
    getById: (id) => API.call(`/clients/${id}`),
    edit: (id, data) => API.call(`/clients/${id}/edit`, { method: 'PUT', body: JSON.stringify(data) }),
    updateNotes: (id, notes) => API.call(`/clients/${id}/notes`, { method: 'PUT', body: JSON.stringify({ notes }) }),
    block: (id) => API.call(`/clients/${id}/block`, { method: 'POST' }),
    unblock: (id) => API.call(`/clients/${id}/unblock`, { method: 'POST' }),
    setPin: (id, pin) => API.call(`/clients/${id}/pin`, { method: 'POST', body: JSON.stringify({ pin }) }),
    setCustomReward: (id, customReward) => API.call(`/clients/${id}/custom-reward`, { method: 'PUT', body: JSON.stringify({ customReward }) }),
    resendEmail: (id) => API.call(`/clients/${id}/resend-email`, { method: 'POST' }),
    merge: (targetId, sourceMerchantClientId, reason) => API.call(`/clients/${targetId}/merge`, { method: 'POST', body: JSON.stringify({ sourceMerchantClientId, reason }) }),
    delete: (id) => API.call(`/clients/${id}`, { method: 'DELETE' }),
    exportCSV: () => { window.location.href = `${API_BASE_URL}/clients/export/csv`; },
  },

  staff: {
    list: () => API.call('/staff'),
    create: (d) => API.call('/staff', { method: 'POST', body: JSON.stringify(d) }),
    updateRole: (id, role) => API.call(`/staff/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
    toggle: (id) => API.call(`/staff/${id}/toggle`, { method: 'PUT' }),
    resetPassword: (id, password) => API.call(`/staff/${id}/password`, { method: 'PUT', body: JSON.stringify({ password }) }),
    delete: (id) => API.call(`/staff/${id}`, { method: 'DELETE' }),
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
    window.location.href = '/login';
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


// ─── Navbar Setup (Concept B — Pill Navigation) ─────

function setupNavbar() {
  const staff = Auth.getStaff();
  const merchant = Auth.getMerchant();
  if (!staff || !merchant) return;

  // ── Apply saved theme immediately (sessionStorage cache = instant) ──
  const cachedTheme = sessionStorage.getItem('fiddo_theme');
  if (cachedTheme && THEME_COLORS[cachedTheme]) {
    applyTheme(cachedTheme);
  }

  // ── Sync from server in background (first login or other-device change) ──
  API.preferences.get().then(data => {
    const serverTheme = data?.preferences?.theme;
    if (serverTheme && THEME_COLORS[serverTheme] && serverTheme !== cachedTheme) {
      applyTheme(serverTheme);
    }
  }).catch(() => { /* silent */ });

  const navbar = document.querySelector('.navbar');
  if (!navbar) return;

  const path = window.location.pathname;

  // Build links based on role
  const links = [];
  links.push({ href: '/credit', label: 'Créditer' });

  if (['owner', 'manager'].includes(staff.role)) {
    links.push({ href: '/dashboard', label: 'Tableau de bord' });
    links.push({ href: '/clients', label: 'Clients' });
  }

  if (staff.role === 'owner') {
    links.push({ href: '/staff', label: 'Équipe' });
    links.push({ href: '/preferences', label: 'Préférences' });
  }

  // V3.5: All staff can see messages
  links.push({ href: '/messages', label: 'Messages', id: 'nav-messages' });

  // Generate initials for avatar
  const initials = (staff.display_name || 'U')
    .split(' ')
    .map(w => w[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();

  // Build complete navbar inner HTML
  const linksHTML = links.map(l =>
    `<a href="${l.href}" class="navbar-link${path === l.href ? ' active' : ''}"${l.id ? ` id="${l.id}"` : ''}>${l.label}</a>`
  ).join('');

  navbar.innerHTML = `
    <div class="navbar-inner">
      <a href="/dashboard" class="navbar-brand">
        <span class="brand-mark">FIDDO</span>
        <span class="brand-divider"></span>
        <span class="brand-merchant">${merchant.business_name}</span>
      </a>
      <div class="navbar-menu">${linksHTML}</div>
      <div class="navbar-user">
        <span class="navbar-user-name">${staff.display_name}</span>
        <div class="navbar-avatar" onclick="Auth.logout()" title="Déconnexion">${initials}</div>
      </div>
    </div>
  `;

  // V3.5: Fetch unread badge
  loadUnreadBadge();
}


// ─── Unread Messages Badge (V3.5) ───────────────────

async function loadUnreadBadge() {
  try {
    const data = await API.messages.getUnreadCount();
    if (data.unread > 0) {
      const navLink = document.getElementById('nav-messages');
      if (navLink) {
        navLink.innerHTML = `Messages <span class="navbar-badge">${data.unread}</span>`;
      }
    }
  } catch (e) {
    // Silent — badge is non-critical
  }
}


// ─── Init ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', setupNavbar);
