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
    window.location.href = '/credit';
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

  // Build complete navbar inner HTML (desktop menu)
  const linksHTML = links.map(l =>
    `<a href="${l.href}" class="navbar-link${path === l.href ? ' active' : ''}"${l.id ? ` id="${l.id}"` : ''}>${l.label}</a>`
  ).join('');

  navbar.innerHTML = `
    <div class="navbar-inner">
      <a href="/credit" class="navbar-brand">
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

  // ── Bottom Navigation (mobile) ──
  buildBottomNav(staff, path);

  // V3.5: Fetch unread badge
  loadUnreadBadge();
}

// ─── SVG Icons for bottom nav ────────────────────────

const NAV_ICONS = {
  credit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  clients: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  preferences: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  messages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  staff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
};

function buildBottomNav(staff, path) {
  // Remove existing bottom nav if any
  const existing = document.querySelector('.bottom-nav');
  if (existing) existing.remove();
  const existingSheet = document.querySelector('.bnav-sheet');
  if (existingSheet) existingSheet.remove();

  // Define nav items per role
  const mainItems = [];
  const sheetItems = [];

  mainItems.push({ href: '/credit', label: 'Créditer', icon: 'credit' });

  if (['owner', 'manager'].includes(staff.role)) {
    mainItems.push({ href: '/dashboard', label: 'Dashboard', icon: 'dashboard' });
    mainItems.push({ href: '/clients', label: 'Clients', icon: 'clients' });
  }

  // Messages always visible in main bar (for badge visibility)
  mainItems.push({ href: '/messages', label: 'Messages', icon: 'messages', id: 'bnav-messages' });

  if (staff.role === 'owner') {
    // Owner: overflow préfs + equipe + logout
    mainItems.push({ href: '#more', label: 'Plus', icon: 'more', isMore: true });

    sheetItems.push({ href: '/preferences', label: 'Préférences', icon: 'preferences' });
    sheetItems.push({ href: '/staff', label: 'Équipe', icon: 'staff' });
    sheetItems.push({ href: '#logout', label: 'Déconnexion', icon: 'logout', isLogout: true, danger: true });
  } else {
    // Manager/Cashier: logout in sheet via "Plus"
    mainItems.push({ href: '#more', label: 'Plus', icon: 'more', isMore: true });
    sheetItems.push({ href: '#logout', label: 'Déconnexion', icon: 'logout', isLogout: true, danger: true });
  }

  // Build bottom nav HTML
  const navHTML = mainItems.map(item => {
    if (item.isMore) {
      return `<a href="#" class="bnav-item" onclick="toggleBnavSheet(event)">${NAV_ICONS[item.icon]}<span>${item.label}</span></a>`;
    }
    const active = path === item.href ? ' active' : '';
    const idAttr = item.id ? ` id="${item.id}"` : '';
    return `<a href="${item.href}" class="bnav-item${active}"${idAttr}>${NAV_ICONS[item.icon]}<span>${item.label}</span></a>`;
  }).join('');

  const bottomNav = document.createElement('nav');
  bottomNav.className = 'bottom-nav';
  bottomNav.innerHTML = `<div class="bottom-nav-inner">${navHTML}</div>`;
  document.body.appendChild(bottomNav);
  document.body.classList.add('has-bnav');

  // Build sheet if needed (owner)
  if (sheetItems.length > 0) {
    const sheetHTML = sheetItems.map(item => {
      if (item.isLogout) {
        return `<a href="#" class="bnav-sheet-item danger" onclick="event.preventDefault();Auth.logout();">${NAV_ICONS[item.icon]}<span>${item.label}</span></a>`;
      }
      const idAttr = item.id ? ` id="${item.id}"` : '';
      return `<a href="${item.href}" class="bnav-sheet-item"${idAttr}>${NAV_ICONS[item.icon]}<span>${item.label}</span></a>`;
    }).join('');

    const sheet = document.createElement('div');
    sheet.className = 'bnav-sheet';
    sheet.id = 'bnav-sheet';
    sheet.onclick = function(e) { if (e.target === this) closeBnavSheet(); };
    sheet.innerHTML = `<div class="bnav-sheet-content"><div class="bnav-sheet-handle"></div>${sheetHTML}</div>`;
    document.body.appendChild(sheet);
  }
}

function toggleBnavSheet(e) {
  e.preventDefault();
  const sheet = document.getElementById('bnav-sheet');
  if (sheet) sheet.classList.toggle('open');
}
function closeBnavSheet() {
  const sheet = document.getElementById('bnav-sheet');
  if (sheet) sheet.classList.remove('open');
}


// ─── Unread Messages Badge (V3.5) ───────────────────

async function loadUnreadBadge() {
  try {
    const data = await API.messages.getUnreadCount();
    if (data.unread > 0) {
      // Desktop navbar badge
      const navLink = document.getElementById('nav-messages');
      if (navLink) {
        navLink.innerHTML = `Messages <span class="navbar-badge">${data.unread}</span>`;
      }
      // Bottom nav badge
      const bnavLink = document.getElementById('bnav-messages');
      if (bnavLink) {
        // Add badge to bottom nav item (check if not already there)
        if (!bnavLink.querySelector('.bnav-badge')) {
          const badge = document.createElement('span');
          badge.className = 'bnav-badge';
          badge.textContent = data.unread;
          bnavLink.appendChild(badge);
        }
      }
    }
  } catch (e) {
    // Silent — badge is non-critical
  }
}


// ─── Init ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', setupNavbar);

// ─── PWA Service Worker ──────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
