require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const { requestIdMiddleware } = require('./middleware/audit');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════
// GLOBAL MIDDLEWARE
// ═══════════════════════════════════════════════════════

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
// Raised limit only for backup import (large JSON payloads)
app.use('/api/preferences/backup', express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(requestIdMiddleware);
app.use('/api/staff', require('./routes/staff'));

// Static files — index: false so that GET / hits our landing route, not index.html
app.use(express.static(path.join(__dirname, '../frontend'), { index: false }));

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
  res.json({ status: 'ok', version: '3.5.0', timestamp: new Date().toISOString() });
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

// QR static deep link — /q/ABC123 → client portal
app.get('/q/:token', (req, res) => res.sendFile(path.join(__dirname, '../frontend/client-form.html')));

// Client portal
app.get('/me', (req, res) => res.sendFile(path.join(__dirname, '../frontend/me.html')));
app.get('/me/verify/:token', (req, res) => res.sendFile(path.join(__dirname, '../frontend/me.html')));
app.get('/c/:token', (req, res) => res.sendFile(path.join(__dirname, '../frontend/me.html')));

// Super admin pages
app.get('/admin',           (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/index.html')));
app.get('/admin/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/dashboard.html')));
app.get('/admin/messages',  (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/messages.html')));

// Email validation
app.get('/validate', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send('<h1 style="color:#EF4444;">Token manquant</h1>');
  }

  const { endUserQueries } = require('./database');
  const result = endUserQueries.validateEmail.run(token);

  if (result.changes === 0) {
    return res.status(400).send('<h1 style="color:#F59E0B;">Token invalide ou déjà utilisé</h1>');
  }

  res.send(`
    <div style="font-family: Arial; text-align: center; margin-top: 100px;">
      <h1 style="color: #10B981;">✅ Email validé avec succès !</h1>
      <p>Vous recevrez désormais vos notifications de points par email.</p>
    </div>
  `);
});

// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════

// Start backup scheduler
const { startScheduler } = require('./services/backup-db');
startScheduler();

app.listen(PORT, () => {
  console.log(`🐕 FIDDO V3.5 Multi-Tenant — Port ${PORT}`);
});

module.exports = app;
