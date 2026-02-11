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
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(requestIdMiddleware);

// Static files
app.use(express.static(path.join(__dirname, '../frontend')));

// ═══════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════

// Staff auth
app.use('/api/auth', require('./routes/auth'));

// Client management
app.use('/api/clients', require('./routes/clients'));

// QR code sessions
app.use('/api/qr', require('./routes/qr'));

// Preferences
app.use('/api/preferences', require('./routes/preferences'));

// Announcements (merchant-facing)
app.use('/api/announcements', require('./routes/announcements'));

// Super admin
app.use('/api/admin/auth', require('./routes/admin/auth'));
app.use('/api/admin/merchants', require('./routes/admin/merchants'));
app.use('/api/admin/announcements', require('./routes/admin/announcements'));

// Backups
try { app.use('/api/admin/backups', require('./routes/admin/backups')); } catch (e) { /* not deployed */ }

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '3.6.0', timestamp: new Date().toISOString() });
});

// Public merchant info
app.get('/api/merchants/:slug/public', (req, res) => {
  const { merchantQueries } = require('./database');
  const merchant = merchantQueries.findBySlug.get(req.params.slug);
  if (!merchant) return res.status(404).json({ error: 'Commerce non trouvé' });
  res.json({ business_name: merchant.business_name, slug: merchant.slug, status: merchant.status });
});

// ═══════════════════════════════════════════════════════
// HTML PAGES
// ═══════════════════════════════════════════════════════

app.get('/',            (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));
app.get('/dashboard',   (req, res) => res.sendFile(path.join(__dirname, '../frontend/dashboard.html')));
app.get('/clients',     (req, res) => res.sendFile(path.join(__dirname, '../frontend/clients.html')));
app.get('/credit',      (req, res) => res.sendFile(path.join(__dirname, '../frontend/credit.html')));
app.get('/staff',       (req, res) => res.sendFile(path.join(__dirname, '../frontend/staff.html')));
app.get('/preferences', (req, res) => res.sendFile(path.join(__dirname, '../frontend/preferences.html')));
app.get('/client-form', (req, res) => res.sendFile(path.join(__dirname, '../frontend/client-form.html')));

app.get('/admin',           (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/index.html')));
app.get('/admin/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/dashboard.html')));

// Email validation
app.get('/validate', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('<h1 style="color:#EF4444;">Token manquant</h1>');

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
// BRANDED LOGIN — /:slug (LAST to avoid conflicts)
// ═══════════════════════════════════════════════════════

app.get('/:slug', (req, res) => {
  const slug = req.params.slug;
  if (slug.includes('.') || ['favicon', 'robots'].includes(slug)) return res.status(404).end();

  const { merchantQueries } = require('./database');
  const merchant = merchantQueries.findBySlug.get(slug);
  if (!merchant) return res.redirect('/');

  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════

try {
  const { startScheduler } = require('./services/backup-db');
  startScheduler();
} catch (e) { /* backup service not deployed */ }

app.listen(PORT, () => {
  console.log(`🐕 FIDDO V3.6 Multi-Tenant — Port ${PORT}`);
});

module.exports = app;
