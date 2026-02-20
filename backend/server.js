require('dotenv').config();

// ═══ BUILD VERSION — change this to verify deployment ═══
const BUILD_VERSION = '2026-02-20-v3-cachebust';

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { requestIdMiddleware } = require('./middleware/audit');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════
// GLOBAL MIDDLEWARE
// ═══════════════════════════════════════════════════════

// CORS: restrict origins in production
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? (origin, callback) => {
        const allowed = (process.env.CORS_ORIGINS || 'https://fiddo.be')
          .split(',').map(s => s.trim());
        // Allow same-origin requests (no origin header) and allowed origins
        if (!origin || allowed.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Origine non autorisée'));
        }
      }
    : true,
  credentials: true,
};
app.use(cors(corsOptions));

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // CSP disabled — inline scripts in HTML pages
  crossOriginEmbedderPolicy: false,
}));

// Global rate limiting
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,                  // 200 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez dans quelques minutes' },
}));

// Strict rate limit on auth endpoints
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives de connexion' },
}));
app.use('/api/admin/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives de connexion' },
}));

app.use(express.json({ limit: '1mb' }));
// Raised limit only for backup import (large JSON payloads)
app.use('/api/preferences/backup', express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(requestIdMiddleware);

// Prevent browser from caching ANY API response (fixes stale 410/404 cache issues)
app.use('/api/', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Android App Links verification
app.use('/.well-known', express.static(path.join(__dirname, '../frontend/.well-known')));

// Static files — index: false so that GET / hits our landing route, not index.html
// No cache for HTML to prevent stale page issues after deployments
app.use(express.static(path.join(__dirname, '../frontend'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// PWA static files (css, js, assets, manifest)
app.use('/app', express.static(path.join(__dirname, '../frontend/app'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ═══════════════════════════════════════════════════════
// INIT ADDITIONAL TABLES (V3.5)
// ═══════════════════════════════════════════════════════

require('./database-messages');                      // messages & invoices tables

// ═══════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════

// Staff auth
app.use('/api/auth', require('./routes/auth'));

// Client management (credit, reward, lookup, list, etc.)
app.use('/api/clients', require('./routes/clients'));

// Staff management (owner only)
app.use('/api/staff', require('./routes/staff'));

// QR code self-identification
app.use('/api/qr', require('./routes/qr'));
app.use('/api/me', require('./routes/client-portal'));

// Merchant preferences (theme, password, merchant-info, backup)   ← FIX thème
app.use('/api/preferences', require('./routes/preferences'));

// Announcements (merchant-facing)
app.use('/api/announcements', require('./routes/announcements'));

// Dashboard (stats + activity feed)
app.use('/api/dashboard', require('./routes/dashboard'));

// Messages (merchant-side: read messages, download invoices)      ← FIX messages
app.use('/api/messages', require('./routes/messages'));

// Super admin
app.use('/api/admin/auth', require('./routes/admin/auth'));
app.use('/api/admin/merchants', require('./routes/admin/merchants'));
app.use('/api/admin/users', require('./routes/admin/users'));
app.use('/api/admin/backups', require('./routes/admin/backups'));
app.use('/api/admin/announcements', require('./routes/admin/announcements'));
app.use('/api/admin/messages', require('./routes/admin/messages'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '4.0.0', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════
// HTML PAGES
// ═══════════════════════════════════════════════════════

// Force no-cache on all HTML pages to prevent stale deployments
function noCache(req, res, next) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

// Landing page (public)
app.get('/',            noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/landing.html')));
app.get('/login',       noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

// Merchant pages
app.get('/dashboard',   noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/dashboard.html')));
app.get('/clients',     noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/clients.html')));
app.get('/credit',      noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/credit.html')));
app.get('/staff',       noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/staff.html')));
app.get('/preferences', noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/preferences.html')));
app.get('/messages',    noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/messages.html')));

// QR client-facing form
app.get('/client-form', noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/client-form.html')));

// Privacy policy (Google Play / App Store requirement)
app.get('/privacy', noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/privacy.html')));

// QR static deep link — /q/ABC123 → redirect to PWA with merchant token
app.get('/q/:token', noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/qr-landing.html')));

// Client portal (legacy me.html)
app.get('/me', (req, res) => res.redirect(301, '/app/'));
app.get('/me/verify/:token', noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/verify.html')));
app.get('/c/:token', (req, res) => res.redirect(301, '/app/'));

// PWA client app — serves index.html for all /app routes (SPA)
app.get('/app', noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/app/index.html')));
app.get('/app/*', noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/app/index.html')));

// Super admin pages
app.get('/admin',           noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/index.html')));
app.get('/admin/dashboard', noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/dashboard.html')));
app.get('/admin/messages',  noCache, (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/messages.html')));

// Email validation
app.get('/validate', (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string' || token.length > 100) {
    return res.status(400).send('<!DOCTYPE html><html><body><h1 style="color:#EF4444;">Token manquant ou invalide</h1></body></html>');
  }

  const { endUserQueries } = require('./database');
  const result = endUserQueries.validateEmail.run(token);

  if (result.changes === 0) {
    return res.status(400).send('<!DOCTYPE html><html><body><h1 style="color:#F59E0B;">Token invalide ou d&eacute;j&agrave; utilis&eacute;</h1></body></html>');
  }

  res.send(`<!DOCTYPE html><html><body>
    <div style="font-family: Arial; text-align: center; margin-top: 100px;">
      <h1 style="color: #10B981;">&#10004; Email validé avec succès !</h1>
      <p>Vous recevrez désormais vos notifications de points par email.</p>
    </div>
  </body></html>`);
});

// ── Unsubscribe from marketing emails ──
app.get('/unsubscribe', (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string' || token.length > 200) {
    return res.status(400).send(unsubPage('Token manquant ou invalide.', true));
  }

  const { verifyUnsubToken } = require('./services/email');
  const { endUserQueries } = require('./database');

  const endUserId = verifyUnsubToken(token);
  if (!endUserId) {
    return res.status(400).send(unsubPage('Ce lien de désinscription est invalide ou a expiré.', true));
  }

  const user = endUserQueries.findById.get(endUserId);
  if (!user || user.deleted_at) {
    return res.status(404).send(unsubPage('Ce compte n\'existe plus.', true));
  }

  if (user.marketing_optout) {
    return res.send(unsubPage('Vous êtes déjà désinscrit(e) des emails promotionnels.', false));
  }

  endUserQueries.setMarketingOptout.run(endUserId);
  res.send(unsubPage('Vous avez été désinscrit(e) des emails promotionnels. Vous continuerez à recevoir les emails liés à votre compte (points, sécurité, etc.).', false));
});

function unsubPage(message, isError) {
  const color = isError ? '#DC2626' : '#059669';
  const icon = isError ? '✕' : '✓';
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FIDDO — Désinscription</title></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:480px;margin:80px auto;padding:32px 24px;text-align:center;">
  <div style="font-size:28px;font-weight:800;color:#0891B2;letter-spacing:1px;margin-bottom:32px;">FIDDO</div>
  <div style="width:64px;height:64px;border-radius:50%;background:${isError ? '#FEE2E2' : '#D1FAE5'};display:inline-flex;align-items:center;justify-content:center;font-size:28px;color:${color};">${icon}</div>
  <h2 style="color:#0F172A;font-size:20px;margin:16px 0 8px;">Désinscription</h2>
  <p style="color:#64748B;font-size:15px;line-height:1.6;">${message}</p>
  <a href="https://www.fiddo.be" style="display:inline-block;margin-top:24px;color:#0891B2;font-size:14px;text-decoration:none;font-weight:600;">← Retour à fiddo.be</a>
</div>
</body></html>`;
}

// Version check endpoint — verify deployment
app.get('/api/version', (req, res) => res.json({ version: BUILD_VERSION }));

// ═══════════════════════════════════════════════════════
// ERROR HANDLING — Custom FIDDO pages (no Render defaults)
// ═══════════════════════════════════════════════════════

// 404 — catch-all for unmatched routes
app.use((req, res) => {
  // API routes → JSON 404
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Route introuvable' });
  }
  // Client app routes → app 502 page (acts as fallback)
  if (req.path.startsWith('/app')) {
    return res.status(404).sendFile(path.join(__dirname, '../frontend/app/502.html'));
  }
  // Everything else → merchant 502 page
  res.status(404).sendFile(path.join(__dirname, '../frontend/502.html'));
});

// 500 — Express error handler (4 args = error middleware)
app.use((err, req, res, _next) => {
  console.error('⚠️ Express error:', err.message || err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Erreur serveur interne' });
  }
  if (req.path.startsWith('/app')) {
    return res.status(500).sendFile(path.join(__dirname, '../frontend/app/502.html'));
  }
  res.status(500).sendFile(path.join(__dirname, '../frontend/502.html'));
});

// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════

// Only auto-start when run directly (not when required by tests)
if (require.main === module) {
  // Start backup scheduler
  const { startScheduler } = require('./services/backup-db');
  startScheduler();

  // Start email reminder scheduler (J+3 app download reminders)
  const { startScheduler: startEmailScheduler } = require('./scheduler');
  startEmailScheduler();

  app.listen(PORT, () => {
    console.log(`🐕 FIDDO V4.0 Multi-Tenant — Port ${PORT} — Build: ${BUILD_VERSION}`);
  });
}

// ═══════════════════════════════════════════════════════
// GLOBAL ERROR HANDLERS
// ═══════════════════════════════════════════════════════

process.on('unhandledRejection', (reason, promise) => {
  console.error('⛔ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('⛔ Uncaught Exception:', err);
  process.exit(1);
});

module.exports = app;
