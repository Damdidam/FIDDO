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
app.use(express.json({ limit: '10mb' })); // 10mb for backup imports
app.use(cookieParser());
app.use(requestIdMiddleware); // Attach unique request ID to every request

// Static files
app.use(express.static(path.join(__dirname, '../frontend')));

// ═══════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════

// Staff auth
app.use('/api/auth', require('./routes/auth'));

// Client management (credit, reward, lookup, list, etc.)
app.use('/api/clients', require('./routes/clients'));

// QR code sessions (client self-identification)
app.use('/api/qr', require('./routes/qr'));

// Preferences (themes, backups, notifications)
app.use('/api/preferences', require('./routes/preferences'));

// Super admin
app.use('/api/admin/auth', require('./routes/admin/auth'));
app.use('/api/admin/merchants', require('./routes/admin/merchants'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '3.3.0', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════
// HTML PAGES
// ═══════════════════════════════════════════════════════

// Merchant pages
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../frontend/dashboard.html')));
app.get('/clients',   (req, res) => res.sendFile(path.join(__dirname, '../frontend/clients.html')));
app.get('/credit',    (req, res) => res.sendFile(path.join(__dirname, '../frontend/credit.html')));
app.get('/staff',     (req, res) => res.sendFile(path.join(__dirname, '../frontend/staff.html')));
app.get('/preferences', (req, res) => res.sendFile(path.join(__dirname, '../frontend/preferences.html')));

// Client self-identification (public — scanned via QR)
app.get('/client-form', (req, res) => res.sendFile(path.join(__dirname, '../frontend/client-form.html')));

// Super admin pages
app.get('/admin',           (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/index.html')));
app.get('/admin/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin/dashboard.html')));

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

app.listen(PORT, () => {
  console.log(`🐕 FIDDO V3.3 Multi-Tenant — Port ${PORT}`);
});

module.exports = app;
