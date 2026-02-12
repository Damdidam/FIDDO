const express = require('express');
const bcrypt = require('bcryptjs');
const { staffQueries } = require('../database');
const { authenticateStaff, requireRole } = require('../middleware/auth');
const { logAudit, auditCtx } = require('../middleware/audit');
const { normalizeEmail } = require('../services/normalizer');

const router = express.Router();

// All routes: owner only
router.use(authenticateStaff);
router.use(requireRole('owner'));


// ═══════════════════════════════════════════════════════
// GET /api/staff — List staff members
// ═══════════════════════════════════════════════════════

router.get('/', (req, res) => {
  try {
    const members = staffQueries.getByMerchant.all(req.staff.merchant_id);
    res.json({ count: members.length, staff: members });
  } catch (error) {
    console.error('Erreur liste staff:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// POST /api/staff — Create a staff member (manager or cashier)
// ═══════════════════════════════════════════════════════

router.post('/', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // ── Validate fields ──
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nom, email et mot de passe requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    // Only manager or cashier — owner is set at registration
    if (!['manager', 'cashier'].includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide (manager ou cashier)' });
    }

    // ── Normalize email ──
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    // ── Global uniqueness check ──
    const existing = staffQueries.findByEmail.get(normalizedEmail);
    if (existing) {
      return res.status(400).json({ error: 'Cet email est déjà utilisé pour un compte' });
    }

    // ── Create ──
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = staffQueries.create.run(
      req.staff.merchant_id,
      normalizedEmail,
      hashedPassword,
      name.trim(),
      role,
      1 // is_active = true (no validation needed, owner adds them)
    );

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId: req.staff.merchant_id,
      action: 'staff_created',
      targetType: 'staff',
      targetId: result.lastInsertRowid,
      details: { email: normalizedEmail, role },
    });

    res.status(201).json({
      message: `${role === 'manager' ? 'Manager' : 'Caissier'} ajouté avec succès`,
      staffId: result.lastInsertRowid,
    });
  } catch (error) {
    console.error('Erreur création staff:', error);
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});


// ═══════════════════════════════════════════════════════
// PUT /api/staff/:id/role — Change role (manager ↔ cashier only)
// ═══════════════════════════════════════════════════════

router.put('/:id/role', (req, res) => {
  try {
    const staffId = parseInt(req.params.id);
    const { role } = req.body;

    if (!['manager', 'cashier'].includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide (manager ou cashier)' });
    }

    // ── Find staff (tenant-isolated) ──
    const member = staffQueries.findByIdAndMerchant.get(staffId, req.staff.merchant_id);
    if (!member) {
      return res.status(404).json({ error: 'Membre non trouvé' });
    }

    // Cannot change owner role
    if (member.role === 'owner') {
      return res.status(403).json({ error: 'Impossible de modifier le rôle du propriétaire' });
    }

    // No-op check
    if (member.role === role) {
      return res.json({ message: 'Rôle déjà défini' });
    }

    staffQueries.updateRole.run(role, staffId);

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId: req.staff.merchant_id,
      action: 'staff_role_changed',
      targetType: 'staff',
      targetId: staffId,
      details: { oldRole: member.role, newRole: role },
    });

    res.json({ message: `Rôle modifié en ${role}` });
  } catch (error) {
    console.error('Erreur changement rôle:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// PUT /api/staff/:id/toggle — Activate / Deactivate
// ═══════════════════════════════════════════════════════

router.put('/:id/toggle', (req, res) => {
  try {
    const staffId = parseInt(req.params.id);

    const member = staffQueries.findByIdAndMerchant.get(staffId, req.staff.merchant_id);
    if (!member) {
      return res.status(404).json({ error: 'Membre non trouvé' });
    }

    // ── Cannot deactivate self ──
    if (staffId === req.staff.id) {
      return res.status(403).json({ error: 'Vous ne pouvez pas vous désactiver vous-même' });
    }

    // ── If deactivating an owner, check we keep at least 1 active owner ──
    if (member.is_active && member.role === 'owner') {
      const { count } = staffQueries.countActiveOwners.get(req.staff.merchant_id);
      if (count <= 1) {
        return res.status(403).json({ error: 'Impossible : il doit rester au moins un propriétaire actif' });
      }
    }

    if (member.is_active) {
      staffQueries.deactivate.run(staffId);
    } else {
      staffQueries.activate.run(staffId);
    }

    const newState = !member.is_active;

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId: req.staff.merchant_id,
      action: newState ? 'staff_activated' : 'staff_deactivated',
      targetType: 'staff',
      targetId: staffId,
    });

    res.json({
      message: newState ? 'Membre activé' : 'Membre désactivé',
      is_active: newState ? 1 : 0,
    });
  } catch (error) {
    console.error('Erreur toggle staff:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// PUT /api/staff/:id/password — Reset password
// ═══════════════════════════════════════════════════════

router.put('/:id/password', async (req, res) => {
  try {
    const staffId = parseInt(req.params.id);
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe minimum 6 caractères' });
    }

    const member = staffQueries.findByIdAndMerchant.get(staffId, req.staff.merchant_id);
    if (!member) {
      return res.status(404).json({ error: 'Membre non trouvé' });
    }

    const hashed = await bcrypt.hash(password, 10);
    staffQueries.updatePassword.run(hashed, staffId);

    // Reset failed login count in case account was locked
    staffQueries.resetFailedLogins.run(staffId);

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId: req.staff.merchant_id,
      action: 'staff_password_reset',
      targetType: 'staff',
      targetId: staffId,
    });

    res.json({ message: 'Mot de passe réinitialisé' });
  } catch (error) {
    console.error('Erreur reset password:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ═══════════════════════════════════════════════════════
// DELETE /api/staff/:id — Delete staff member
// ═══════════════════════════════════════════════════════

router.delete('/:id', (req, res) => {
  try {
    const staffId = parseInt(req.params.id);

    const member = staffQueries.findByIdAndMerchant.get(staffId, req.staff.merchant_id);
    if (!member) {
      return res.status(404).json({ error: 'Membre non trouvé' });
    }

    // ── Cannot delete self ──
    if (staffId === req.staff.id) {
      return res.status(403).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });
    }

    // ── Cannot delete an owner (protection absolute) ──
    if (member.role === 'owner') {
      return res.status(403).json({ error: 'Impossible de supprimer un propriétaire' });
    }

    staffQueries.delete.run(staffId, req.staff.merchant_id);

    logAudit({
      ...auditCtx(req),
      actorType: 'staff',
      actorId: req.staff.id,
      merchantId: req.staff.merchant_id,
      action: 'staff_deleted',
      targetType: 'staff',
      targetId: staffId,
      details: { email: member.email, role: member.role },
    });

    res.json({ message: 'Membre supprimé' });
  } catch (error) {
    console.error('Erreur suppression staff:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


module.exports = router;
