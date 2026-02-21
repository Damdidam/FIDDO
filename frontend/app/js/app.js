/* ═══════════════════════════════════════════════════════
 FIDDO App — V4.3-debug (polling auth + debug toasts)
 ═══════════════════════════════════════════════════════ */

const App = (() => {
 let client = null;
 let cards = [];
 let previousCardStates = loadCardStates(); // { merchantId: { points, canRedeem } }
 let pointsPollTimer = null;
 let currentCard = null;
 let currentMerchant = null;
 let screenStack = [];
 let scannerStream = null;
 let scanInterval = null;
 let searchQuery = '';
 let activeFilter = 'all';

 let lastGiftLink = '';
 let pollTimer = null;

 const THEMES = {
 teal: '#0891B2', navy: '#0e7490', violet: '#7c3aed',
 forest: '#059669', brick: '#e11d48', amber: '#d97706', slate: '#475569'
 };

 function isBirthdayWeek(dob) {
 if (!dob) return false;
 var parts = dob.split('-'), mm = parseInt(parts[1]), dd = parseInt(parts[2]), now = new Date();
 for (var d = 0; d <= 7; d++) { var chk = new Date(now); chk.setDate(chk.getDate() + d); if (chk.getMonth()+1===mm && chk.getDate()===dd) return true; }
 return false;
 }

 const BIZ_TYPES = {
 horeca: { label: 'Horeca', icon: 'restaurant' },
 boulangerie: { label: 'Boulangerie', icon: 'bakery_dining' },
 coiffeur: { label: 'Coiffeur', icon: 'content_cut' },
 beaute: { label: 'Beauté', icon: 'spa' },
 pharmacie: { label: 'Pharmacie', icon: 'local_pharmacy' },
 fleuriste: { label: 'Fleuriste', icon: 'local_florist' },
 boucherie: { label: 'Boucherie', icon: 'set_meal' },
 epicerie: { label: 'Épicerie', icon: 'grocery' },
 cave: { label: 'Cave', icon: 'wine_bar' },
 librairie: { label: 'Librairie', icon: 'auto_stories' },
 pressing: { label: 'Pressing', icon: 'local_laundry_service' },
 fitness: { label: 'Fitness', icon: 'fitness_center' },
 garage: { label: 'Garage', icon: 'garage_home' },
 veterinaire: { label: 'Véto', icon: 'pets' },
 autre: { label: 'Autre', icon: 'storefront' },
 };

 const DAYS = { lun: 'Lundi', mar: 'Mardi', mer: 'Mercredi', jeu: 'Jeudi', ven: 'Vendredi', sam: 'Samedi', dim: 'Dimanche' };
 const DAY_KEYS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];

 // ═══════════════════════════════════════════
 // NAVIGATION
 // ═══════════════════════════════════════════

 function show(id) {
 document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
 document.getElementById(id).classList.add('active');
 screenStack = [id];
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
 if (name === 'cards' && !animating) refreshCards();
 }

 // ═══════════════════════════════════════════
 // AUTH
 // ═══════════════════════════════════════════

 // Capacitor: intercept verify URLs opened by Android (App Links)
 try {
 if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
 // ── Handle magic link URLs ──
 window.Capacitor.Plugins.App.addListener('appUrlOpen', function(event) {
 try {
 var url = event.url || '';
 // Match /me/verify/{token}
 var match = url.match(/\/me\/verify\/([a-zA-Z0-9_-]+)/);
 if (match && match[1]) {
 handleVerify(match[1]);
 return;
 }
 // Also check for ?token= (legacy deep link)
 var tokenMatch = url.match(/[?&]token=([^&]+)/);
 if (tokenMatch) {
 var jwt = decodeURIComponent(tokenMatch[1]);
 if (jwt && jwt.length > 20) {
 API.setToken(jwt);
 window.location.reload();
 }
 }
 } catch (e) { console.error('appUrlOpen error:', e); }
 });

 // ── Handle Android back button ──
 window.Capacitor.Plugins.App.addListener('backButton', function() {
 // 1. Close any open modal first
 var openModal = document.querySelector('.modal.open');
 if (openModal) { closeModal(); return; }

 // 2. If on a detail screen (card, history, gift), go back
 if (screenStack.length > 1) { goBack(); return; }

 // 3. If on a non-cards tab, go back to cards
 var activeTab = document.querySelector('.tb.active');
 if (activeTab && activeTab.dataset.tab !== 'cards') {
 switchTab('cards');
 return;
 }

 // 4. On main cards screen — minimize app
 window.Capacitor.Plugins.App.minimizeApp();
 });
 }
 } catch (e) { /* not in Capacitor */ }

 async function init() {
 const params = new URLSearchParams(window.location.search);
 const hash = window.location.hash;

 // Save merchant QR token if present (from /q/TOKEN redirect)
 const merchantParam = params.get('merchant');
 if (merchantParam) {
 sessionStorage.setItem('fiddo_pending_merchant', merchantParam);
 const url = new URL(window.location);
 url.searchParams.delete('merchant');
 window.history.replaceState({}, '', url.pathname + url.search);
 }

 // 1) Magic link verify token
 let verifyToken = params.get('token');
 if (!verifyToken && hash.startsWith('#verify=')) verifyToken = decodeURIComponent(hash.substring(8));

 if (verifyToken) {
 window.history.replaceState({}, '', window.location.pathname);
 await handleVerify(verifyToken);
 return;
 }

 // 2) Gift claim token
 const giftToken = params.get('gift');
 if (giftToken) {
 window.history.replaceState({}, '', window.location.pathname);
 await handleGiftClaim(giftToken);
 return;
 }

 // 3) Existing session
 if (API.hasSession()) {
 const res = await API.getCards();
 if (res.ok) {
 client = res.data.client;
 cards = res.data.cards || [];
 saveCardStates(cards);
 showApp();
 return;
 }
 API.clearToken();
 }

 show('screen-login');
 }

 async function handleLogin() {
 const input = document.getElementById('login-email');
 const email = input.value.trim().toLowerCase();
 if (!email || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/.test(email)) { toast('Email invalide'); return; }

 const btn = document.getElementById('btn-login');
 btn.classList.add('loading');
 btn.innerHTML = '<span>Envoi en cours…</span>';

 try {
 const res = await API.login(email);

 document.getElementById('sent-email').textContent = email;
 document.getElementById('login-form').classList.add('hidden');
 document.getElementById('login-sent').classList.remove('hidden');

 // Start polling for auth completion (native app flow)
 if (res.ok && res.data && res.data.sessionId) {
 startPolling(res.data.sessionId);
 }
 } catch (e) {
 toast('Erreur réseau: ' + e.message);
 }
 finally {
 btn.classList.remove('loading');
 btn.innerHTML = '<span>Recevoir mon lien</span><span class="material-symbols-rounded">east</span>';
 }
 }

 // ─── Polling ──────────────────────────────

 let activeSessionId = null;

 function startPolling(sessionId) {
 stopPolling();
 activeSessionId = sessionId;
 let attempts = 0;
 const maxAttempts = 120;

 pollTimer = setInterval(() => doPoll(sessionId, ++attempts, maxAttempts), 3000);
 }

 async function doPoll(sessionId, attempt, maxAttempts) {
 if (attempt > maxAttempts) { stopPolling(); return; }

 try {
 const res = await API.call('/api/me/login/poll/' + sessionId, { noAuth: true });

 if (res.ok && res.data.status === 'ok' && res.data.token) {
 stopPolling();
 toast('Connexion réussie !');
 API.setToken(res.data.token);
 client = res.data.client || null;

 const cardsRes = await API.getCards();
 if (cardsRes.ok) {
 client = cardsRes.data.client || client;
 cards = cardsRes.data.cards || [];
 saveCardStates(cards);
 }
 showApp();
 } else if (res.data.status === 'expired') {
 stopPolling();
 }
 } catch (e) { /* network error, keep polling */ }
 }

 function stopPolling() {
 if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
 activeSessionId = null;
 }

 // ── Resume polling when app returns to foreground ──
 document.addEventListener('visibilitychange', () => {
 if (!document.hidden) {
 // Auth polling
 if (activeSessionId) doPoll(activeSessionId, 1, 120);
 // Points polling — refresh immediately on foreground
 if (client) refreshCards();
 }
 });
 // Capacitor-specific: also listen for app state changes
 try {
 if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
 window.Capacitor.Plugins.App.addListener('appStateChange', (state) => {
 if (state.isActive) {
 if (activeSessionId) doPoll(activeSessionId, 1, 120);
 if (client) refreshCards();
 }
 });
 }
 } catch (e) { /* not in Capacitor */ }

 function resendLogin() {
 stopPolling();
 document.getElementById('login-form').classList.remove('hidden');
 document.getElementById('login-sent').classList.add('hidden');
 handleLogin();
 }

 function resetLogin() {
 stopPolling();
 document.getElementById('login-form').classList.remove('hidden');
 document.getElementById('login-sent').classList.add('hidden');
 document.getElementById('login-email').focus();
 }

 async function handleVerify(token) {
 stopPolling();
 show('screen-verify');
 const res = await API.verify(token);
 if (!res.ok) {
 document.querySelector('#screen-verify .loader').style.display = 'none';
 document.querySelector('#screen-verify h2').textContent = 'Connexion échouée';
 document.getElementById('verify-error').textContent = res.data?.error || 'Lien expiré ou invalide';
 document.getElementById('verify-error').classList.remove('hidden');
 document.getElementById('verify-retry').classList.remove('hidden');
 return;
 }

 API.setToken(res.data.token);
 client = res.data.client;

 const cardsRes = await API.getCards();
 if (cardsRes.ok) cards = cardsRes.data.cards || [];
 showApp();
 }

 async function logout() {
 if (!confirm('Voulez-vous vous déconnecter ?')) return;
 stopPolling();
 stopPointsPolling();
 API.logout(); client = null; cards = []; clearCardStates();
 show('screen-login'); resetLogin();
 }

 // ═══════════════════════════════════════════
 // MAIN APP
 // ═══════════════════════════════════════════

 function showApp() {
 stopPolling();
 show('screen-app');
 renderCards();
 buildFilterPills();
 loadProfile();
 loadNotifPrefs();
 startPointsPolling();

 const pendingMerchant = sessionStorage.getItem('fiddo_pending_merchant');
 if (pendingMerchant) {
 sessionStorage.removeItem('fiddo_pending_merchant');
 autoRegisterAtMerchant(pendingMerchant);
 }
 }

 async function autoRegisterAtMerchant(merchantQrToken) {
 toast('Identification en cours…');
 try {
 const res = await API.call('/api/qr/register', {
 method: 'POST',
 body: {
 qrToken: merchantQrToken,
 email: client?.email || '',
 phone: client?.phone || '',
 name: client?.name || '',
 },
 noAuth: true,
 });

 if (res.ok) {
 const name = res.data.clientName || client?.name || '';
 if (res.data.cached) {
 toast(`Déjà identifié il y a ${res.data.minutesAgo} min`);
 } else {
 toast(`${name} identifié avec succès !`);
 }
 setTimeout(() => refreshCards(), 1500);
 } else {
 toast(res.data?.error || 'Erreur identification');
 }
 } catch (e) {
 console.error('Auto-register error:', e);
 toast('Erreur réseau');
 }
 }

 // ─── Search & Filter ──────────────────────

 function handleSearch(e) {
 searchQuery = e.target.value.toLowerCase().trim();
 document.getElementById('search-clear').classList.toggle('hidden', !searchQuery);
 renderFilteredCards();
 }

 function clearSearch() {
 document.getElementById('search-input').value = '';
 searchQuery = '';
 document.getElementById('search-clear').classList.add('hidden');
 renderFilteredCards();
 }

 function filterType(type) {
 activeFilter = type;
 document.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p.dataset.type === type));
 renderFilteredCards();
 }

 function buildFilterPills() {
 const types = new Set(cards.map(c => c.businessType || 'autre'));
 const row = document.getElementById('filter-row');
 let html = '<button class="pill active" data-type="all" onclick="App.filterType(\'all\')">Tous</button>';
 types.forEach(t => {
 const biz = BIZ_TYPES[t] || BIZ_TYPES.autre;
 html += `<button class="pill" data-type="${t}" onclick="App.filterType('${t}')">${biz.label}</button>`;
 });
 row.innerHTML = html;
 row.style.display = types.size > 1 ? 'flex' : 'none';
 }

 function renderFilteredCards() {
 let filtered = cards;
 if (activeFilter !== 'all') filtered = filtered.filter(c => (c.businessType || 'autre') === activeFilter);
 if (searchQuery) filtered = filtered.filter(c => c.merchantName.toLowerCase().includes(searchQuery));

 const list = document.getElementById('cards-list');
 const empty = document.getElementById('cards-empty');
 const noResult = document.getElementById('cards-no-result');

 if (cards.length === 0) { list.innerHTML = ''; empty.classList.remove('hidden'); noResult.classList.add('hidden'); return; }
 empty.classList.add('hidden');
 if (filtered.length === 0) { list.innerHTML = ''; noResult.classList.remove('hidden'); return; }
 noResult.classList.add('hidden');

 filtered.sort((a, b) => {
 const af = a.isFavorite ? 0 : 1;
 const bf = b.isFavorite ? 0 : 1;
 if (af !== bf) return af - bf;
 return new Date(b.lastVisit || 0) - new Date(a.lastVisit || 0);
 });

 list.innerHTML = filtered.map(c => {
 const theme = c.theme || 'navy';
 const color = THEMES[theme] || THEMES.navy;
 const left = Math.max(c.pointsForReward - c.pointsBalance, 0);
 const pct = Math.min(c.progress || 0, 100);
 const date = c.lastVisit ? relDate(c.lastVisit) : '';
 const biz = BIZ_TYPES[c.businessType || 'autre'] || BIZ_TYPES.autre;
 const isFav = c.isFavorite;

 return `
 <div class="loyalty-card theme-${theme}" onclick="App.openCard(${c.merchantId})">
 ${isFav ? '<div class="lc-fav"><span class="material-symbols-rounded">star</span></div>' : ''}
 <div class="lc-head">
 <div class="lc-icon"><span class="material-symbols-rounded">${biz.icon}</span></div>
 <span class="lc-name">${esc(c.merchantName)}</span>
 <span class="material-symbols-rounded lc-arrow">chevron_right</span>
 </div>
 <div class="lc-pts">
 <span class="lc-pts-big">${c.pointsBalance}</span>
 <span class="lc-pts-tot">/ ${c.pointsForReward} ${c.loyaltyMode === "visits" ? "visites" : "pts"}</span>
 </div>
 <div class="lc-prog"><div class="lc-prog-fill" style="width:${pct}%"></div></div>
 <div class="lc-foot">
 ${c.canRedeem
 ? `<span class="lc-reward" style="color:${color}"><span class="material-symbols-rounded">redeem</span>Récompense dispo !</span>`
 : `<span class="lc-left">Encore ${left} ${c.loyaltyMode === "visits" ? "visite" + (left > 1 ? "s" : "") : "pts"}</span>`}
 <span class="lc-date">${date}</span>
 </div>
 ${c.birthdayGift ? `<div class="lc-bday${isBirthdayWeek(client?.dateOfBirth) ? ' lc-bday-active' : ''}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><path d="M2 21h20"/><path d="M7 8v3"/><path d="M12 8v3"/><path d="M17 8v3"/><path d="M7 4h.01"/><path d="M12 4h.01"/><path d="M17 4h.01"/></svg>${esc(c.birthdayGift)}</div>` : ''}
 </div>`;
 }).join('');
 }

 function renderCards() {
 const displayName = client?.name || '';
 document.getElementById('greeting').textContent = displayName ? `Bonjour ${displayName} ` : 'Bienvenue ';
 document.getElementById('greeting-sub').textContent = cards.length > 0 ? `${cards.length} carte${cards.length > 1 ? 's' : ''} fidélité` : 'Scannez un QR pour commencer';
 renderFilteredCards();
 }

 let refreshing = false;
 let animating = false;
 let lastRenderTime = 0;

 async function refreshCards() {
 if (refreshing || animating) return;
 refreshing = true;
 try {
 const res = await API.getCards();
 if (res.ok) {
 client = res.data.client || client;
 const newCards = res.data.cards || [];

 // Detect points changes for animation
 for (const card of newCards) {
 const prev = previousCardStates[card.merchantId];
 if (prev) {
 if (card.pointsBalance > prev.points) {
 const diff = card.pointsBalance - prev.points;
 animating = true;
 saveCardStates(newCards);
 cards = newCards;
 closeModal();
 switchTab('cards');
 renderCards();
 setTimeout(() => {
 showAnimation('credit', card.loyaltyMode === 'visits' ? '+1 visite' : `+${diff} pts`, card.merchantName || (card.loyaltyMode === 'visits' ? 'Passage enregistré' : 'Points crédités'));
 setTimeout(() => { animating = false; lastRenderTime = Date.now(); }, 3000);
 }, 300);
 refreshing = false;
 return;
 } else if (card.canRedeem && !prev.canRedeem) {
 animating = true;
 saveCardStates(newCards);
 cards = newCards;
 closeModal();
 switchTab('cards');
 renderCards();
 setTimeout(() => {
 showAnimation('reward', 'Récompense !', card.rewardDescription || 'Félicitations !');
 setTimeout(() => { animating = false; lastRenderTime = Date.now(); }, 3000);
 }, 300);
 refreshing = false;
 return;
 }
 } else if (card.pointsBalance > 0) {
 // Card was hidden and just reappeared after a credit
 animating = true;
 saveCardStates(newCards);
 cards = newCards;
 closeModal();
 switchTab('cards');
 renderCards();
 setTimeout(() => {
 showAnimation('credit', card.loyaltyMode === 'visits' ? '+1 visite' : `+${card.pointsBalance} pts`, card.merchantName || (card.loyaltyMode === 'visits' ? 'Passage enregistré' : 'Points crédités'));
 setTimeout(() => { animating = false; lastRenderTime = Date.now(); }, 3000);
 }, 300);
 refreshing = false;
 return;
 }
 }

 // Store current state for next comparison
 saveCardStates(newCards);

 // Only re-render if display-relevant data changed AND not in cooldown
 const fingerprint = c => `${c.merchantId}:${c.pointsBalance}:${c.canRedeem}:${c.visitCount}:${c.isFavorite}:${c.businessType}:${c.theme}:${c.birthdayGift || ''}:${c.allowGifts}:${c.description || ''}`;
 const newFp = newCards.map(fingerprint).sort().join('|');
 const oldFp = cards.map(fingerprint).sort().join('|');
 cards = newCards;
 if (newFp !== oldFp && Date.now() - lastRenderTime > 3000) {
 renderCards();
 buildFilterPills();
 lastRenderTime = Date.now();
 }
 }
 } finally {
 refreshing = false;
 }
 }

 function saveCardStates(cardsList) {
 // Merge with existing (preserves hidden cards' states)
 const existing = loadCardStates();
 for (const c of cardsList) {
 existing[c.merchantId] = { points: c.pointsBalance, canRedeem: !!c.canRedeem };
 }
 previousCardStates = existing;
 try { localStorage.setItem('fiddo_card_states', JSON.stringify(previousCardStates)); } catch(e) {}
 }

 function loadCardStates() {
 try {
 const raw = localStorage.getItem('fiddo_card_states');
 return raw ? JSON.parse(raw) : {};
 } catch(e) { return {}; }
 }

 function clearCardStates() {
 previousCardStates = {};
 try { localStorage.removeItem('fiddo_card_states'); } catch(e) {}
 }

 // ─── Favorites ────────────────────────────

 async function toggleFav() {
 if (!currentMerchant) return;
 const id = currentMerchant.id;
 const res = await API.call(`/api/me/cards/${id}/favorite`, { method: 'PUT' });
 if (res.ok) {
 // Update local card data
 const card = cards.find(c => c.merchantId === id);
 if (card) card.isFavorite = res.data.isFavorite;
 toast(res.data.isFavorite ? 'Ajouté aux favoris' : 'Retiré des favoris');
 updateFavIcon();
 renderFilteredCards();
 } else {
 toast('Erreur');
 }
 }

 function updateFavIcon() {
 if (!currentMerchant) return;
 const icon = document.getElementById('fav-icon');
 const card = cards.find(c => c.merchantId === currentMerchant.id);
 const isFav = card?.isFavorite;
 icon.textContent = isFav ? 'star' : 'star_outline';
 if (isFav) icon.classList.add('filled'); else icon.classList.remove('filled');
 }

 async function hideCard() {
 if (!currentMerchant) return;
 if (!confirm(`Masquer la carte "${currentMerchant.name}" ?\n\nVotre progression sera conservée. Si vous rescannez le QR du commerçant, la carte réapparaîtra.`)) return;
 const id = currentMerchant.id;
 const res = await API.call(`/api/me/cards/${id}/hide`, { method: 'PUT' });
 if (res.ok) {
 cards = cards.filter(c => c.merchantId !== id);
 toast('Carte masquée');
 goBack();
 renderCards();
 buildFilterPills();
 } else {
 toast('Erreur');
 }
 }

 async function showHiddenCards() {
 try {
 const res = await API.call('/api/me/cards-hidden');
 if (!res.ok) { toast('Erreur'); return; }
 const list = document.getElementById('hidden-cards-list');
 const hiddenCards = res.data.cards || [];
 if (hiddenCards.length === 0) {
 list.innerHTML = '<p style="text-align:center;color:var(--tx3);font-size:14px;padding:20px 0">Aucune carte masquée</p>';
 } else {
 list.innerHTML = hiddenCards.map(c => {
 const unit = c.loyaltyMode === 'visits' ? 'visite' + (c.pointsBalance > 1 ? 's' : '') : 'pts';
 return '<div style="display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--brd-l)">' +
 '<div style="flex:1">' +
 '<div style="font-size:15px;font-weight:700">' + c.merchantName + '</div>' +
 '<div style="font-size:12px;color:var(--tx3)">' + c.pointsBalance + ' ' + unit + '</div>' +
 '</div>' +
 '<button onclick="App.unhideCard(' + c.merchantId + ')" style="padding:8px 16px;border-radius:var(--r-full);background:var(--pri);color:#fff;font-size:13px;font-weight:600;border:none">Restaurer</button>' +
 '</div>';
 }).join('');
 }
 openModal('modal-hidden');
 } catch (e) {
 toast('Erreur');
 }
 }

 async function unhideCard(merchantId) {
 const res = await API.call('/api/me/cards/' + merchantId + '/unhide', { method: 'PUT' });
 if (res.ok) {
 toast('Carte restaurée');
 closeModal();
 const cardsRes = await API.getCards();
 if (cardsRes.ok) {
 cards = cardsRes.data.cards || [];
 saveCardStates(cards); // prevent false credit animation
 renderCards();
 buildFilterPills();
 }
 } else {
 toast('Erreur');
 }
 }

 // ─── Card detail ──────────────────────────

 async function openCard(merchantId) {
 const res = await API.getCard(merchantId);
 if (!res.ok) { toast('Erreur chargement'); return; }

 const { card, merchant } = res.data;
 currentCard = card;
 currentMerchant = merchant;
 const theme = merchant.theme || 'navy';
 const color = THEMES[theme] || THEMES.navy;
 const biz = BIZ_TYPES[merchant.businessType || 'autre'] || BIZ_TYPES.autre;

 document.getElementById('card-hero').className = 'card-hero theme-' + theme;
 document.getElementById('cd-name').textContent = merchant.name;
 document.getElementById('cd-type').textContent = biz.label;
 document.getElementById('cd-pts').textContent = card.pointsBalance;
 document.getElementById('cd-pts-tot').textContent = '/ ' + card.pointsForReward + (currentMerchant && currentMerchant.loyaltyMode === 'visits' ? ' visites' : ' pts');
 document.getElementById('cd-prog').style.width = Math.min(card.progress || 0, 100) + '%';

 const badge = document.getElementById('cd-badge');
 if (card.canRedeem) badge.innerHTML = `<span class="cd-reward-pill" style="color:${color}"><span class="material-symbols-rounded">redeem</span>${esc(card.rewardDescription)}</span>`;
 else { var _u = merchant.loyaltyMode === "visits" ? "visite" + (card.pointsUntilReward > 1 ? "s" : "") : "points"; badge.innerHTML = `<span class="cd-until">Encore ${card.pointsUntilReward} ${_u}</span>`; }

 document.getElementById('cd-visits').textContent = card.visitCount;
 document.getElementById('cd-spent').textContent = card.totalSpent + '€';
 document.getElementById('cd-ratio').textContent = card.pointsPerEuro;
 updateFavIcon();

 const descEl = document.getElementById('cd-desc');
 if (merchant.description) { descEl.textContent = merchant.description; descEl.style.display = ''; }
 else { descEl.style.display = 'none'; }

 // Birthday gift
 const bdayEl = document.getElementById('cd-bday-gift');
 if (merchant.birthdayGift) {
 bdayEl.classList.remove('hidden');
 document.getElementById('cd-bday-desc').textContent = merchant.birthdayGift;
 var bdayActive = isBirthdayWeek(client?.dateOfBirth);
 bdayEl.classList.toggle('active', bdayActive);
 document.getElementById('cd-bday-label').textContent = bdayActive ? '🎂 C\'est bientôt votre anniversaire !' : 'Cadeau d\'anniversaire';
 } else {
 bdayEl.classList.add('hidden');
 }

 const giftBtn = document.getElementById('btn-gift');
 if (merchant.allowGifts && card.pointsBalance > 0) giftBtn.classList.remove('hidden');
 else giftBtn.classList.add('hidden');

 const info = document.getElementById('cd-info');
 let html = '';
 if (merchant.address) html += infoRow('location_on', merchant.address, () => openMaps());
 if (merchant.phone) html += infoRow('call', merchant.phone, () => window.open('tel:' + merchant.phone));
 if (merchant.email) html += infoRow('mail', merchant.email, () => window.open('mailto:' + merchant.email));
 if (merchant.websiteUrl) html += infoRow('language', cleanUrl(merchant.websiteUrl), () => window.open(merchant.websiteUrl));
 if (merchant.instagramUrl) html += infoRow('photo_camera', 'Instagram', () => window.open(merchant.instagramUrl));
 if (merchant.facebookUrl) html += infoRow('group', 'Facebook', () => window.open(merchant.facebookUrl));
 info.innerHTML = html;

 const hoursWrap = document.getElementById('cd-hours-wrap');
 if (merchant.openingHours && typeof merchant.openingHours === 'object' && Object.keys(merchant.openingHours).length > 0) {
 hoursWrap.classList.remove('hidden');
 const todayKey = DAY_KEYS[new Date().getDay()];
 document.getElementById('cd-hours').innerHTML = Object.entries(merchant.openingHours).map(([day, hrs]) => {
 const isToday = day === todayKey;
 return `<div class="hour-row${isToday ? ' today' : ''}"><span class="hour-day">${DAYS[day] || esc(day)}</span><span class="hour-val">${esc(hrs) || 'Fermé'}</span></div>`;
 }).join('');
 } else {
 hoursWrap.classList.add('hidden');
 }

 document.getElementById('btn-maps').style.display = (merchant.latitude || merchant.address) ? 'flex' : 'none';

 const el = document.getElementById('screen-card');
 el.classList.add('active');
 el.style.transform = 'translateX(0)';
 screenStack.push('screen-card');
 document.getElementById('card-body').scrollTop = 0;
 }

 function infoRow(icon, text, onclick) {
 const id = 'ir_' + Math.random().toString(36).substr(2, 6);
 setTimeout(() => { const el = document.getElementById(id); if (el && onclick) el.onclick = onclick; }, 50);
 return `<div class="info-row" id="${id}"><span class="material-symbols-rounded">${icon}</span><span>${esc(text)}</span><span class="material-symbols-rounded">open_in_new</span></div>`;
 }

 function cleanUrl(url) { return (url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); }

 function openMaps() {
 if (!currentMerchant) return;
 if (currentMerchant.latitude && currentMerchant.longitude)
 window.open(`https://maps.google.com/?q=${currentMerchant.latitude},${currentMerchant.longitude}`);
 else if (currentMerchant.address)
 window.open(`https://maps.google.com/?q=${encodeURIComponent(currentMerchant.address)}`);
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

 if (txs.length === 0) { list.innerHTML = '<p style="text-align:center;padding:60px;color:var(--tx3)">Aucune transaction</p>'; return; }

 const TYPE_MAP = {
 credit: { icon: 'add_circle', color: 'var(--ok)', bg: 'var(--ok-l)', label: 'Crédit' },
 reward: { icon: 'redeem', color: 'var(--rew)', bg: 'var(--warn-l)', label: 'Récompense' },
 adjustment: { icon: 'build', color: 'var(--pri)', bg: 'var(--pri-l)', label: 'Ajustement' },
 merge: { icon: 'merge', color: 'var(--tx3)', bg: 'var(--brd-l)', label: 'Fusion' },
 gift_out: { icon: 'card_giftcard', color: 'var(--rew)', bg: 'var(--warn-l)', label: 'Cadeau envoyé' },
 gift_in: { icon: 'card_giftcard', color: 'var(--ok)', bg: 'var(--ok-l)', label: 'Cadeau reçu' },
 gift_refund:{ icon: 'undo', color: 'var(--rew)', bg: 'var(--warn-l)', label: 'Transfert expiré — remboursé' },
 };

 list.innerHTML = txs.map(tx => {
 const t = TYPE_MAP[tx.type] || TYPE_MAP.credit;
 const sign = tx.pointsDelta > 0 ? '+' : '';
 const cls = tx.pointsDelta > 0 ? 'pos' : 'neg';
 const detail = [tx.amount ? tx.amount + '€' : '', tx.staffName].filter(Boolean).join(' · ') || tx.notes || '';
 const date = new Date(tx.createdAt).toLocaleDateString('fr-BE', { day: 'numeric', month: 'short' });
 return `<div class="tx-row"><div class="tx-icon" style="background:${t.bg}"><span class="material-symbols-rounded" style="color:${t.color}">${t.icon}</span></div><div class="tx-body"><div class="tx-top"><span class="tx-type">${t.label}</span><span class="tx-pts ${cls}">${sign}${tx.pointsDelta} pts</span></div><div class="tx-bot"><span class="tx-detail">${esc(detail)}</span><span class="tx-date">${date}</span></div></div></div>`;
 }).join('');
 }

 // ═══════════════════════════════════════════
 // GIFT SYSTEM
 // ═══════════════════════════════════════════

 function startGift() {
 if (!currentCard || !currentMerchant) return;
 if (currentCard.pointsBalance <= 0) { toast('Aucun point à offrir'); return; }
 document.getElementById('gift-confirm-pts').textContent = currentCard.pointsBalance;
 document.getElementById('gift-confirm-name').textContent = currentMerchant.name;
 openModal('modal-gift');
 }

 async function confirmGift() {
 if (!currentMerchant) return;
 const btn = document.getElementById('btn-confirm-gift');
 btn.classList.add('loading');
 btn.innerHTML = '<span>Génération…</span>';

 const res = await API.createGift(currentMerchant.id);
 btn.classList.remove('loading');
 btn.innerHTML = '<span class="material-symbols-rounded">card_giftcard</span><span>Générer le lien cadeau</span>';

 if (!res.ok) { toast(res.data?.error || 'Erreur'); return; }

 lastGiftLink = res.data.giftUrl;
 closeModal();

 currentCard.pointsBalance = 0;
 document.getElementById('cd-pts').textContent = '0';
 document.getElementById('cd-prog').style.width = '0%';
 document.getElementById('cd-badge').innerHTML = '<span class="cd-until">Encore ' + currentCard.pointsForReward + (currentMerchant && currentMerchant.loyaltyMode === 'visits' ? ' visites' : ' points') + '</span>';
 document.getElementById('btn-gift').classList.add('hidden');

 document.getElementById('gift-link').value = lastGiftLink;
 openModal('modal-gift-share');
 refreshCards();
 }

 function copyGiftLink() {
 navigator.clipboard.writeText(lastGiftLink).then(() => toast('Lien copié !')).catch(() => {
 const input = document.getElementById('gift-link');
 input.select(); document.execCommand('copy'); toast('Lien copié !');
 });
 }

 function shareGift(method) {
 const text = `Cadeau ! Je t'offre mes points fidélité chez ${currentMerchant?.name || 'un commerce'}. Ouvre ce lien pour les récupérer :`;
 const url = lastGiftLink;
 if (method === 'whatsapp') window.open(`https://wa.me/?text=${encodeURIComponent(text + '\n' + url)}`);
 else if (method === 'sms') window.open(`sms:?body=${encodeURIComponent(text + ' ' + url)}`);
 else if (navigator.share) navigator.share({ title: 'Cadeau FIDDO', text, url }).catch(() => {});
 else copyGiftLink();
 }

 async function handleGiftClaim(token) {
 show('screen-gift-claim');
 const loading = document.getElementById('gift-loading');
 const preview = document.getElementById('gift-preview');
 const done = document.getElementById('gift-done');
 const errorDiv = document.getElementById('gift-error');

 if (!API.hasSession()) {
 sessionStorage.setItem('fiddo_pending_gift', token);
 show('screen-login');
 toast('Connectez-vous pour récupérer votre cadeau');
 return;
 }

 const res = await API.getGift(token);
 loading.classList.add('hidden');

 if (!res.ok) {
 errorDiv.classList.remove('hidden');
 document.getElementById('gift-error-title').textContent = 'Lien invalide';
 document.getElementById('gift-error-msg').textContent = res.data?.error || 'Ce lien cadeau est expiré ou a déjà été utilisé.';
 return;
 }

 const gift = res.data;
 preview.classList.remove('hidden');
 document.getElementById('gift-title').textContent = 'Un cadeau pour vous !';
 document.getElementById('gift-sub').textContent = 'Quelqu\'un vous offre des points fidélité';
 document.getElementById('gift-amount').textContent = gift.points + ' pts';
 document.getElementById('gift-merchant').textContent = 'chez ' + gift.merchantName;

 const expDate = new Date(gift.expiresAt).toLocaleDateString('fr-BE', { day: 'numeric', month: 'long' });
 document.getElementById('gift-expires').textContent = 'Expire le ' + expDate;

 document.getElementById('btn-claim-gift').onclick = async () => {
 const btn = document.getElementById('btn-claim-gift');
 btn.classList.add('loading');
 btn.innerHTML = '<span>Récupération…</span>';
 const claimRes = await API.claimGift(token);
 if (!claimRes.ok) {
 btn.classList.remove('loading');
 btn.innerHTML = '<span class="material-symbols-rounded">downloading</span><span>Récupérer mes points</span>';
 toast(claimRes.data?.error || 'Erreur'); return;
 }
 preview.classList.add('hidden');
 done.classList.remove('hidden');
 document.getElementById('gift-done-msg').textContent = `${gift.points} points ajoutés chez ${gift.merchantName}`;
 const cardsRes = await API.getCards();
 if (cardsRes.ok) { client = cardsRes.data.client; cards = cardsRes.data.cards || []; }
 };
 }

 // ═══════════════════════════════════════════
 // PROFILE
 // ═══════════════════════════════════════════

 function loadProfile() {
 if (!client) return;
 const initial = (client.name || client.email || '?')[0].toUpperCase();
 document.getElementById('prof-avatar').textContent = initial;
 document.getElementById('prof-name').textContent = client.name || client.email || 'Sans nom';
 document.getElementById('prof-email').textContent = client.email || '—';

 const banner = document.getElementById('prof-complete');
 if (banner) banner.classList.toggle('hidden', !!client.name);

 const phoneRow = document.getElementById('prof-phone-row');
 if (client.phone) { phoneRow.classList.remove('hidden'); document.getElementById('prof-phone').textContent = client.phone; }
 else phoneRow.classList.add('hidden');

 const dobRow = document.getElementById('prof-dob-row');
 const dobText = document.getElementById('prof-dob');
 const dobAction = document.getElementById('prof-dob-action');
 if (client.dateOfBirth) {
 const [y, m, d] = client.dateOfBirth.split('-');
 const months = ['', 'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
 dobText.textContent = parseInt(d) + ' ' + months[parseInt(m)] + ' ' + y;
 dobText.style.color = '';
 dobAction.textContent = 'lock';
 dobAction.style.color = '#059669';
 dobRow.style.cursor = 'default';
 dobRow.onclick = null;
 } else {
 dobText.textContent = 'Ajouter votre date de naissance';
 dobText.style.color = 'var(--tx3)';
 dobAction.textContent = 'edit';
 dobAction.style.color = 'var(--tx3)';
 dobRow.style.cursor = 'pointer';
 dobRow.onclick = function() { App.editDob(); };
 }

 const hasPin = client.hasPin;
 document.getElementById('pin-label').textContent = hasPin ? 'PIN défini' : 'Aucun PIN défini';
 document.getElementById('pin-btn-label').textContent = hasPin ? 'Modifier mon PIN' : 'Créer un PIN';
 }

 async function loadNotifPrefs() {
 const res = await API.getNotifPrefs();
 if (!res.ok) return;
 if (res.data.notifCredit !== undefined) document.getElementById('notif-credit').checked = res.data.notifCredit;
 if (res.data.notifReward !== undefined) document.getElementById('notif-reward').checked = res.data.notifReward;
 if (res.data.notifPromo !== undefined) document.getElementById('notif-promo').checked = res.data.notifPromo;
 if (res.data.notifBirthday !== undefined) document.getElementById('notif-birthday').checked = res.data.notifBirthday;
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
 if (res.ok) { client.name = name; loadProfile(); renderCards(); closeModal(); toast('Nom mis à jour'); }
 else toast(res.data?.error || 'Erreur');
 }

 function editEmail() {
 document.getElementById('edit-email').value = client?.email || '';
 openModal('modal-email');
 setTimeout(() => document.getElementById('edit-email').focus(), 400);
 }

 async function saveEmail() {
 const email = document.getElementById('edit-email').value.trim().toLowerCase();
 if (!email || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/.test(email)) { toast('Email invalide'); return; }
 const res = await API.updateEmail(email);
 if (res.ok) { client.email = email; loadProfile(); closeModal(); toast('Email mis à jour'); }
 else if (res.status === 409 && res.data?.conflict) { toast(res.data.message || 'Demande de fusion envoyée'); closeModal(); }
 else toast(res.data?.error || 'Erreur');
 }

 // ─── BIRTHDAY ─────────────────────────────

 // Auto-format dd/mm/yyyy
 function _autoFmtDate(e) {
 var v = e.target.value.replace(/[^\d]/g, '');
 if (v.length > 8) v = v.substring(0, 8);
 if (v.length > 4) v = v.substring(0,2) + '/' + v.substring(2,4) + '/' + v.substring(4);
 else if (v.length > 2) v = v.substring(0,2) + '/' + v.substring(2);
 e.target.value = v;
 }
 function _parseBE(s) {
 if (!s || s.length !== 10) return null;
 var p = s.split('/'); if (p.length !== 3) return null;
 return p[2] + '-' + p[1] + '-' + p[0]; // YYYY-MM-DD
 }

 function editDob() {
 if (client?.dateOfBirth) { toast('La date de naissance ne peut pas être modifiée'); return; }
 document.getElementById('edit-dob').value = '';
 var el = document.getElementById('edit-dob');
 el.removeEventListener('input', _autoFmtDate);
 el.addEventListener('input', _autoFmtDate);
 openModal('modal-dob');
 }

 let _dobPendingConfirm = false;

 async function saveDob() {
 const raw = document.getElementById('edit-dob').value;
 if (!raw || raw.length !== 10) { toast('Entrez une date valide (jj/mm/aaaa)'); return; }
 const dob = _parseBE(raw); // YYYY-MM-DD for API
 if (!dob) { toast('Date invalide'); return; }

 if (!_dobPendingConfirm) {
 _dobPendingConfirm = true;
 const [y, m, d] = dob.split('-');
 const months = ['', 'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
 const formatted = parseInt(d) + ' ' + months[parseInt(m)] + ' ' + y;
 const sheet = document.querySelector('#modal-dob .modal-sheet');
 sheet.querySelector('h2').textContent = 'Confirmer votre date';
 sheet.querySelector('.modal-sub').innerHTML =
 '<div style="font-size:22px;font-weight:800;color:var(--tx);margin:12px 0">' + formatted + '</div>' +
 '<p style="font-size:13px;color:var(--tx2);line-height:1.6;margin:0">Pour éviter les abus, cette date <strong>ne pourra plus être modifiée</strong> par la suite. Un changement nécessitera une demande auprès du support.</p>';
 sheet.querySelector('.field').style.display = 'none';
 document.getElementById('btn-save-dob').innerHTML = '<span>Confirmer</span>';
 return;
 }

 // Actually save
 const res = await API.updateProfile({ dateOfBirth: dob });
 if (res.ok) {
 client.dateOfBirth = dob;
 loadProfile();
 _resetDobModal();
 closeModal();
 toast('Date de naissance enregistrée');
 } else {
 toast(res.data?.error || 'Erreur');
 }
 }

 function _resetDobModal() {
 _dobPendingConfirm = false;
 const sheet = document.querySelector('#modal-dob .modal-sheet');
 if (sheet) {
 sheet.querySelector('h2').textContent = 'Date de naissance';
 sheet.querySelector('.modal-sub').innerHTML = 'Renseignez-la pour recevoir une surprise le jour J. Cette information ne pourra plus être modifiée.';
 sheet.querySelector('.field').style.display = '';
 document.getElementById('btn-save-dob').innerHTML = '<span>Enregistrer</span>';
 }
 }

 // ─── PIN ──────────────────────────────────

 function openPinModal() {
 document.getElementById('pin-new').value = '';
 openModal('modal-pin');
 setTimeout(() => document.getElementById('pin-new').focus(), 400);
 }

 async function savePin() {
 const newPin = document.getElementById('pin-new').value.trim();
 if (!/^\d{4}$/.test(newPin)) { toast('Le PIN doit être 4 chiffres'); return; }
 const res = await API.call('/api/me/pin', { method: 'POST', body: { newPin } });
 if (res.ok) { client.hasPin = true; loadProfile(); closeModal(); toast('Code PIN enregistré'); }
 else toast(res.data?.error || 'Erreur');
 }

 // ─── My QR ────────────────────────────────

 async function showMyQR() {
 openModal('modal-qr');
 document.getElementById('qr-name').textContent = client?.name || '';
 const qrImg = document.getElementById('qr-img');
 qrImg.src = '';
 qrImg.alt = 'Chargement…';

 const res = await API.getQR();
 if (!res.ok) {
 const fallbackUrl = `https://www.fiddo.be/c/${client?.qrToken || 'unknown'}`;
 qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(fallbackUrl)}`;
 qrImg.alt = 'Mon QR code';
 return;
 }

 const qrUrl = res.data.qrUrl;

 if (typeof QRCode !== 'undefined' && QRCode.toDataURL) {
 try {
 const dataUrl = await QRCode.toDataURL(qrUrl, { width: 220, margin: 2, color: { dark: '#0f172a', light: '#ffffff' }, errorCorrectionLevel: 'H' });
 qrImg.src = dataUrl;
 qrImg.alt = 'Mon QR code';
 return;
 } catch (e) { console.error('QRCode lib error:', e); }
 }

 qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrUrl)}`;
 qrImg.alt = 'Mon QR code';
 }

 // ─── Scanner ──────────────────────────────

 async function startScanner() {
 const video = document.getElementById('scan-video');
 const noCam = document.getElementById('scan-no-cam');
 if (scannerStream) return;

 // Show loading state instead of black video with play button
 video.style.display = 'none';
 noCam.classList.remove('hidden');
 noCam.innerHTML = '<div style="text-align:center;padding:40px;color:#64748b"><div class="loader" style="margin:0 auto 16px"></div><p style="font-size:14px">Initialisation de la caméra…</p></div>';

 try {
 scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
 video.srcObject = scannerStream;
 video.setAttribute('playsinline', '');
 video.setAttribute('autoplay', '');
 video.muted = true;

 video.addEventListener('loadedmetadata', () => {
 video.play();
 // Only show video once actually playing
 video.addEventListener('playing', () => {
 video.style.display = 'block';
 noCam.classList.add('hidden');
 noCam.innerHTML = '';
 }, { once: true });
 }, { once: true });

 if ('BarcodeDetector' in window) {
 const detector = new BarcodeDetector({ formats: ['qr_code'] });
 scanInterval = setInterval(async () => {
 if (video.readyState < 2 || video.videoWidth === 0) return;
 try { const bc = await detector.detect(video); if (bc.length > 0) handleScan(bc[0].rawValue); } catch {}
 }, 300);
 } else if (typeof jsQR !== 'undefined') {
 const canvas = document.getElementById('scan-canvas');
 const ctx = canvas.getContext('2d', { willReadFrequently: true });
 scanInterval = setInterval(() => {
 if (video.readyState < 2 || video.videoWidth === 0) return;
 canvas.width = video.videoWidth;
 canvas.height = video.videoHeight;
 ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
 const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
 const code = jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
 if (code && code.data) handleScan(code.data);
 }, 300);
 } else {
 noCam.innerHTML = '<p style="text-align:center;padding:40px;color:#64748b">Scanner non disponible sur cet appareil</p>';
 noCam.classList.remove('hidden');
 }
 } catch (e) {
 noCam.innerHTML = '<p style="text-align:center;padding:40px;color:#64748b">Caméra indisponible.<br>Autorisez l\'accès à la caméra dans les réglages.</p>';
 noCam.classList.remove('hidden');
 }
 }

 function stopScanner() {
 if (scannerStream) { scannerStream.getTracks().forEach(t => t.stop()); scannerStream = null; }
 if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
 const video = document.getElementById('scan-video');
 if (video) { video.srcObject = null; video.style.display = 'none'; }
 }

 let scanBusy = false;
 function beep() {
 try {
 const ctx = new (window.AudioContext || window.webkitAudioContext)();
 const osc = ctx.createOscillator();
 const gain = ctx.createGain();
 osc.connect(gain);
 gain.connect(ctx.destination);
 osc.frequency.value = 1200;
 gain.gain.value = 0.3;
 osc.start();
 gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
 osc.stop(ctx.currentTime + 0.15);
 // Haptic feedback if available
 if (navigator.vibrate) navigator.vibrate(50);
 } catch (e) {}
 }

 async function handleScan(data) {
 if (scanBusy) return;

 const match = data.match(/\/q\/([a-zA-Z0-9_-]+)/);
 if (!match) { toast('QR non reconnu'); return; }

 beep();
 scanBusy = true;
 stopScanner();

 const merchantQrToken = match[1];
 toast('Identification en cours…');

 try {
 const res = await API.call('/api/qr/register', {
 method: 'POST',
 body: { qrToken: merchantQrToken, email: client?.email || '', phone: client?.phone || '', name: client?.name || '' },
 noAuth: true,
 });

 if (res.ok) {
 const name = res.data.clientName || client?.name || '';
 if (res.data.cached) {
 toast(`Déjà identifié il y a ${res.data.minutesAgo} min — re-crédit possible dans ${res.data.minutesLeft} min`);
 } else {
 const pts = res.data.pointsBalance != null ? ` (${res.data.pointsBalance} pts)` : '';
 toast(`${name} identifié${pts}`);
 }
 // Switch to cards tab — client is identified, nothing more to scan
 switchTab('cards');
 setTimeout(() => refreshCards(), 1500);
 } else {
 toast(res.data?.error || 'Erreur identification');
 }
 } catch (e) { toast('Erreur réseau'); }

 setTimeout(() => {
 scanBusy = false;
 if (document.querySelector('.tb.active')?.dataset.tab === 'scanner') startScanner();
 }, 3000);
 }

 // ─── Modals / Toast ───────────────────────

 function openModal(id) { document.getElementById(id).classList.add('open'); }
 function closeModal() { document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open')); _resetDobModal(); }

 let toastTimer = null;
 function toast(msg) {
 const el = document.getElementById('toast');
 if (toastTimer) clearTimeout(toastTimer);
 el.classList.remove('show');
 void el.offsetWidth;
 el.textContent = msg;
 el.classList.add('show');
 toastTimer = setTimeout(() => { el.classList.remove('show'); toastTimer = null; }, 2500);
 }

 // ─── Helpers ──────────────────────────────

 // ─── Points Polling (detect changes) ───────

 function startPointsPolling() {
 stopPointsPolling();
 pointsPollTimer = setInterval(() => refreshCards(), 5000);
 }

 function stopPointsPolling() {
 if (pointsPollTimer) { clearInterval(pointsPollTimer); pointsPollTimer = null; }
 }

 // ─── Animation overlay ─────────────────────

 function successSound() {
 try {
 const ctx = new (window.AudioContext || window.webkitAudioContext)();
 const osc = ctx.createOscillator();
 const gain = ctx.createGain();
 osc.connect(gain);
 gain.connect(ctx.destination);
 osc.frequency.value = 800;
 gain.gain.value = 0.25;
 osc.start();
 // Rising tone
 osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.15);
 gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
 osc.stop(ctx.currentTime + 0.3);
 if (navigator.vibrate) navigator.vibrate([50, 50, 100]);
 } catch (e) {}
 }

 function showAnimation(type, text, sub) {
 const overlay = document.getElementById('anim-overlay');
 const iconEl = document.getElementById('anim-icon');
 const textEl = document.getElementById('anim-text');
 const subEl = document.getElementById('anim-sub');
 const particlesEl = document.getElementById('anim-particles');

 overlay.classList.remove('hidden');
 void overlay.offsetWidth;
 overlay.classList.add('show');

 iconEl.className = 'anim-icon ' + type;
 iconEl.innerHTML = type === 'credit'
 ? '<span class="material-symbols-rounded" style="font-size:48px">add_circle</span>'
 : '<span class="material-symbols-rounded" style="font-size:48px">redeem</span>';
 textEl.textContent = text;
 subEl.textContent = sub;
 successSound();

 // Spawn particles
 particlesEl.innerHTML = '';
 const colors = type === 'credit' ? ['#34d399', '#6ee7b7', '#a7f3d0', '#10b981'] : ['#fbbf24', '#fcd34d', '#fde68a', '#f59e0b'];
 for (let i = 0; i < 20; i++) {
 const p = document.createElement('div');
 p.className = 'anim-particle';
 p.style.background = colors[i % colors.length];
 p.style.left = '50%';
 p.style.top = '50%';
 p.style.setProperty('--dx', (Math.random() - 0.5) * 300 + 'px');
 p.style.setProperty('--dy', (Math.random() - 0.5) * 400 + 'px');
 p.style.animationDelay = (Math.random() * 0.3) + 's';
 particlesEl.appendChild(p);
 }

 // Auto-dismiss after 2.5s
 setTimeout(() => {
 overlay.classList.remove('show');
 setTimeout(() => overlay.classList.add('hidden'), 300);
 }, 2500);
 }

 // ─── Delete Account ────────────────────────

 function confirmDeleteAccount() {
 openModal('modal-delete');
 }

 async function deleteAccount() {
 const btn = document.getElementById('btn-confirm-delete');
 btn.disabled = true;
 btn.innerHTML = '<span class="material-symbols-rounded">hourglass_top</span>Suppression…';

 try {
 const res = await API.call('/api/me/account', { method: 'DELETE' });
 if (res.ok) {
 closeModal();
 toast('Compte supprimé. Un email de confirmation a été envoyé.');
 setTimeout(() => {
 API.clearToken();
 client = null;
 cards = [];
 clearCardStates();
 stopPointsPolling();
 show('screen-login');
 }, 2000);
 } else {
 toast(res.data?.error || 'Erreur lors de la suppression');
 btn.disabled = false;
 btn.innerHTML = '<span class="material-symbols-rounded">delete_forever</span>Supprimer';
 }
 } catch (e) {
 toast('Erreur réseau');
 btn.disabled = false;
 btn.innerHTML = '<span class="material-symbols-rounded">delete_forever</span>Supprimer';
 }
 }

 // ─── Helpers (date/esc) ────────────────────

 function relDate(d) {
 const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
 if (days === 0) return "Aujourd'hui";
 if (days === 1) return 'Hier';
 if (days < 7) return `Il y a ${days}j`;
 if (days < 30) return `Il y a ${Math.floor(days / 7)} sem.`;
 return `Il y a ${Math.floor(days / 30)} mois`;
 }

 function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

 // ─── Boot ─────────────────────────────────

 document.addEventListener('DOMContentLoaded', () => {
 document.getElementById('btn-login').addEventListener('click', handleLogin);
 document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
 document.getElementById('btn-resend').addEventListener('click', resendLogin);
 document.getElementById('btn-change-email').addEventListener('click', resetLogin);
 document.getElementById('btn-save-name').addEventListener('click', saveName);
 document.getElementById('edit-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });
 document.getElementById('btn-save-email').addEventListener('click', saveEmail);
 document.getElementById('edit-email').addEventListener('keydown', e => { if (e.key === 'Enter') saveEmail(); });
 document.getElementById('btn-save-dob').addEventListener('click', saveDob);
 document.getElementById('btn-confirm-gift').addEventListener('click', confirmGift);
 document.getElementById('search-input').addEventListener('input', handleSearch);
 document.querySelectorAll('.notif-row input').forEach(el => el.addEventListener('change', saveNotifs));

 let startY = 0;
 let startScrollTop = 0;
 const scroll = document.getElementById('cards-scroll');
 if (scroll) {
 scroll.addEventListener('touchstart', e => { startY = e.touches[0].pageY; startScrollTop = scroll.scrollTop; });
 scroll.addEventListener('touchend', e => {
 // Only trigger if started AND ended at scroll top, with a strong pull (>150px)
 if (startScrollTop === 0 && scroll.scrollTop === 0 && e.changedTouches[0].pageY - startY > 150) { refreshCards(); toast('Actualisation…'); }
 });
 }

 init();
 });

 return {
 handleLogin, resendLogin, resetLogin,
 show, goBack, switchTab, showApp,
 openCard, showHistory, openMaps,
 showMyQR, editName, saveName, editEmail, saveEmail,
 editDob, saveDob,
 openPinModal, savePin,
 startScanner, closeModal,
 logout, saveNotifs, toast,
 filterType, clearSearch, toggleFav, hideCard,
    showHiddenCards, unhideCard,
 startGift, confirmGift, copyGiftLink, shareGift,
 confirmDeleteAccount, deleteAccount,
 };
})();
