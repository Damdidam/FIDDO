require('dotenv').config();
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

// Android App Links verification
app.use('/.well-known', express.static(path.join(__dirname, '../frontend/.well-known')));

// Static files — index: false so that GET / hits our landing route, not index.html
app.use(express.static(path.join(__dirname, '../frontend'), { index: false }));

// PWA static files (css, js, assets, manifest)
app.use('/app', express.static(path.join(__dirname, '../frontend/app'), { index: false }));

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

// Landing page (public)
app.get('/',            (req, res) => res.sendFile(path.join(__dirname, '../frontend/landing.html')));
app.get('/login',       (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

// Merchant pages
app.get('/dashboard',   (req, res) => res.sendFile(path.join(__dirname, '../frontend/dashboard.html')));
app.get('/clients',     (req, res) => res.sendFile(path.join(__dirname, '../frontend/clients.html')));
app.get('/credit',      (req, res) => res.sendFile(path.join(__dirname, '../frontend/credit.html')));
app.get('/staff',       (req, res) => res.sendFile(path.join(__dirname, '../frontend/staff.html')));
app.get('/preferences', (req, res) => res.sendFile(path.join(__dirname, '../frontend/preferences.html')));
app.get('/messages',    (req, res) => res.sendFile(path.join(__dirname, '../frontend/messages.html')));

// QR client-facing form
app.get('/client-form', (req, res) => res.sendFile(path.join(__dirname, '../frontend/client-form.html')));

// Privacy policy (Google Play / App Store requirement)
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, '../frontend/privacy.html')));

// QR static deep link — /q/ABC123 → redirect to PWA with merchant token
app.get('/q/:token', (req, res) => res.sendFile(path.join(__dirname, '../frontend/qr-landing.html')));

// Client portal (legacy me.html)
app.get('/me', (req, res) => res.redirect(301, '/app/'));
app.get('/me/verify/:token', (req, res) => res.sendFile(path.join(__dirname, '../frontend/verify.html')));
app.get('/c/:token', (req, res) => res.redirect(301, '/app/'));

// PWA client app — serves index.html for all /app routes (SPA)
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '../frontend/app/index.html')));
app.get('/app/*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/app/index.html')));

// Super admin pages
app.get('/admin',           (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/index.html')));
app.get('/admin/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/dashboard.html')));
app.get('/admin/messages',  (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/messages.html')));

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
    console.log(`🐕 FIDDO V4.0 Multi-Tenant — Port ${PORT}`);
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
