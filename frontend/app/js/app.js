/* ═══════════════════════════════════════════════════════
   FIDDO App — Main Logic
   ═══════════════════════════════════════════════════════ */

const App = (() => {
  let client = null;
  let cards = [];
  let currentCard = null;
  let currentMerchant = null;
  let screenStack = [];
  let scannerStream = null;
  let scanInterval = null;

  // ─── Theme map ────────────────────────────
  const THEMES = {
    teal: '#0d9488', navy: '#1e40af', rose: '#e11d48',
    amber: '#d97706', purple: '#7c3aed', green: '#059669', slate: '#475569'
  };
  const DAYS = { lun: 'Lundi', mar: 'Mardi', mer: 'Mercredi', jeu: 'Jeudi', ven: 'Vendredi', sam: 'Samedi', dim: 'Dimanche' };
  const DAY_KEYS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];

  // ═══════════════════════════════════════════
  // NAVIGATION
  // ═══════════════════════════════════════════

  function show(id, slide = false) {
    const allScreens = document.querySelectorAll('.screen');

    if (slide) {
      // Push slide screen
      const el = document.getElementById(id);
      el.classList.add('active');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('active')));
      screenStack.push(id);
    } else {
      // Replace screen
      allScreens.forEach(s => { s.classList.remove('active'); });
      document.getElementById(id).classList.add('active');
      screenStack = [id];
    }
  }

  function goBack() {
    if (screenStack.length > 0) {
      const topId = screenStack.pop();
      const el = document.getElementById(topId);
      el.style.transform = 'translateX(100%)';
      setTimeout(() => { el.classList.remove('active'); el.style.transform = ''; }, 350);
    }
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tb').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    document.querySelector(`.tb[data-tab="${name}"]`).classList.add('active');

    if (name === 'scanner') startScanner();
    else stopScanner();
    if (name === 'profile') loadProfile();
  }

  // ═══════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════

  async function init() {
    // Check for verify token in URL
    const params = new URLSearchParams(window.location.search);
    const hash = window.location.hash;
    let verifyToken = params.get('token');

    // Also check hash-based: #verify=TOKEN
    if (!verifyToken && hash.startsWith('#verify=')) {
      verifyToken = decodeURIComponent(hash.substring(8));
    }

    if (verifyToken) {
      window.history.replaceState({}, '', window.location.pathname);
      await handleVerify(verifyToken);
      return;
    }

    // Existing session?
    if (API.hasSession()) {
      const res = await API.getCards();
      if (res.ok) {
        client = res.data.client;
        cards = res.data.cards || [];
        showApp();
        return;
      }
      API.clearTokens();
    }

    show('screen-login');
  }

  async function handleLogin() {
    const input = document.getElementById('login-email');
    const email = input.value.trim().toLowerCase();
    if (!email || !email.includes('@')) { toast('Email invalide'); return; }

    const btn = document.getElementById('btn-login');
    btn.classList.add('loading');
    btn.innerHTML = '<span>Envoi en cours…</span>';

    try {
      await API.login(email);
      document.getElementById('sent-email').textContent = email;
      document.getElementById('login-form').classList.add('hidden');
      document.getElementById('login-sent').classList.remove('hidden');
    } catch {
      toast('Erreur réseau');
    } finally {
      btn.classList.remove('loading');
      btn.innerHTML = '<span>Recevoir mon lien</span><span class="material-symbols-rounded">east</span>';
    }
  }

  function resendLogin() {
    document.getElementById('login-form').classList.remove('hidden');
    document.getElementById('login-sent').classList.add('hidden');
    handleLogin();
  }

  function resetLogin() {
    document.getElementById('login-form').classList.remove('hidden');
    document.getElementById('login-sent').classList.add('hidden');
    document.getElementById('login-email').focus();
  }

  async function handleVerify(token) {
    show('screen-verify');
    const res = await API.verify(token);

    if (!res.ok) {
      document.querySelector('#screen-verify .loader').style.display = 'none';
      document.querySelector('#screen-verify h2').textContent = 'Connexion échouée';
      const err = document.getElementById('verify-error');
      err.textContent = res.data?.error || 'Lien expiré ou invalide';
      err.classList.remove('hidden');
      document.getElementById('verify-retry').classList.remove('hidden');
      return;
    }

    API.setTokens(res.data.accessToken, res.data.refreshToken);
    client = res.data.client;

    // Load cards
    const cardsRes = await API.getCards();
    if (cardsRes.ok) cards = cardsRes.data.cards || [];

    // Show onboarding if profile not complete
    if (!client.profileCompleted && !client.name) {
      show('screen-onboarding');
    } else {
      showApp();
    }
  }

  async function submitOnboarding() {
    const name = document.getElementById('onboard-name').value.trim();
    const phone = document.getElementById('onboard-phone').value.trim();
    const dob = document.getElementById('onboard-dob').value;

    if (!name) { toast('Entrez votre nom'); return; }

    const body = { name };
    if (phone) body.phone = phone;
    if (dob) body.dateOfBirth = dob;

    const res = await API.updateProfile(body);
    if (res.ok) {
      client.name = name;
      if (phone) client.phone = phone;
      if (dob) client.dateOfBirth = dob;
      showApp();
    } else {
      toast(res.data?.error || 'Erreur');
    }
  }

  function skipOnboarding() { showApp(); }

  async function logout() {
    if (!confirm('Voulez-vous vous déconnecter ?')) return;
    API.logout();
    client = null;
    cards = [];
    show('screen-login');
    resetLogin();
  }

  // ═══════════════════════════════════════════
  // MAIN APP
  // ═══════════════════════════════════════════

  function showApp() {
    show('screen-app');
    renderCards();
    loadProfile();
    loadNotifPrefs();
  }

  // ─── Cards list ───────────────────────────

  function renderCards() {
    const firstName = client?.name?.split(' ')[0] || '';
    document.getElementById('greeting').textContent = firstName ? `Bonjour ${firstName} 👋` : 'Bonjour 👋';
    document.getElementById('greeting-sub').textContent = cards.length > 0 ? `${cards.length} carte${cards.length > 1 ? 's' : ''} fidélité` : 'Vos cartes fidélité';

    const list = document.getElementById('cards-list');
    const empty = document.getElementById('cards-empty');

    if (cards.length === 0) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    list.innerHTML = cards.map(c => {
      const theme = c.theme || 'teal';
      const color = THEMES[theme] || THEMES.teal;
      const left = Math.max(c.pointsForReward - c.pointsBalance, 0);
      const pct = Math.min(c.progress || 0, 100);
      const date = c.lastVisit ? relDate(c.lastVisit) : '';

      return `
        <div class="loyalty-card theme-${theme}" onclick="App.openCard(${c.merchantId})">
          <div class="lc-head">
            <div class="lc-icon"><span class="material-symbols-rounded">restaurant</span></div>
            <span class="lc-name">${esc(c.merchantName)}</span>
            <span class="material-symbols-rounded lc-arrow">chevron_right</span>
          </div>
          <div class="lc-pts">
            <span class="lc-pts-big">${c.pointsBalance}</span>
            <span class="lc-pts-tot">/ ${c.pointsForReward} pts</span>
          </div>
          <div class="lc-prog"><div class="lc-prog-fill" style="width:${pct}%"></div></div>
          <div class="lc-foot">
            ${c.canRedeem
              ? `<span class="lc-reward" style="color:${color}"><span class="material-symbols-rounded">redeem</span>Récompense dispo !</span>`
              : `<span class="lc-left">Encore ${left} pts</span>`
            }
            <span class="lc-date">${date}</span>
          </div>
        </div>`;
    }).join('');
  }

  async function refreshCards() {
    const res = await API.getCards();
    if (res.ok) {
      client = res.data.client || client;
      cards = res.data.cards || [];
      renderCards();
    }
  }

  // ─── Card detail ──────────────────────────

  async function openCard(merchantId) {
    const res = await API.getCard(merchantId);
    if (!res.ok) { toast('Erreur chargement'); return; }

    const { card, merchant } = res.data;
    currentCard = card;
    currentMerchant = merchant;
    const theme = merchant.theme || 'teal';
    const color = THEMES[theme] || THEMES.teal;

    // Hero
    const hero = document.getElementById('card-hero');
    hero.className = 'card-hero theme-' + theme;
    document.getElementById('cd-name').textContent = merchant.name;
    document.getElementById('cd-pts').textContent = card.pointsBalance;
    document.getElementById('cd-pts-tot').textContent = '/ ' + card.pointsForReward + ' pts';
    document.getElementById('cd-prog').style.width = Math.min(card.progress || 0, 100) + '%';

    // Reward badge
    const badge = document.getElementById('cd-badge');
    if (card.canRedeem) {
      badge.innerHTML = `<span class="cd-reward-pill" style="color:${color}"><span class="material-symbols-rounded">redeem</span>${esc(card.rewardDescription)}</span>`;
    } else {
      badge.innerHTML = `<span class="cd-until">Encore ${card.pointsUntilReward} points</span>`;
    }

    // Stats
    document.getElementById('cd-visits').textContent = card.visitCount;
    document.getElementById('cd-spent').textContent = card.totalSpent + '€';
    document.getElementById('cd-ratio').textContent = card.pointsPerEuro;

    // Info card
    const info = document.getElementById('cd-info');
    let html = '';
    if (merchant.address) html += infoRow('location_on', merchant.address, () => openMaps());
    if (merchant.phone) html += infoRow('call', merchant.phone, () => window.open('tel:' + merchant.phone));
    if (merchant.email) html += infoRow('mail', merchant.email, () => window.open('mailto:' + merchant.email));
    if (merchant.websiteUrl) html += infoRow('language', merchant.websiteUrl, () => window.open(merchant.websiteUrl));
    if (merchant.instagramUrl) html += infoRow('photo_camera', 'Instagram', () => window.open(merchant.instagramUrl));
    if (merchant.facebookUrl) html += infoRow('group', 'Facebook', () => window.open(merchant.facebookUrl));
    info.innerHTML = html;

    // Hours
    const hoursWrap = document.getElementById('cd-hours-wrap');
    if (merchant.openingHours && Object.keys(merchant.openingHours).length > 0) {
      hoursWrap.classList.remove('hidden');
      const todayKey = DAY_KEYS[new Date().getDay()];
      document.getElementById('cd-hours').innerHTML = Object.entries(merchant.openingHours).map(([day, hrs]) => {
        const isToday = day === todayKey;
        return `<div class="hour-row${isToday ? ' today' : ''}"><span class="hour-day">${DAYS[day] || day}</span><span class="hour-val">${hrs || 'Fermé'}</span></div>`;
      }).join('');
    } else {
      hoursWrap.classList.add('hidden');
    }

    // Show/hide maps button
    document.getElementById('btn-maps').style.display = (merchant.latitude || merchant.address) ? 'flex' : 'none';

    // Slide in
    const el = document.getElementById('screen-card');
    el.classList.add('active');
    el.style.transform = 'translateX(0)';
    screenStack.push('screen-card');

    // Scroll to top
    document.getElementById('card-body').scrollTop = 0;
  }

  function infoRow(icon, text, onclick) {
    const id = 'ir_' + Math.random().toString(36).substr(2, 6);
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el && onclick) el.onclick = onclick;
    }, 50);
    return `<div class="info-row" id="${id}"><span class="material-symbols-rounded">${icon}</span><span>${esc(text)}</span><span class="material-symbols-rounded">open_in_new</span></div>`;
  }

  function openMaps() {
    if (!currentMerchant) return;
    if (currentMerchant.latitude && currentMerchant.longitude) {
      window.open(`https://maps.google.com/?q=${currentMerchant.latitude},${currentMerchant.longitude}`);
    } else if (currentMerchant.address) {
      window.open(`https://maps.google.com/?q=${encodeURIComponent(currentMerchant.address)}`);
    }
  }

  // ─── History ──────────────────────────────

  async function showHistory() {
    if (!currentMerchant) return;

    const el = document.getElementById('screen-history');
    el.classList.add('active');
    el.style.transform = 'translateX(0)';
    screenStack.push('screen-history');

    const list = document.getElementById('hist-list');
    list.innerHTML = '<div style="text-align:center;padding:40px"><div class="loader"></div></div>';

    const res = await API.getHistory(currentMerchant.id, 100, 0);
    if (!res.ok) { list.innerHTML = '<p style="text-align:center;padding:40px;color:var(--tx3)">Erreur chargement</p>'; return; }

    const txs = res.data.transactions || [];
    document.getElementById('hist-count').textContent = res.data.total + ' transaction' + (res.data.total !== 1 ? 's' : '');

    if (txs.length === 0) {
      list.innerHTML = '<p style="text-align:center;padding:60px;color:var(--tx3)">Aucune transaction</p>';
      return;
    }

    const TYPE_MAP = {
      credit:     { icon: 'add_circle', color: 'var(--ok)', bg: 'var(--ok-l)', label: 'Crédit' },
      reward:     { icon: 'redeem', color: 'var(--rew)', bg: 'var(--warn-l)', label: 'Récompense' },
      adjustment: { icon: 'build', color: 'var(--pri)', bg: 'var(--pri-l)', label: 'Ajustement' },
      merge:      { icon: 'merge', color: 'var(--tx3)', bg: 'var(--brd-l)', label: 'Fusion' },
    };

    list.innerHTML = txs.map(tx => {
      const t = TYPE_MAP[tx.type] || TYPE_MAP.credit;
      const sign = tx.pointsDelta > 0 ? '+' : '';
      const cls = tx.pointsDelta > 0 ? 'pos' : 'neg';
      const detail = [tx.amount ? tx.amount + '€' : '', tx.staffName].filter(Boolean).join(' · ') || tx.notes || '';
      const date = new Date(tx.createdAt).toLocaleDateString('fr-BE', { day: 'numeric', month: 'short' });

      return `
        <div class="tx-row">
          <div class="tx-icon" style="background:${t.bg}"><span class="material-symbols-rounded" style="color:${t.color}">${t.icon}</span></div>
          <div class="tx-body">
            <div class="tx-top"><span class="tx-type">${t.label}</span><span class="tx-pts ${cls}">${sign}${tx.pointsDelta} pts</span></div>
            <div class="tx-bot"><span class="tx-detail">${esc(detail)}</span><span class="tx-date">${date}</span></div>
          </div>
        </div>`;
    }).join('');
  }

  // ─── Profile ──────────────────────────────

  function loadProfile() {
    if (!client) return;
    document.getElementById('prof-avatar').textContent = (client.name || '?')[0].toUpperCase();
    document.getElementById('prof-name').textContent = client.name || 'Sans nom';
    document.getElementById('prof-email').textContent = client.email || '—';

    const phoneRow = document.getElementById('prof-phone-row');
    if (client.phone) { phoneRow.classList.remove('hidden'); document.getElementById('prof-phone').textContent = client.phone; }
    else phoneRow.classList.add('hidden');

    const dobRow = document.getElementById('prof-dob-row');
    if (client.dateOfBirth) { dobRow.classList.remove('hidden'); document.getElementById('prof-dob').textContent = client.dateOfBirth; }
    else dobRow.classList.add('hidden');
  }

  async function loadNotifPrefs() {
    const res = await API.getNotifPrefs();
    if (!res.ok) return;
    document.getElementById('notif-credit').checked = res.data.notifCredit;
    document.getElementById('notif-reward').checked = res.data.notifReward;
    document.getElementById('notif-promo').checked = res.data.notifPromo;
    document.getElementById('notif-birthday').checked = res.data.notifBirthday;
  }

  async function saveNotifs() {
    await API.setNotifPrefs({
      notifCredit: document.getElementById('notif-credit').checked,
      notifReward: document.getElementById('notif-reward').checked,
      notifPromo: document.getElementById('notif-promo').checked,
      notifBirthday: document.getElementById('notif-birthday').checked,
    });
  }

  function editName() {
    document.getElementById('edit-name').value = client?.name || '';
    openModal('modal-edit');
    setTimeout(() => document.getElementById('edit-name').focus(), 400);
  }

  async function saveName() {
    const name = document.getElementById('edit-name').value.trim();
    if (!name) return;
    const res = await API.updateProfile({ name });
    if (res.ok) {
      client.name = name;
      loadProfile();
      renderCards(); // Update greeting
      closeModal();
      toast('Nom mis à jour');
    } else {
      toast(res.data?.error || 'Erreur');
    }
  }

  // ─── My QR ────────────────────────────────

  async function showMyQR() {
    openModal('modal-qr');
    document.getElementById('qr-name').textContent = client?.name || '';

    const res = await API.getQR();
    if (!res.ok) return;

    const canvas = document.getElementById('qr-canvas');
    if (typeof QRCode !== 'undefined') {
      QRCode.toCanvas(canvas, res.data.qrUrl, {
        width: 220,
        margin: 2,
        color: { dark: '#0c1f1d', light: '#ffffff' }
      });
    }
  }

  // ─── Scanner ──────────────────────────────

  async function startScanner() {
    const video = document.getElementById('scan-video');
    const noCam = document.getElementById('scan-no-cam');

    if (scannerStream) return; // Already running

    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      video.srcObject = scannerStream;
      noCam.classList.add('hidden');

      // If BarcodeDetector is available (Chrome, Safari 16.4+)
      if ('BarcodeDetector' in window) {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        scanInterval = setInterval(async () => {
          try {
            const barcodes = await detector.detect(video);
            if (barcodes.length > 0) handleScan(barcodes[0].rawValue);
          } catch {}
        }, 300);
      }
    } catch {
      noCam.classList.remove('hidden');
    }
  }

  function stopScanner() {
    if (scannerStream) {
      scannerStream.getTracks().forEach(t => t.stop());
      scannerStream = null;
    }
    if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
  }

  function handleScan(data) {
    const match = data.match(/fiddo\.be\/q\/([a-zA-Z0-9_-]+)/);
    if (!match) { toast("QR non reconnu"); return; }

    stopScanner();
    // Open the FIDDO QR URL
    window.open(data, '_blank');
    setTimeout(() => { if (document.querySelector('.tb.active')?.dataset.tab === 'scanner') startScanner(); }, 2000);
  }

  // ─── Modals ───────────────────────────────

  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal() { document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')); }

  // ─── Toast ────────────────────────────────

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
  }

  // ─── Helpers ──────────────────────────────

  function relDate(d) {
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
    if (days === 0) return "Aujourd'hui";
    if (days === 1) return 'Hier';
    if (days < 7) return `Il y a ${days}j`;
    if (days < 30) return `Il y a ${Math.floor(days / 7)} sem.`;
    return `Il y a ${Math.floor(days / 30)} mois`;
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

  // ─── Event bindings ───────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    // Login
    document.getElementById('btn-login').addEventListener('click', handleLogin);
    document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
    document.getElementById('btn-resend').addEventListener('click', resendLogin);
    document.getElementById('btn-change-email').addEventListener('click', resetLogin);

    // Onboarding
    document.getElementById('btn-onboard').addEventListener('click', submitOnboarding);
    document.getElementById('btn-skip-onboard').addEventListener('click', skipOnboarding);

    // Edit name
    document.getElementById('btn-save-name').addEventListener('click', saveName);
    document.getElementById('edit-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });

    // Notif toggles
    document.querySelectorAll('.notif-row input').forEach(el => el.addEventListener('change', saveNotifs));

    // Add solid class to onboarding for light field styles
    document.querySelector('.onboard-content').classList.add('solid');

    // Pull-to-refresh on cards
    let startY = 0;
    const scroll = document.getElementById('cards-scroll');
    if (scroll) {
      scroll.addEventListener('touchstart', e => { startY = e.touches[0].pageY; });
      scroll.addEventListener('touchend', e => {
        if (scroll.scrollTop === 0 && e.changedTouches[0].pageY - startY > 80) {
          refreshCards();
          toast('Actualisation…');
        }
      });
    }

    // Init
    init();
  });

  // ─── Public API ───────────────────────────
  return {
    handleLogin, resendLogin, resetLogin,
    submitOnboarding, skipOnboarding,
    show, goBack, switchTab,
    openCard, showHistory, openMaps,
    showMyQR, editName, saveName,
    startScanner, closeModal,
    logout, saveNotifs, toast
  };
})();
