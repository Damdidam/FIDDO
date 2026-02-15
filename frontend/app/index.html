<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#3b82f6">
  <title>FIDDO</title>
  <link rel="manifest" href="/app/manifest.json">
  <link rel="icon" type="image/png" sizes="192x192" href="/app/assets/icon-192.png">
  <link rel="apple-touch-icon" href="/app/assets/icon-192.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/app/css/app.css">
</head>
<body>

  <!-- ═══ LOGIN / ONBOARDING — email only ═══ -->
  <div id="screen-login" class="screen active">
    <div class="login-bg"><div class="login-orb orb-1"></div><div class="login-orb orb-2"></div><div class="login-orb orb-3"></div></div>
    <div class="login-content">
      <div class="login-logo"><span>F</span></div>
      <h1 class="login-title">FIDDO</h1>
      <p class="login-tagline">Vos cartes fidélité, simplifiées</p>
      <div id="login-form" class="login-form">
        <div class="field">
          <span class="material-symbols-rounded field-icon">mail</span>
          <input type="email" id="login-email" placeholder="Votre adresse email" autocomplete="email" inputmode="email">
        </div>
        <button class="btn-primary" id="btn-login">
          <span>Continuer</span>
          <span class="material-symbols-rounded">east</span>
        </button>
        <p class="login-hint">Nouveau ou déjà inscrit ? Un lien sécurisé vous sera envoyé</p>
      </div>
      <div id="login-sent" class="login-sent hidden">
        <div class="sent-anim"><span class="material-symbols-rounded">mark_email_read</span></div>
        <h2>Vérifiez vos emails</h2>
        <p class="sent-email" id="sent-email"></p>
        <p>Cliquez sur le lien reçu pour activer votre compte</p>
        <p class="sent-hint">Pensez à vérifier vos spams</p>
        <button class="btn-secondary" id="btn-resend"><span class="material-symbols-rounded">refresh</span>Renvoyer</button>
        <a class="link-muted" id="btn-change-email">Changer d'email</a>
      </div>
    </div>
  </div>

  <!-- ═══ VERIFY ═══ -->
  <div id="screen-verify" class="screen">
    <div class="center-col">
      <div class="loader"></div>
      <h2>Connexion en cours…</h2>
      <p id="verify-error" class="error-text hidden"></p>
      <button class="btn-secondary solid hidden" id="verify-retry" onclick="App.show('screen-login')">
        <span class="material-symbols-rounded">arrow_back</span>Retour
      </button>
    </div>
  </div>

  <!-- ═══ GIFT CLAIM ═══ -->
  <div id="screen-gift-claim" class="screen">
    <div class="center-col">
      <div id="gift-loading">
        <div class="loader"></div>
        <h2>Chargement du cadeau…</h2>
      </div>
      <div id="gift-preview" class="hidden">
        <div class="gift-box"><span class="material-symbols-rounded">redeem</span></div>
        <h2 id="gift-title"></h2>
        <p id="gift-sub" class="gift-sub"></p>
        <div class="gift-amount" id="gift-amount"></div>
        <p class="gift-merchant" id="gift-merchant"></p>
        <p class="gift-expires" id="gift-expires"></p>
        <button class="btn-primary" id="btn-claim-gift" style="margin-top:24px;width:280px">
          <span class="material-symbols-rounded">downloading</span>
          <span>Récupérer mes points</span>
        </button>
      </div>
      <div id="gift-done" class="hidden">
        <div class="gift-box ok"><span class="material-symbols-rounded">check_circle</span></div>
        <h2>Cadeau récupéré !</h2>
        <p id="gift-done-msg" class="gift-sub"></p>
        <button class="btn-primary" style="margin-top:24px;width:240px" onclick="App.showApp()">
          <span class="material-symbols-rounded">loyalty</span>
          <span>Voir mes cartes</span>
        </button>
      </div>
      <div id="gift-error" class="hidden">
        <div class="gift-box err"><span class="material-symbols-rounded">error</span></div>
        <h2 id="gift-error-title">Lien invalide</h2>
        <p id="gift-error-msg" class="gift-sub"></p>
        <button class="btn-primary" style="margin-top:24px;width:240px" onclick="App.show('screen-login')">
          <span class="material-symbols-rounded">arrow_back</span>
          <span>Retour</span>
        </button>
      </div>
    </div>
  </div>

  <!-- ═══ ONBOARDING (removed — email-only flow, profile completion is optional via Profile tab) ═══ -->

  <!-- ═══ MAIN APP ═══ -->
  <div id="screen-app" class="screen">

    <!-- Tab: Cards -->
    <div id="tab-cards" class="tab active">
      <div class="tab-head">
        <h1 id="greeting">Bonjour 👋</h1>
        <p class="sub" id="greeting-sub">Vos cartes fidélité</p>
        <div class="search-bar">
          <span class="material-symbols-rounded">search</span>
          <input type="text" id="search-input" placeholder="Rechercher un commerce…">
          <button class="search-clear hidden" id="search-clear" onclick="App.clearSearch()">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
        <div class="filter-row" id="filter-row"></div>
      </div>
      <div class="tab-body" id="cards-scroll">
        <div id="cards-list"></div>
        <div id="cards-empty" class="empty hidden">
          <span class="material-symbols-rounded">credit_card_off</span>
          <h3>Aucune carte</h3>
          <p>Scannez un QR code chez un commerçant pour commencer à cumuler des points</p>
        </div>
        <div id="cards-no-result" class="empty hidden">
          <span class="material-symbols-rounded">search_off</span>
          <h3>Aucun résultat</h3>
          <p>Essayez un autre terme de recherche</p>
        </div>
      </div>
    </div>

    <!-- Tab: Scanner -->
    <div id="tab-scanner" class="tab">
      <div class="scanner-wrap">
        <video id="scan-video" autoplay playsinline muted></video>
        <canvas id="scan-canvas" style="display:none;"></canvas>
        <div class="scan-ui">
          <div style="text-align:center">
            <h2>Scanner un QR</h2>
            <p>Pointez vers le QR du commerçant</p>
          </div>
          <div class="scan-frame">
            <div class="c tl"></div><div class="c tr"></div><div class="c bl"></div><div class="c br"></div>
            <div class="scan-beam"></div>
          </div>
          <button class="btn-glass" onclick="App.showMyQR()">
            <span class="material-symbols-rounded">qr_code_2</span>
            Mon QR code
          </button>
        </div>
        <div class="scan-no-cam hidden" id="scan-no-cam">
          <span class="material-symbols-rounded">no_photography</span>
          <h3>Caméra indisponible</h3>
          <p>Autorisez l'accès à la caméra dans les réglages de votre navigateur</p>
          <button class="btn-primary" style="width:200px" onclick="App.startScanner()">Réessayer</button>
        </div>
      </div>
    </div>

    <!-- Tab: Profile -->
    <div id="tab-profile" class="tab">
      <div class="tab-head"><h1>Profil</h1></div>
      <div class="tab-body">
        <!-- Profile completion prompt (shown if no name) -->
        <div id="prof-complete" class="prof-complete hidden">
          <span class="material-symbols-rounded" style="font-size:20px;color:var(--pri)">tips_and_updates</span>
          <div>
            <strong>Complétez votre profil</strong>
            <p style="font-size:12px;color:var(--tx2);margin-top:2px">Ajoutez votre nom pour être reconnu chez les commerçants</p>
          </div>
          <button class="btn-icon" onclick="App.editName()" style="margin-left:auto"><span class="material-symbols-rounded">east</span></button>
        </div>

        <div class="prof-card">
          <div class="prof-avatar" id="prof-avatar">?</div>
          <div class="prof-name-row">
            <h2 id="prof-name">—</h2>
            <button class="btn-icon" onclick="App.editName()"><span class="material-symbols-rounded">edit</span></button>
          </div>
          <div class="prof-info">
            <div class="prof-row" onclick="App.editEmail()" style="cursor:pointer">
              <span class="material-symbols-rounded">mail</span>
              <span id="prof-email">—</span>
              <span class="material-symbols-rounded" style="font-size:16px;color:var(--tx3)">edit</span>
            </div>
            <div class="prof-row hidden" id="prof-phone-row">
              <span class="material-symbols-rounded">phone</span>
              <span id="prof-phone">—</span>
            </div>
            <div class="prof-row hidden" id="prof-dob-row">
              <span class="material-symbols-rounded">cake</span>
              <span id="prof-dob">—</span>
            </div>
          </div>
        </div>

        <!-- PIN -->
        <div class="prof-card" style="text-align:left">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <span class="material-symbols-rounded" style="font-size:22px;color:var(--pri)">pin</span>
            <h3 style="font-size:16px;font-weight:700">Mon code PIN</h3>
          </div>
          <p style="font-size:13px;color:var(--tx2);line-height:1.5;margin-bottom:14px">
            À donner chez le commerçant si vous oubliez votre smartphone
          </p>
          <div id="pin-status">
            <p style="font-size:13px;color:var(--tx3)" id="pin-label">Aucun PIN défini</p>
          </div>
          <button class="btn-primary" style="height:44px;font-size:14px;margin-top:12px" onclick="App.openPinModal()">
            <span class="material-symbols-rounded" style="font-size:18px">lock</span>
            <span id="pin-btn-label">Créer un PIN</span>
          </button>
        </div>

        <!-- Notifications -->
        <h3 class="sec-title" style="margin-top:8px">Notifications</h3>
        <div class="notif-card">
          <label class="notif-row"><span class="material-symbols-rounded">add_circle</span><span>Crédit de points</span><input type="checkbox" id="notif-credit" checked><span class="tog"></span></label>
          <label class="notif-row"><span class="material-symbols-rounded">redeem</span><span>Récompense disponible</span><input type="checkbox" id="notif-reward" checked><span class="tog"></span></label>
          <label class="notif-row"><span class="material-symbols-rounded">campaign</span><span>Promotions</span><input type="checkbox" id="notif-promo"><span class="tog"></span></label>
          <label class="notif-row last"><span class="material-symbols-rounded">cake</span><span>Anniversaire</span><input type="checkbox" id="notif-birthday" checked><span class="tog"></span></label>
        </div>

        <!-- QR code -->
        <button class="menu-row" onclick="App.showMyQR()">
          <span class="material-symbols-rounded mi">qr_code_2</span>
          <span class="ml">Mon QR code</span>
          <span class="material-symbols-rounded ma">chevron_right</span>
        </button>

        <button class="btn-danger" onclick="App.logout()">
          <span class="material-symbols-rounded">logout</span>Déconnexion
        </button>
        <p class="version">FIDDO v4.2</p>
      </div>
    </div>

    <!-- Tab bar -->
    <nav class="tbar">
      <button class="tb active" data-tab="cards" onclick="App.switchTab('cards')">
        <span class="material-symbols-rounded">loyalty</span><small>Cartes</small>
      </button>
      <button class="tb" data-tab="scanner" onclick="App.switchTab('scanner')">
        <span class="material-symbols-rounded">qr_code_scanner</span><small>Scanner</small>
      </button>
      <button class="tb" data-tab="profile" onclick="App.switchTab('profile')">
        <span class="material-symbols-rounded">person</span><small>Profil</small>
      </button>
    </nav>
  </div>

  <!-- ═══ CARD DETAIL ═══ -->
  <div id="screen-card" class="screen slide-r">
    <div class="card-hero theme-navy" id="card-hero">
      <div class="card-hero-top">
        <button class="btn-back" onclick="App.goBack()"><span class="material-symbols-rounded">arrow_back</span></button>
        <button class="btn-fav" onclick="App.toggleFav()"><span class="material-symbols-rounded" id="fav-icon">star_outline</span></button>
      </div>
      <h1 id="cd-name"></h1>
      <p class="cd-type" id="cd-type"></p>
      <div class="cd-pts">
        <span class="cd-pts-big" id="cd-pts">0</span>
        <span class="cd-pts-tot" id="cd-pts-tot">/ 100 pts</span>
      </div>
      <div class="prog-lg"><div class="prog-fill" id="cd-prog" style="width:0%"></div></div>
      <div id="cd-badge"></div>
    </div>
    <div class="card-body" id="card-body">
      <div class="stats-row">
        <div class="stat"><span class="material-symbols-rounded">storefront</span><strong id="cd-visits">0</strong><small>Visites</small></div>
        <div class="stat"><span class="material-symbols-rounded">payments</span><strong id="cd-spent">0€</strong><small>Dépensé</small></div>
        <div class="stat"><span class="material-symbols-rounded">speed</span><strong id="cd-ratio">1</strong><small>pts/€</small></div>
      </div>

      <p class="cd-desc" id="cd-desc"></p>

      <button class="menu-row" onclick="App.showHistory()">
        <span class="material-symbols-rounded mi">receipt_long</span>
        <span class="ml">Historique</span>
        <span class="material-symbols-rounded ma">chevron_right</span>
      </button>

      <button class="menu-row gift-row hidden" id="btn-gift" onclick="App.startGift()">
        <span class="material-symbols-rounded mi" style="color:var(--rew)">card_giftcard</span>
        <span class="ml">Offrir mes points</span>
        <span class="material-symbols-rounded ma">chevron_right</span>
      </button>

      <button class="menu-row" id="btn-maps" onclick="App.openMaps()">
        <span class="material-symbols-rounded mi">map</span>
        <span class="ml">Itinéraire</span>
        <span class="material-symbols-rounded ma">open_in_new</span>
      </button>

      <h3 class="sec-title">Infos</h3>
      <div class="info-card" id="cd-info"></div>

      <div id="cd-hours-wrap" class="hidden">
        <h3 class="sec-title">Horaires</h3>
        <div class="info-card" id="cd-hours"></div>
      </div>
    </div>
  </div>

  <!-- ═══ HISTORY ═══ -->
  <div id="screen-history" class="screen slide-r">
    <div class="sheet-head">
      <button class="btn-back-dark" onclick="App.goBack()"><span class="material-symbols-rounded">arrow_back</span></button>
      <h1>Historique</h1>
      <span class="badge" id="hist-count"></span>
    </div>
    <div class="hist-list" id="hist-list"></div>
  </div>

  <!-- ═══ MODALS ═══ -->

  <!-- QR Modal — uses <img> not <canvas> -->
  <div id="modal-qr" class="modal" onclick="App.closeModal()">
    <div class="modal-bg"></div>
    <div class="modal-sheet" onclick="event.stopPropagation()">
      <div class="modal-pill"></div>
      <button class="modal-x" onclick="App.closeModal()"><span class="material-symbols-rounded">close</span></button>
      <h2>Mon QR code</h2>
      <p class="modal-sub">À présenter au commerçant</p>
      <div class="qr-wrap">
        <img id="qr-img" width="220" height="220" alt="QR code" style="border-radius:8px">
        <p class="qr-name" id="qr-name"></p>
      </div>
    </div>
  </div>

  <!-- Edit Name Modal -->
  <div id="modal-edit" class="modal" onclick="App.closeModal()">
    <div class="modal-bg"></div>
    <div class="modal-sheet sm" onclick="event.stopPropagation()">
      <div class="modal-pill"></div>
      <h2>Modifier le nom</h2>
      <p class="modal-sub">Votre nom affiché chez les commerçants</p>
      <div class="field solid-field" style="margin-bottom:16px">
        <span class="material-symbols-rounded field-icon">person</span>
        <input type="text" id="edit-name" placeholder="Prénom et nom">
      </div>
      <button class="btn-primary" id="btn-save-name"><span>Enregistrer</span></button>
    </div>
  </div>

  <!-- Edit Email Modal -->
  <div id="modal-email" class="modal" onclick="App.closeModal()">
    <div class="modal-bg"></div>
    <div class="modal-sheet sm" onclick="event.stopPropagation()">
      <div class="modal-pill"></div>
      <h2>Modifier l'email</h2>
      <p class="modal-sub">L'email utilisé pour la connexion</p>
      <div class="field solid-field" style="margin-bottom:16px">
        <span class="material-symbols-rounded field-icon">mail</span>
        <input type="email" id="edit-email" placeholder="Nouvel email" inputmode="email">
      </div>
      <button class="btn-primary" id="btn-save-email"><span>Enregistrer</span></button>
    </div>
  </div>

  <!-- PIN Modal -->
  <div id="modal-pin" class="modal" onclick="App.closeModal()">
    <div class="modal-bg"></div>
    <div class="modal-sheet sm" onclick="event.stopPropagation()">
      <div class="modal-pill"></div>
      <h2 id="pin-modal-title">Créer un code PIN</h2>
      <p class="modal-sub">4 chiffres, à communiquer au commerçant si besoin</p>
      <div id="pin-current-wrap" class="hidden" style="margin-bottom:12px">
        <div class="field solid-field">
          <span class="material-symbols-rounded field-icon">lock_open</span>
          <input type="tel" id="pin-current" placeholder="PIN actuel" maxlength="4" inputmode="numeric" pattern="[0-9]*">
        </div>
      </div>
      <div class="field solid-field" style="margin-bottom:16px">
        <span class="material-symbols-rounded field-icon">lock</span>
        <input type="tel" id="pin-new" placeholder="Nouveau PIN (4 chiffres)" maxlength="4" inputmode="numeric" pattern="[0-9]*">
      </div>
      <button class="btn-primary" id="btn-save-pin" onclick="App.savePin()"><span>Enregistrer</span></button>
    </div>
  </div>

  <!-- Gift Confirm Modal -->
  <div id="modal-gift" class="modal" onclick="App.closeModal()">
    <div class="modal-bg"></div>
    <div class="modal-sheet" onclick="event.stopPropagation()">
      <div class="modal-pill"></div>
      <button class="modal-x" onclick="App.closeModal()"><span class="material-symbols-rounded">close</span></button>
      <h2>Offrir mes points</h2>
      <p class="modal-sub">Générez un lien à partager</p>
      <div class="gift-confirm-card">
        <div class="gift-confirm-pts" id="gift-confirm-pts">0</div>
        <p class="gift-confirm-label">points chez <strong id="gift-confirm-name"></strong></p>
      </div>
      <p class="gift-warn">⚠️ Tous vos points seront transférés. Le destinataire aura 7 jours pour les récupérer.</p>
      <button class="btn-primary" id="btn-confirm-gift">
        <span class="material-symbols-rounded">card_giftcard</span>
        <span>Générer le lien cadeau</span>
      </button>
    </div>
  </div>

  <!-- Gift Share Modal -->
  <div id="modal-gift-share" class="modal" onclick="App.closeModal()">
    <div class="modal-bg"></div>
    <div class="modal-sheet" onclick="event.stopPropagation()">
      <div class="modal-pill"></div>
      <button class="modal-x" onclick="App.closeModal()"><span class="material-symbols-rounded">close</span></button>
      <div class="gift-box" style="margin:0 auto 16px"><span class="material-symbols-rounded">check_circle</span></div>
      <h2>Lien généré !</h2>
      <p class="modal-sub">Partagez-le avec la personne de votre choix</p>
      <div class="gift-link-box">
        <input type="text" class="gift-link-input" id="gift-link" readonly>
        <button class="btn-copy" onclick="App.copyGiftLink()"><span class="material-symbols-rounded">content_copy</span></button>
      </div>
      <div class="gift-share-btns">
        <button class="btn-share whatsapp" onclick="App.shareGift('whatsapp')"><span class="material-symbols-rounded">chat</span>WhatsApp</button>
        <button class="btn-share sms" onclick="App.shareGift('sms')"><span class="material-symbols-rounded">sms</span>SMS</button>
        <button class="btn-share generic" onclick="App.shareGift('share')"><span class="material-symbols-rounded">share</span>Autre</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js"></script>
  <script src="/app/js/api.js"></script>
  <script src="/app/js/app.js"></script>
</body>
</html>
