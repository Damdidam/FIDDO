const express = require('express');
const bcrypt = require('bcryptjs');
const { adminQueries } = require('../../database');
const { authenticateAdmin, generateAdminToken, adminCookieOptions } = require('../../middleware/admin-auth');
const { logAudit, auditCtx } = require('../../middleware/audit');

const router = express.Router();

// ═══════════════════════════════════════════════════════
// GET /api/admin/auth/needs-setup
// ═══════════════════════════════════════════════════════

router.get('/needs-setup', (req, res) => {
  const { count } = adminQueries.count.get();
  res.json({ needsSetup: count === 0 });
});

// ═══════════════════════════════════════════════════════
// POST /api/admin/auth/setup — Create first super admin (one-time)
// ═══════════════════════════════════════════════════════

router.post('/setup', async (req, res) => {
  try {
    const { count } = adminQueries.count.get();
    if (count > 0) {
      return res.status(403).json({ error: 'Setup déjà effectué' });
    }

    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, mot de passe et nom requis' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Mot de passe minimum 8 caractères' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const result = adminQueries.create.run(email.toLowerCase().trim(), hashedPassword, name.trim());

    const token = generateAdminToken({ id: result.lastInsertRowid, email: email.toLowerCase().trim() });
    res.cookie('admin_token', token, adminCookieOptions);

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: result.lastInsertRowid,
      action: 'admin_setup',
      targetType: 'super_admin',
      targetId: result.lastInsertRowid,
    });

    res.status(201).json({ message: 'Super admin créé', adminId: result.lastInsertRowid });
  } catch (error) {
    console.error('Erreur setup admin:', error);
    res.status(500).json({ error: 'Erreur lors du setup' });
  }
});

// ═══════════════════════════════════════════════════════
// POST /api/admin/auth/login
// ═══════════════════════════════════════════════════════

router.post('/login', async (req, res) => {
  try {
    let { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    email = email.toLowerCase().trim();
    const admin = adminQueries.findByEmail.get(email);

    if (!admin || !(await bcrypt.compare(password, admin.password))) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const token = generateAdminToken(admin);
    res.cookie('admin_token', token, adminCookieOptions);

    logAudit({
      ...auditCtx(req),
      actorType: 'super_admin',
      actorId: admin.id,
      action: 'admin_login',
    });

    const { password: _, ...adminData } = admin;
    res.json({ message: 'Connexion admin réussie', admin: adminData });
  } catch (error) {
    console.error('Erreur login admin:', error);
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});

// ═══════════════════════════════════════════════════════
// GET /api/admin/auth/verify
// ═══════════════════════════════════════════════════════

router.get('/verify', authenticateAdmin, (req, res) => {
  const admin = adminQueries.findById.get(req.admin.id);
  if (!admin) {
    return res.status(404).json({ error: 'Admin non trouvé' });
  }

  const { password: _, ...adminData } = admin;
  res.json({ admin: adminData });
});

// ═══════════════════════════════════════════════════════
// POST /api/admin/auth/logout
// ═══════════════════════════════════════════════════════

router.post('/logout', (req, res) => {
  res.clearCookie('admin_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  });
  res.json({ message: 'Déconnecté' });
});

module.exports = router;
