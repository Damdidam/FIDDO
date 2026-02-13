# FIDDO

**Programme de fidélité multi-tenant pour restaurateurs belges**

FIDDO permet aux restaurants, cafés et commerces de proximité de gérer un programme de fidélité par points — sans app à installer côté client, sans matériel spécifique. Une interface web simple, pensée pour un usage en caisse.

**[fiddo.be](https://www.fiddo.be)**

---

## Concept

Le restaurateur crédite des points à chaque passage client. Quand le seuil est atteint, le client bénéficie d'une récompense (boisson offerte, réduction, dessert…). Tout se fait depuis le navigateur, sur téléphone ou tablette en caisse.

---

## Fonctionnalités

### Gestion des points

- **Crédit automatique** : saisie du montant dépensé, calcul automatique des points selon le ratio configuré (ex : 1 pt/€)
- **Récompense** : déduction automatique quand le seuil est atteint, avec animation de célébration
- **Récompense personnalisée** : possibilité de définir une récompense custom par client (ex : "Café offert" pour un habitué)
- **Ajustement manuel** : correction de points par le manager/propriétaire avec raison obligatoire
- **Idempotence** : protection contre les double-crédits via clé d'idempotence unique par transaction

### Identification client — 4 modes

La page de crédit propose quatre onglets d'identification, chacun avec une icône SVG monochrome :

**Email** — Saisie par email avec autocomplete sur les clients existants, détection de fautes de frappe sur les domaines (gmial.com → gmail.com), lookup en temps réel affichant solde, visites et progression.

**Téléphone** — Saisie par numéro avec normalisation E.164 automatique (+32 par défaut), autocomplete et lookup identique.

**QR statique** — Un QR code permanent propre au commerce s'affiche en caisse. Le client le scanne avec son téléphone et s'identifie via un formulaire public (`fiddo.be/q/TOKEN`). Le staff voit le client apparaître dans une file d'attente en temps réel (polling 3s). Si un seul client est en file, il est auto-sélectionné et le formulaire est pré-rempli sans intervention du staff. Formulaire multilingue : FR, EN, NL, TR, ZH, AR.

**Scan** — Le staff scanne le QR personnel du client avec la caméra du téléphone/tablette (lib html5-qrcode). Le client est identifié instantanément, le formulaire est pré-rempli, et la récompense peut être appliquée **sans code PIN** — le scan QR faisant office de preuve de présence.

### Détection de doublons

Lors de la saisie d'un nouveau client, le système cherche automatiquement les **quasi-doublons** en arrière-plan : numéros de téléphone partageant les 7 derniers chiffres, emails avec le même préfixe. Si un match est trouvé, un bandeau jaune s'affiche avec le nom et les points du client similaire, et un bouton "Utiliser" permet de basculer en un clic.

### Anti-spam (QR statique)

Triple protection contre les soumissions multiples via le QR commerce :
- **Cooldown serveur** (15 min) : même identifiant + même commerce → réponse en cache, pas de re-queue
- **Vérification de statut** : si le client rafraîchit la page, son `identId` est vérifié côté serveur → écran succès direct
- **sessionStorage** : stocke l'identId, empêche le ré-affichage du formulaire

### Portail client (`fiddo.be/me`)

Espace personnel du client, accessible par **magic link email** (pas de mot de passe) :
- Le client entre son email → reçoit un lien valable 15 minutes
- Clic sur le lien → JWT client valable 30 jours
- **Dashboard** : liste de toutes ses cartes de fidélité (tous commerces), avec pour chaque carte : nom du merchant, thème couleur, solde, progression, description de la récompense, statut (disponible ou non)
- **QR personnel** : affichage plein écran du QR unique du client, prêt à être montré au staff pour identification instantanée

Le QR client est généré automatiquement à la création du compte (`end_users.qr_token`). Les clients existants sans token sont backfillés au démarrage du serveur.

URL du QR client : `fiddo.be/c/TOKEN` → redirige vers le portail.

### Multi-tenant

- Chaque commerce a ses propres clients, points, paramètres et récompenses
- Données isolées par merchant : un caissier ne voit que les clients de son commerce
- Un même client (identifié par email/téléphone) peut être fidélisé dans plusieurs commerces indépendamment
- Système d'aliases pour les identifiants post-fusion de doublons

### Rôles et permissions

| Rôle | Créditer | Voir clients | Paramètres | Gérer équipe |
|------|----------|-------------|------------|-------------|
| **Caissier** | Oui (max 200€) | Non | Non | Non |
| **Manager** | Oui | Oui | Non | Non |
| **Propriétaire** | Oui | Oui | Oui | Oui |

### Dashboard

- **Statistiques** : nombre de clients, clients actifs (30 jours), points distribués, récompenses réclamées
- **Activité récente** : tableau triable avec détails staff, type de transaction, timestamp
- **Paramètres de fidélité** (propriétaire) : points/euro, seuil de récompense, description récompense

### Gestion des clients

- **Liste complète** avec cards : points, visites, dernière visite, badges (actif/inactif, bloqué, email validé)
- **Colonne Récompense** : affiche la récompense custom ou la récompense par défaut
- **Recherche** par email, téléphone ou nom
- **Fiche client détaillée** (modal) : hero header avec gradient, stats, reward card avec barre de progression, banner cliquable avec célébration animée (confettis + overlay), historique en timeline, toolbar d'actions
- **Actions** : bloquer/débloquer, ajuster les points, récompense personnalisée, notes privées, renvoi email de validation, crédit rapide, suppression RGPD (soft-delete avec anonymisation), merge de doublons
- **Export CSV** de la liste clients

### Préférences

Page préférences avec 7 onglets :
- **Récompenses** : points par euro, seuil, description, message personnalisé, langue par défaut du formulaire client
- **Thème** : 7 palettes couleur (Teal, Navy, Violet, Forest, Brick, Amber, Slate) — changement instantané, persisté en base, appliqué partout y compris le formulaire client
- **Notifications** : toggles pour nouveaux clients, récompenses disponibles, rapport hebdomadaire
- **Mon commerce** : édition nom, adresse, TVA, email, téléphone — notification au super admin à chaque modification
- **Mot de passe** : changement avec indicateur de force
- **Sauvegarde** : export/import JSON complet avec drag-and-drop et preview avant import
- **QR Code** : affichage du QR commerce, aperçu d'impression, téléchargement PDF (format A6 paysage) et impression directe

### Messagerie

- **Messages in-app** entre super admin et commerces
- Interface de conversation avec indicateur de messages non lus
- Badge dynamique dans la navbar

### Annonces

- **Annonces globales** du super admin vers tous les commerces
- Affichage contextuel dans le dashboard marchand

### Super Admin

- **Panel dédié** avec design sombre premium (gradient header, badges production)
- **Validation / refus** des inscriptions commerces (avec motif de refus)
- **Suspension / réactivation** avec désactivation automatique des comptes staff
- **Vue globale** : commerces, actifs, en attente, clients, CA total
- **Santé du système** : statut API (latence), hébergement, emails envoyés, uptime
- **Onglets** : En attente / Actifs / Tous / Annonces
- **Détail par commerce** (modal) : stats, infos, équipe complète, actions contextuelles
- **Fusion de doublons** clients (identifiants post-merge via aliases, traçabilité complète)
- **Messagerie** avec tous les commerces
- **Backups globaux** de la base de données

### Emails transactionnels (Brevo SMTP)

- **Validation du compte client** : lien de confirmation pour activer les notifications
- **Points crédités** : notification avec barre de progression et détail récompense
- **Commerce validé** : email d'activation avec lien de connexion
- **Commerce refusé** : email avec motif de refus
- **Modification commerce** : notification au super admin
- **Magic link client** : lien de connexion au portail client (15 min de validité)
- **Changement de mot de passe** : email de confirmation au staff
- **Changement de PIN** : notification au client
- Tous les emails sont **fire-and-forget** : un échec SMTP ne bloque jamais l'opération métier
- DNS configuré : SPF + DKIM (Brevo) + DMARC

### Sécurité

- Authentification **JWT via cookies HTTP-only** (SameSite, Secure en production) pour le staff
- Authentification **JWT Bearer** pour le portail client
- **Protection brute force** : verrouillage après 5 tentatives pendant 15 minutes
- **Rate limiting** : magic link (5 par IP par heure), PIN (5 tentatives par session)
- **Audit trail immutable** : chaque action est tracée (IP, user-agent, request ID corrélé)
- **Normalisation stricte** : email lowercase, téléphone E.164 (+32 par défaut), TVA belge BE0XXXXXXXXX
- Sessions différenciées : 8h caissier, 7 jours manager/propriétaire, 24h super admin, 30 jours portail client
- Messages d'erreur structurés (codes erreur + hints UX) sans fuite d'information
- Le `merchant_id` vient **toujours du JWT**, jamais du body — impossible de créditer pour un autre commerce
- **Anti-énumération** : le login magic link retourne toujours "succès" même si l'email n'existe pas

### Interface et UX

- **Login split-screen** : brand panel animé (gradient, orbe lumineux, features list) + formulaire avec alertes
- **Navbar unifiée** : logo FIDDO teal + barre verticale + nom du commerce en uppercase (identique au panel admin)
- **Design mobile-first** responsive (navbar collapse, grids adaptatifs)
- **Icônes SVG monochromes** partout (pas d'emojis dans l'interface staff)
- **Animations** : célébration récompense (confettis + backdrop), pulse reward banner, spinner chargement
- **Navbar dynamique** selon le rôle (caissier → crédit uniquement, manager → dashboard + clients, owner → tout)
- **Thèmes** personnalisables par commerce (7 palettes)
- **Portail client** : design sombre (dark mode), DM Sans, gradient teal, cartes de fidélité avec progression

---

## Stack technique

| Composant | Technologie |
|-----------|------------|
| Backend | Node.js 18+ / Express 4 |
| Base de données | SQLite (better-sqlite3) — WAL mode, foreign keys |
| Auth staff | JWT (jsonwebtoken) + bcryptjs + cookies HTTP-only |
| Auth client | JWT Bearer + magic link email |
| Email | Nodemailer + Brevo SMTP relay |
| Frontend | HTML / CSS / JS vanilla — zéro framework, zéro build |
| QR génération | qrcodejs (CDN) |
| QR scan | html5-qrcode (CDN) |
| Hébergement | Render (web service) |
| Domaine | OVHcloud (fiddo.be) |
| DNS | SPF + DKIM + DMARC |

---

## Structure du projet

```
backend/
├── server.js                    # Point d'entrée Express, routes HTML
├── database.js                  # Schema SQLite + migrations + prepared statements
├── database-messages.js         # Schema messagerie
├── package.json
├── routes/
│   ├── auth.js                  # Login, register, settings, password, merchant-info
│   ├── clients.js               # Credit, reward, adjust, lookup, near-duplicates, search, block, export
│   ├── qr.js                    # QR statique merchant, client-lookup, pending queue
│   ├── client-portal.js         # Magic link login, verify, cards, QR client
│   ├── preferences.js           # Thèmes, notifications, backup export/import
│   ├── dashboard.js             # Stats dashboard
│   ├── staff.js                 # Gestion équipe
│   ├── messages.js              # Messagerie merchant
│   ├── announcements.js         # Annonces
│   └── admin/
│       ├── auth.js              # Super admin login/setup/verify
│       ├── merchants.js         # Validation, suspension, stats globales
│       ├── messages.js          # Messagerie admin
│       ├── announcements.js     # Annonces admin
│       └── backups.js           # Backups globaux
├── middleware/
│   ├── auth.js                  # JWT staff + brute force + roles
│   ├── admin-auth.js            # JWT super admin
│   └── audit.js                 # Audit trail immutable + request ID
├── services/
│   ├── points.js                # Logique métier (credit, redeem, adjust, qr_token auto)
│   ├── normalizer.js            # Email, phone, TVA normalization
│   ├── email.js                 # Templates email + magic link + transport Brevo
│   ├── backup.js                # Export/import JSON backup
│   └── backup-db.js             # Backup base de données

frontend/
├── landing.html                 # Page d'accueil publique fiddo.be
├── index.html                   # Login split-screen / inscription commerce
├── credit.html                  # Page caissier (crédit + 4 modes identification + scanner)
├── clients.html                 # Liste clients + modal détail + historique
├── dashboard.html               # Tableau de bord (stats + activité)
├── staff.html                   # Gestion équipe (propriétaire)
├── preferences.html             # Préférences (7 onglets dont QR Code)
├── messages.html                # Messagerie
├── client-form.html             # Formulaire public multilingue (scan QR commerce)
├── me.html                      # Portail client (magic link + cartes + QR personnel)
├── admin/
│   ├── index.html               # Login super admin
│   └── dashboard.html           # Panel admin (commerces, stats, santé, annonces)
├── css/
│   └── styles.css               # Stylesheet unique + variables thèmes + navbar unifiée
├── js/
│   └── app.js                   # API wrapper, auth, routing, formatting, UI, navbar builder
└── img/                         # Assets visuels
```

---

## Installation

```bash
cd backend
cp .env.example .env
npm install
npm start                        # → http://localhost:3000
```

Au premier lancement, la base SQLite est créée automatiquement avec toutes les tables, index et migrations.

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
CLIENT_JWT_SECRET=votre-secret-client-different

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

10 tables SQLite :

| Table | Description |
|-------|------------|
| `super_admins` | Administrateurs plateforme |
| `merchants` | Commerces (nom, TVA, statut, paramètres fidélité, qr_token) |
| `merchant_preferences` | Préférences par commerce (thème, langue, notifications) |
| `staff_accounts` | Comptes staff (owner, manager, cashier) + brute force |
| `end_users` | Identité globale clients (email, phone, qr_token, magic_token, pin_hash) |
| `end_user_aliases` | Identifiants historiques post-fusion |
| `merchant_clients` | Relation merchant-client (points, visites, CA, custom reward, notes) |
| `transactions` | Ledger comptable signé (credit, reward, adjustment, merge) |
| `audit_logs` | Trail d'audit immutable (actor, action, IP, request ID) |
| `end_user_merges` | Traçabilité des fusions de doublons |

---

## API — Endpoints principaux

### Auth staff (`/api/auth`)
| Méthode | Route | Rôle | Description |
|---------|-------|------|-------------|
| POST | `/register` | Public | Inscription commerce (→ pending) |
| POST | `/login` | Public | Connexion staff |
| GET | `/verify` | Staff | Vérifier token courant |
| POST | `/logout` | Staff | Déconnexion |
| PUT | `/settings` | Owner | Modifier paramètres fidélité |
| PUT | `/password` | Staff | Changer mot de passe |
| PUT | `/merchant-info` | Owner | Modifier infos commerce |

### Portail client (`/api/me`)
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/login` | Envoyer magic link par email |
| POST | `/verify` | Valider magic link → JWT 30j |
| GET | `/cards` | Toutes les cartes fidélité du client |
| GET | `/qr` | QR token du client |

### Clients (`/api/clients`)
| Méthode | Route | Rôle | Description |
|---------|-------|------|-------------|
| POST | `/credit` | Staff | Créditer des points |
| POST | `/reward` | Staff | Réclamer une récompense (PIN ou QR) |
| POST | `/adjust` | Owner/Manager | Ajustement manuel |
| GET | `/lookup` | Staff | Lookup rapide par email/phone |
| GET | `/near-duplicates` | Staff | Détection quasi-doublons |
| GET | `/` | Owner/Manager | Liste clients |
| GET | `/search` | Owner/Manager | Recherche clients |
| GET | `/search-global` | Staff | Recherche cross-merchant |
| GET | `/export/csv` | Owner | Export CSV |
| GET | `/:id` | Owner/Manager | Détails + historique |
| POST | `/:id/block` | Owner/Manager | Bloquer |
| POST | `/:id/unblock` | Owner/Manager | Débloquer |
| PUT | `/:id/custom-reward` | Owner/Manager | Récompense custom |
| DELETE | `/:id/custom-reward` | Owner/Manager | Supprimer custom reward |
| POST | `/:id/notes` | Owner/Manager | Notes privées |
| DELETE | `/:id` | Owner | Suppression RGPD |
| POST | `/:id/resend-email` | Owner/Manager | Renvoyer email validation |
| POST | `/:id/merge` | Owner/Manager | Fusionner avec un autre client |

### QR (`/api/qr`)
| Méthode | Route | Rôle | Description |
|---------|-------|------|-------------|
| POST | `/generate` | Owner | Générer le QR token commerce (get-or-create) |
| GET | `/token` | Staff | Obtenir le QR token (auto-génère si absent) |
| GET | `/client-lookup/:token` | Staff | Lookup client par QR scan |
| POST | `/register` | Public | Identification client via QR commerce |
| GET | `/status/:identId` | Public | Vérifier statut d'une identification |
| GET | `/pending` | Staff | File d'attente des identifications |
| POST | `/consume/:identId` | Staff | Consommer une identification |

### Préférences (`/api/preferences`)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/` | Charger préférences |
| PUT | `/` | Sauvegarder préférences |
| PUT | `/theme` | Changer de thème |
| GET | `/merchant-info` | Charger infos commerce |
| PUT | `/merchant-info` | Modifier infos commerce |
| PUT | `/password` | Changer mot de passe |
| GET | `/backup/export` | Export JSON complet |
| POST | `/backup/validate` | Valider un fichier backup |
| POST | `/backup/import` | Importer un backup |

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

### Messages (`/api/messages`)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/` | Conversations |
| GET | `/unread` | Compteur non lus |
| POST | `/` | Envoyer un message |
| GET | `/:conversationId` | Historique conversation |

---

## Routes publiques (pages)

| URL | Page | Description |
|-----|------|-------------|
| `/` | `landing.html` | Page d'accueil fiddo.be |
| `/login` | `index.html` | Login / inscription |
| `/dashboard` | `dashboard.html` | Tableau de bord |
| `/credit` | `credit.html` | Crédit + identification |
| `/clients` | `clients.html` | Gestion clients |
| `/staff` | `staff.html` | Gestion équipe |
| `/preferences` | `preferences.html` | Préférences (7 onglets) |
| `/messages` | `messages.html` | Messagerie |
| `/q/:token` | `client-form.html` | Formulaire public (QR commerce) |
| `/me` | `me.html` | Portail client (login) |
| `/me/verify/:token` | `me.html` | Validation magic link |
| `/c/:token` | `me.html` | QR client → portail |
| `/admin` | `admin/index.html` | Login super admin |
| `/admin/dashboard` | `admin/dashboard.html` | Panel super admin |

---

## Marché cible

Restaurants, cafés, boulangeries et commerces de proximité en **Belgique** — validation TVA belge, téléphone +32 par défaut, interface française. Pensé pour des équipes non-techniques qui veulent fidéliser leur clientèle sans investissement matériel ni app à télécharger.

---

## Licence

Projet propriétaire — © FIDDO 2025–2026
