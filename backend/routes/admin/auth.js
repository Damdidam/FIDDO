const express = require('express');
const bcrypt = require('bcryptjs');
const { adminQueries } = require('../../database');
const { authenticateAdmin, generateAdminToken, adminCookieOptions } = require('../../middleware/admin-auth');
const { logAudit, auditCtx } = require('../../middleware/audit');

const router = express.Router();

// ─── Brute-force protection ───
const loginAttempts = new Map(); // ip -> { count, lastAttempt }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function checkAdminBruteForce(ip) {
  const attempts = loginAttempts.get(ip);
  if (!attempts) return false;
  if (attempts.count >= MAX_ATTEMPTS && Date.now() - attempts.lastAttempt < LOCKOUT_MS) {
    return true; // locked
  }
  if (Date.now() - attempts.lastAttempt >= LOCKOUT_MS) {
    loginAttempts.delete(ip); // expired, reset
    return false;
  }
  return false;
}

function recordAdminFailure(ip) {
  const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  attempts.count++;
  attempts.lastAttempt = Date.now();
  loginAttempts.set(ip, attempts);
}

function clearAdminAttempts(ip) {
  loginAttempts.delete(ip);
}

// ═══════════════════════════════════════════════════════
// GET /api/admin/auth/needs-setup
// ═══════════════════════════════════════════════════════

router.get('/needs-setup', (req, res) => {
  try {
    const { count } = adminQueries.count.get();
    res.json({ needsSetup: count === 0 });
  } catch (error) {
    console.error('Needs-setup error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
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
    const ip = req.ip;

    // Brute-force check
    if (checkAdminBruteForce(ip)) {
      return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    }

    let { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    email = email.toLowerCase().trim();
    const admin = adminQueries.findByEmail.get(email);

    if (!admin || !(await bcrypt.compare(password, admin.password))) {
      recordAdminFailure(ip);
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    clearAdminAttempts(ip);

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
  try {
    const admin = adminQueries.findById.get(req.admin.id);
    if (!admin) {
      return res.status(404).json({ error: 'Admin non trouvé' });
    }

    const { password: _, ...adminData } = admin;
    res.json({ admin: adminData });
  } catch (error) {
    console.error('Admin verify error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════
// POST /api/admin/auth/logout
// ═══════════════════════════════════════════════════════

router.post('/logout', (req, res) => {
  res.clearCookie('admin_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  });
  res.json({ message: 'Déconnecté' });
});

module.exports = router;
