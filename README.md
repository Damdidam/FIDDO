# FIDDO 🐕

**Programme de fidélité multi-tenant pour restaurateurs**

FIDDO permet aux restaurants, cafés et commerces de proximité de gérer un programme de fidélité par points — sans app à installer côté client, sans matériel spécifique.

---

## Concept

Le restaurateur crédite des points à chaque passage client. Quand le seuil est atteint, le client bénéficie d'une récompense (boisson offerte, réduction, etc.). Tout se gère depuis une interface web simple, pensée pour un usage en caisse.

## Fonctionnalités

### Gestion des points
- **Crédit** : saisie du montant → calcul automatique des points selon le ratio configuré (ex: 1 pt/€)
- **Récompense** : déduction automatique quand le seuil est atteint, avec confirmation visuelle
- **Ajustement** : correction manuelle par le manager/propriétaire avec raison obligatoire
- **Idempotence** : protection contre les double-crédits via clé d'idempotence

### Identification client par QR
Pour les restaurateurs confrontés à une barrière de langue (clientèle internationale), un QR code s'affiche en caisse. Le client le scanne et remplit lui-même ses coordonnées sur une page multilingue (FR, EN, NL, TR, 中文, العربية). Le formulaire du caissier se pré-remplit automatiquement.

### Identification classique
- Saisie par email ou téléphone avec toggle
- Autocomplete sur les clients existants
- Détection de fautes de frappe sur les domaines email (gmial → gmail)
- Lookup en temps réel : affiche le solde, l'historique et la progression vers la récompense

### Multi-tenant
- Chaque commerce a ses propres clients, points et paramètres
- Les données sont isolées par merchant : un caissier ne voit que les clients de son commerce
- Un même client (identifié par email/téléphone) peut être fidélisé dans plusieurs commerces indépendamment

### Rôles et permissions
| Rôle | Créditer | Voir clients | Paramètres | Gérer équipe |
|------|----------|-------------|------------|-------------|
| **Caissier** | ✅ (max 200€) | ❌ | ❌ | ❌ |
| **Manager** | ✅ | ✅ | ❌ | ❌ |
| **Propriétaire** | ✅ | ✅ | ✅ | ✅ |

### Super Admin
- Validation / refus des inscriptions commerces
- Suspension / réactivation
- Vue globale : nombre de commerces, clients, CA total
- Fusion de doublons clients (identifiants post-merge via aliases)

### Sécurité
- Authentification JWT via cookies HTTP-only
- Protection brute force : verrouillage après 5 tentatives (15 min)
- Audit trail immutable : chaque action est tracée (IP, user-agent, request ID)
- Normalisation stricte des identifiants (email lowercase, téléphone E.164)
- Validation TVA belge (format BE0XXXXXXXXX)

### Emails transactionnels
- Validation du compte client (lien de confirmation)
- Notification de points crédités (avec barre de progression)
- Confirmation d'activation / refus du commerce

## Stack technique

| Composant | Technologie |
|-----------|------------|
| Backend | Node.js + Express |
| Base de données | SQLite (better-sqlite3) — WAL mode |
| Auth | JWT (jsonwebtoken) + bcryptjs |
| Email | Nodemailer (SMTP) |
| Frontend | HTML/CSS/JS vanilla — aucun framework |
| QR | qrcodejs (CDN) |

Aucune dépendance frontend à builder. L'app se déploie telle quelle.

## Structure du projet

```
backend/
├── server.js              # Point d'entrée Express
├── database.js            # Schema SQLite + prepared statements
├── routes/
│   ├── auth.js            # Login, register, settings
│   ├── clients.js         # Credit, reward, adjust, lookup, search
│   └── qr.js              # Sessions QR (in-memory)
│   └── admin/
│       ├── auth.js        # Super admin login/setup
│       └── merchants.js   # Validation, suspension, stats
├── middleware/
│   ├── auth.js            # JWT staff + brute force
│   ├── admin-auth.js      # JWT super admin
│   └── audit.js           # Audit trail + request ID
├── services/
│   ├── points.js          # Logique métier (credit, redeem, adjust)
│   ├── normalizer.js      # Email, phone, TVA normalization
│   └── email.js           # Templates email + transport SMTP

frontend/
├── index.html             # Login / inscription commerce
├── credit.html            # Page caissier (crédit + QR)
├── clients.html           # Liste clients + détails + historique
├── dashboard.html         # Tableau de bord (stats + paramètres)
├── staff.html             # Gestion équipe (propriétaire)
├── client-form.html       # Formulaire public multilingue (QR)
├── admin/
│   ├── index.html         # Login super admin
│   └── dashboard.html     # Gestion des commerces
├── css/styles.css         # Stylesheet unique
└── js/app.js              # API wrapper, auth, routing, UI utils
```

## Installation

```bash
cd backend
cp .env.example .env       # Configurer JWT_SECRET, SMTP, etc.
npm install
npm start                  # → http://localhost:3000
```

Au premier lancement, la base SQLite est créée automatiquement.

### Super admin initial

```
POST /api/admin/auth/setup
{ "email": "admin@fiddo.be", "password": "...", "name": "Admin" }
```

Cette route ne fonctionne qu'une seule fois (quand aucun admin n'existe).

## Configuration (.env)

```env
JWT_SECRET=change-me-in-production
ADMIN_JWT_SECRET=change-me-too
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
BASE_URL=https://your-domain.com
PORT=3000
```

## Licence

Projet propriétaire.
