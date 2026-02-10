# FIDDO 🐕

**Programme de fidélité multi-tenant pour restaurateurs belges**

FIDDO permet aux restaurants, cafés et commerces de proximité de gérer un programme de fidélité par points — sans app à installer côté client, sans matériel spécifique. Une interface web simple, pensée pour un usage en caisse.

🌐 **[fiddo.be](https://www.fiddo.be)**

---

## Concept

Le restaurateur crédite des points à chaque passage client. Quand le seuil est atteint, le client bénéficie d'une récompense (boisson offerte, réduction, dessert…). Tout se fait depuis le navigateur, sur téléphone ou tablette en caisse.

---

## Fonctionnalités

### 🎯 Gestion des points

- **Crédit automatique** : saisie du montant dépensé → calcul automatique des points selon le ratio configuré (ex: 1 pt/€)
- **Récompense** : déduction automatique quand le seuil est atteint, avec animation de célébration 🎉
- **Récompense personnalisée** : possibilité de définir une récompense custom par client (ex: "Café offert" pour un habitué, au lieu de la récompense par défaut du commerce)
- **Ajustement manuel** : correction de points par le manager/propriétaire avec raison obligatoire
- **Idempotence** : protection contre les double-crédits via clé d'idempotence unique par transaction

### 📱 QR Code — Identification client multilingue

Pour les restaurateurs avec une clientèle internationale ou une barrière de langue :
- Un **QR code dynamique** s'affiche en caisse sur la page de crédit (toggle inline Email / Téléphone / QR)
- Le client le scanne avec son téléphone et remplit ses coordonnées sur un formulaire public
- **6 langues** supportées : 🇫🇷 Français, 🇬🇧 English, 🇳🇱 Nederlands, 🇹🇷 Türkçe, 🇨🇳 中文, 🇸🇦 العربية
- Le formulaire du caissier se pré-remplit automatiquement en temps réel (polling)
- Le formulaire affiche le **nom et le thème couleur** du commerce

### ⌨️ Identification classique

- Saisie par **email ou téléphone** avec toggle
- **Autocomplete** sur les clients existants (recherche partielle)
- **Détection de fautes de frappe** sur les domaines email (gmial.com → gmail.com)
- **Lookup en temps réel** : affiche le solde actuel, le nombre de visites et la progression vers la récompense

### 👥 Multi-tenant

- Chaque commerce a ses propres clients, points, paramètres et récompenses
- Les données sont **isolées par merchant** : un caissier ne voit que les clients de son commerce
- Un même client (identifié par email/téléphone) peut être fidélisé dans **plusieurs commerces** indépendamment
- Système d'**aliases** pour les identifiants post-fusion de doublons

### 🔑 Rôles et permissions

| Rôle | Créditer | Voir clients | Paramètres | Gérer équipe |
|------|----------|-------------|------------|-------------|
| **Caissier** | ✅ (max 200€) | ❌ | ❌ | ❌ |
| **Manager** | ✅ | ✅ | ❌ | ❌ |
| **Propriétaire** | ✅ | ✅ | ✅ | ✅ |

### 📊 Dashboard

- **Statistiques** : nombre de clients, clients actifs (30 jours), points distribués, récompenses réclamées
- **Activité récente** : tableau triable (colonnes cliquables avec flèches ↕) avec détails staff, type de transaction, timestamp
- **Paramètres de fidélité** (propriétaire) : points/euro, seuil de récompense, description récompense

### 👤 Gestion des clients

- **Liste complète** avec cards : points, visites, dernière visite, badges (actif/inactif, bloqué, email validé)
- **Colonne Récompense** dédiée : affiche la récompense custom ⭐ ou la récompense par défaut
- **Recherche** par email, téléphone ou nom
- **Fiche client détaillée** (modal) :
  - Hero header avec gradient
  - Stats (points, dépensé, visites, ancienneté)
  - Reward card avec barre de progression
  - Banner cliquable pour réclamer la récompense avec **célébration animée** (confettis + overlay)
  - Historique des transactions en timeline (credit, reward, adjustment, merge)
  - Toolbar d'actions centrée
- **Actions** :
  - Bloquer / débloquer un client
  - Ajuster les points (positif ou négatif, raison obligatoire)
  - Définir / supprimer une récompense personnalisée
  - Notes privées par client
  - Renvoi email de validation
  - Crédit rapide (redirige vers `/credit` avec pré-remplissage URL)
  - Suppression RGPD (soft-delete avec anonymisation complète)
- **Export CSV** de la liste clients complète

### ⚙️ Préférences

Page préférences avec **sidebar navigation** et 5 sections :
- **🎨 Apparence** : 7 thèmes couleur (Teal, Indigo, Rose, Amber, Emerald, Slate, Violet) — changement instantané, persisté en base
- **🔔 Notifications** : toggles pour email crédits, nouveaux clients, récompenses
- **🏪 Commerce** : édition nom, adresse, TVA, email, téléphone — notification email au super admin à chaque modification
- **🔒 Sécurité** : changement de mot de passe (ancien + nouveau + confirmation)
- **💾 Backup** : export/import JSON complet des données (clients, transactions, points, CA) avec zone drag-and-drop et preview avant import

### 🏢 Super Admin

- **Validation / refus** des inscriptions commerces (avec motif de refus)
- **Suspension / réactivation** avec désactivation automatique des comptes staff
- **Vue globale** : nombre de commerces, actifs, en attente, clients, CA total
- **Onglets** : En attente / Actifs / Tous
- **Détail par commerce** (modal) : stats, infos, équipe complète, actions contextuelles
- **Fusion de doublons** clients (identifiants post-merge via aliases, traçabilité complète)

### ✉️ Emails transactionnels (Brevo SMTP)

- **Validation du compte client** : lien de confirmation pour activer les notifications
- **Points crédités** : notification avec barre de progression et détail récompense
- **Commerce validé** : email d'activation avec lien de connexion
- **Commerce refusé** : email avec motif de refus
- **Modification commerce** : notification au super admin
- Tous les emails sont **fire-and-forget** : un échec SMTP ne bloque jamais l'opération métier
- DNS configuré : **SPF + DKIM (Brevo) + DMARC**

### 🔐 Sécurité

- Authentification **JWT via cookies HTTP-only** (SameSite, Secure en production)
- **Protection brute force** : verrouillage après 5 tentatives pendant 15 minutes
- **Audit trail immutable** : chaque action est tracée (IP, user-agent, request ID corrélé)
- **Normalisation stricte** : email lowercase, téléphone E.164 (+32 par défaut), TVA belge BE0XXXXXXXXX
- Sessions différenciées : 8h caissier, 7 jours manager/propriétaire, 24h super admin
- Messages d'erreur structurés (codes erreur + hints UX) sans fuite d'information
- Le `merchant_id` vient **toujours du JWT**, jamais du body — impossible de créditer pour un autre commerce

### 🎨 Interface & UX

- **Login split-screen** : brand panel animé (gradient, orbe lumineux, features list) + formulaire avec alertes persistantes et contextuelles
- **Design mobile-first** responsive (navbar collapse, grids adaptatifs)
- **Animations** : célébration récompense (confettis + backdrop), pulse reward banner, spinner chargement
- **Navbar dynamique** selon le rôle (caissier → crédit uniquement, manager → dashboard + clients, owner → tout)
- **Thèmes** personnalisables par commerce (7 palettes, appliqué partout y compris QR client-form)
- **Alertes UX** : messages d'erreur persistants, hints contextuels, redirections intelligentes

---

## Stack technique

| Composant | Technologie |
|-----------|------------|
| Backend | Node.js 18+ / Express 4 |
| Base de données | SQLite (better-sqlite3) — WAL mode, foreign keys |
| Auth | JWT (jsonwebtoken) + bcryptjs |
| Email | Nodemailer + Brevo SMTP relay |
| Frontend | HTML / CSS / JS vanilla — zéro framework, zéro build |
| QR | qrcodejs (CDN) |
| Hébergement | Render (web service) |
| Domaine | OVHcloud (fiddo.be) |
| DNS | SPF + DKIM + DMARC |

---

## Structure du projet

```
backend/
├── server.js                  # Point d'entrée Express, routes HTML
├── database.js                # Schema SQLite + migrations + prepared statements
├── package.json
├── .env.example
├── routes/
│   ├── auth.js                # Login, register, settings, password, merchant-info
│   ├── clients.js             # Credit, reward, adjust, lookup, search, block, export
│   ├── qr.js                  # Sessions QR code (in-memory polling)
│   ├── preferences.js         # Thèmes, notifications, backup export/import
│   └── admin/
│       ├── auth.js            # Super admin login/setup/verify
│       └── merchants.js       # Validation, suspension, stats globales
├── middleware/
│   ├── auth.js                # JWT staff + brute force + roles
│   ├── admin-auth.js          # JWT super admin
│   └── audit.js               # Audit trail immutable + request ID
├── services/
│   ├── points.js              # Logique métier (credit, redeem, adjust)
│   ├── normalizer.js          # Email, phone, TVA normalization
│   ├── email.js               # Templates email + transport Brevo SMTP
│   └── backup.js              # Export/import JSON backup

frontend/
├── index.html                 # Login split-screen / inscription commerce
├── credit.html                # Page caissier (crédit + QR + récompense)
├── clients.html               # Liste clients + modal détail + historique
├── dashboard.html             # Tableau de bord (stats + activité + paramètres)
├── staff.html                 # Gestion équipe (propriétaire)
├── preferences.html           # Préférences (thème, backup, commerce, sécurité)
├── client-form.html           # Formulaire public multilingue (scan QR)
├── admin/
│   ├── index.html             # Login super admin
│   └── dashboard.html         # Gestion des commerces
├── css/
│   └── styles.css             # Stylesheet unique + variables thèmes
└── js/
    └── app.js                 # API wrapper, auth, routing, formatting, UI utils
```

---

## Installation

```bash
cd backend
cp .env.example .env           # Configurer les variables
npm install
npm start                      # → http://localhost:3000
```

Au premier lancement, la base SQLite est créée automatiquement avec toutes les tables et index.

### Super admin initial

Aller sur `/admin` — si aucun admin n'existe, le formulaire de setup s'affiche.

Ou via API :
```
POST /api/admin/auth/setup
{ "email": "admin@fiddo.be", "password": "motdepasse8+", "name": "Admin" }
```
Cette route ne fonctionne qu'une seule fois.

---

## Configuration (.env)

```env
NODE_ENV=production

# JWT (changer impérativement en production)
JWT_SECRET=votre-secret-jwt-unique
ADMIN_JWT_SECRET=votre-secret-admin-different

# Brevo SMTP
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=votre-login@smtp-brevo.com
SMTP_PASS=votre-mot-de-passe-brevo
EMAIL_FROM=FIDDO <noreply@fiddo.be>

# Application
BASE_URL=https://www.fiddo.be
PORT=3000
```

---

## Base de données

9 tables SQLite :

| Table | Description |
|-------|------------|
| `super_admins` | Administrateurs plateforme |
| `merchants` | Commerces (nom, TVA, statut, paramètres fidélité, thème) |
| `staff_accounts` | Comptes staff (owner, manager, cashier) + brute force |
| `end_users` | Identité globale clients (email, phone normalisés, validation, RGPD) |
| `end_user_aliases` | Identifiants historiques post-fusion |
| `merchant_clients` | Relation merchant ↔ client (points, visites, CA, custom reward, notes) |
| `transactions` | Ledger comptable signé (credit, reward, adjustment, merge) |
| `audit_logs` | Trail d'audit immutable (actor, action, IP, request ID) |
| `end_user_merges` | Traçabilité des fusions de doublons |

---

## API — Endpoints principaux

### Auth (`/api/auth`)
| Méthode | Route | Rôle | Description |
|---------|-------|------|-------------|
| POST | `/register` | Public | Inscription commerce (→ pending) |
| POST | `/login` | Public | Connexion staff |
| GET | `/verify` | Staff | Vérifier token courant |
| POST | `/logout` | Staff | Déconnexion |
| PUT | `/settings` | Owner | Modifier paramètres fidélité |
| PUT | `/password` | Staff | Changer mot de passe |
| PUT | `/merchant-info` | Owner | Modifier infos commerce |

### Clients (`/api/clients`)
| Méthode | Route | Rôle | Description |
|---------|-------|------|-------------|
| POST | `/credit` | Staff | Créditer des points |
| POST | `/reward` | Staff | Réclamer une récompense |
| POST | `/adjust` | Owner/Manager | Ajustement manuel |
| GET | `/lookup?email=&phone=` | Staff | Lookup rapide |
| GET | `/` | Owner/Manager | Liste clients |
| GET | `/search?q=` | Owner/Manager | Recherche clients |
| GET | `/export/csv` | Owner | Export CSV |
| GET | `/:id` | Owner/Manager | Détails + historique |
| POST | `/:id/block` | Owner/Manager | Bloquer |
| POST | `/:id/unblock` | Owner/Manager | Débloquer |
| PUT | `/:id/custom-reward` | Owner/Manager | Récompense custom |
| DELETE | `/:id/custom-reward` | Owner/Manager | Supprimer custom reward |
| POST | `/:id/notes` | Owner/Manager | Notes privées |
| DELETE | `/:id` | Owner | Suppression RGPD |
| POST | `/:id/resend-validation` | Owner/Manager | Renvoyer email |

### QR (`/api/qr`)
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/session` | Créer session QR |
| GET | `/session/:id` | Polling résultat |
| POST | `/submit` | Soumission formulaire (public) |
| GET | `/merchant/:id/public` | Infos merchant pour client-form (public) |

### Preferences (`/api/preferences`)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/` | Charger préférences |
| PUT | `/` | Sauvegarder préférences |
| GET | `/backup/export` | Export JSON complet |
| POST | `/backup/import` | Import JSON |

### Admin (`/api/admin`)
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/auth/setup` | Créer premier admin |
| POST | `/auth/login` | Connexion admin |
| GET | `/merchants` | Liste commerces (filtrable par statut) |
| GET | `/merchants/stats/global` | Stats plateforme |
| GET | `/merchants/:id` | Détails commerce + staff + stats |
| POST | `/merchants/:id/validate` | Valider → actif |
| POST | `/merchants/:id/reject` | Refuser (avec motif) |
| POST | `/merchants/:id/suspend` | Suspendre |
| POST | `/merchants/:id/reactivate` | Réactiver |

---

## Marché cible

Restaurants, cafés, boulangeries et commerces de proximité en **Belgique** — validation TVA belge, téléphone +32 par défaut, interface française. Pensé pour des équipes non-techniques qui veulent fidéliser leur clientèle sans investissement matériel ni app à télécharger.

---

## Licence

Projet propriétaire — © FIDDO 2025–2026
