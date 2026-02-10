const express = require('express');
const crypto = require('crypto');

const router = express.Router();

// ═══════════════════════════════════════════════════════
// IN-MEMORY QR SESSION STORE
// Sessions live 10 minutes max, cleaned up periodically.
// ═══════════════════════════════════════════════════════

const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Cleanup expired sessions every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(token);
    }
  }
}, 2 * 60 * 1000);


// ═══════════════════════════════════════════════════════
// POST /api/qr/session — Create a new QR session (staff only)
// ═══════════════════════════════════════════════════════
// Requires staff auth (called from credit.html)

const { authenticateStaff } = require('../middleware/auth');

router.post('/session', authenticateStaff, (req, res) => {
  try {
    const token = crypto.randomBytes(16).toString('hex'); // 32-char hex

    sessions.set(token, {
      merchantId: req.staff.merchant_id,
      staffId: req.staff.id,
      createdAt: Date.now(),
      data: null,      // filled when client submits
      consumed: false, // true once staff polls it
    });

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const clientUrl = `${baseUrl}/client-form?s=${token}`;

    res.json({
      token,
      url: clientUrl,
      expiresIn: SESSION_TTL_MS / 1000, // seconds
    });
  } catch (error) {
    console.error('QR session create error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/qr/submit/:token — Client submits their info (PUBLIC)
// No auth required — this is called from the client's phone.
// ═══════════════════════════════════════════════════════

router.post('/submit/:token', (req, res) => {
  try {
    const { token } = req.params;
    const session = sessions.get(token);

    if (!session) {
      return res.status(404).json({ error: 'Session non trouvée ou expirée' });
    }

    // Check TTL
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(token);
      return res.status(410).json({ error: 'Session expirée' });
    }

    // Check already submitted
    if (session.data) {
      return res.status(409).json({ error: 'Informations déjà envoyées' });
    }

    const { email, phone, name } = req.body;

    if (!email && !phone) {
      return res.status(400).json({ error: 'Email ou téléphone requis' });
    }

    // Basic sanitization
    session.data = {
      email: email ? String(email).trim().substring(0, 200) : null,
      phone: phone ? String(phone).trim().substring(0, 30) : null,
      name: name ? String(name).trim().substring(0, 100) : null,
      submittedAt: Date.now(),
    };

    res.json({ ok: true, message: 'Informations envoyées' });
  } catch (error) {
    console.error('QR submit error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// GET /api/qr/poll/:token — Staff polls for client data
// Returns {pending: true} until client submits, then returns data.
// ═══════════════════════════════════════════════════════

router.get('/poll/:token', authenticateStaff, (req, res) => {
  try {
    const { token } = req.params;
    const session = sessions.get(token);

    if (!session) {
      return res.status(404).json({ error: 'Session non trouvée' });
    }

    // Verify this session belongs to the staff's merchant
    if (session.merchantId !== req.staff.merchant_id) {
      return res.status(403).json({ error: 'Session non autorisée' });
    }

    // Check TTL
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(token);
      return res.status(410).json({ error: 'Session expirée', expired: true });
    }

    // No data yet — still waiting
    if (!session.data) {
      return res.json({ pending: true });
    }

    // Data available — return it and mark consumed
    const data = session.data;
    session.consumed = true;

    // Delete session after delivery (one-time use)
    sessions.delete(token);

    res.json({
      pending: false,
      email: data.email,
      phone: data.phone,
      name: data.name,
    });
  } catch (error) {
    console.error('QR poll error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// DELETE /api/qr/session/:token — Cancel a session (staff)
// ═══════════════════════════════════════════════════════

router.delete('/session/:token', authenticateStaff, (req, res) => {
  sessions.delete(req.params.token);
  res.json({ ok: true });
});


module.exports = router;
