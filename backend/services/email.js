const nodemailer = require('nodemailer');
const crypto = require('crypto');

/**
 * Escape HTML entities in strings used in email templates.
 * Prevents HTML injection via business_name, reward_description, etc.
 */
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════
// EMAIL TRANSPORT
// ═══════════════════════════════════════════════════════

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.EMAIL_FROM || process.env.SMTP_USER || 'noreply@fiddo.be';


// ═══════════════════════════════════════════════════════
// SEND (fire-and-forget wrapper)
// ═══════════════════════════════════════════════════════

/**
 * Send an email. Never throws — logs errors to console.
 * This ensures that email failures never block business operations.
 */
async function sendMail(mailOptions) {
  if (!process.env.SMTP_USER) {
    console.log('⚠️ SMTP not configured, skipping email:', mailOptions.subject);
    return false;
  }

  try {
    await transporter.sendMail({ from: FROM, ...mailOptions });
    console.log(`✅ Email sent: "${mailOptions.subject}" → ${mailOptions.to}`);
    return true;
  } catch (error) {
    console.error(`❌ Email failed: "${mailOptions.subject}" → ${mailOptions.to}:`, error.message);
    return false;
  }
}


// ═══════════════════════════════════════════════════════
// UNSUBSCRIBE TOKENS (HMAC-signed, no DB lookup needed)
// ═══════════════════════════════════════════════════════

const UNSUB_SECRET = process.env.JWT_SECRET || 'fiddo-secret-change-me';

/**
 * Generate a tamper-proof unsubscribe token for an end_user.
 * Format: base64url(userId + ':' + hmac)
 */
function generateUnsubToken(endUserId) {
  const payload = String(endUserId);
  const hmac = crypto.createHmac('sha256', UNSUB_SECRET).update('unsub:' + payload).digest('hex').substring(0, 16);
  return Buffer.from(payload + ':' + hmac).toString('base64url');
}

/**
 * Verify and extract userId from unsubscribe token. Returns userId or null.
 */
function verifyUnsubToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const [userId, hmac] = decoded.split(':');
    if (!userId || !hmac) return null;
    const expected = crypto.createHmac('sha256', UNSUB_SECRET).update('unsub:' + userId).digest('hex').substring(0, 16);
    if (hmac !== expected) return null;
    return parseInt(userId);
  } catch (e) {
    return null;
  }
}

/**
 * Build full unsubscribe URL for an end_user.
 */
function buildUnsubUrl(endUserId) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  return `${baseUrl}/unsubscribe?token=${generateUnsubToken(endUserId)}`;
}


// ═══════════════════════════════════════════════════════
// UNIFIED TEMPLATE
// ═══════════════════════════════════════════════════════

const B = {
  teal: '#0891B2',
  tealDk: '#0E7490',
  mint: '#06D6A0',
  navy: '#0F172A',
  text: '#1E293B',
  muted: '#64748B',
  light: '#94A3B8',
  bg: '#F8FAFC',
  border: '#E2E8F0',
  ok: '#059669',
  warn: '#D97706',
  danger: '#DC2626',
};

/**
 * Wrap email body in FIDDO branded template.
 * Consistent header, footer, typography across ALL emails.
 * @param {string} body - HTML content
 * @param {string|null} unsubUrl - If provided, adds unsubscribe link in footer
 */
function template(body, unsubUrl) {
  const unsubLine = unsubUrl
    ? `<p style="margin:8px 0 0;font-size:11px;color:${B.light};">
        <a href="${unsubUrl}" style="color:${B.light};text-decoration:underline;">Se désinscrire des emails promotionnels</a>
      </p>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${B.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${B.bg};padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:white;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">

<!-- HEADER -->
<tr>
<td style="background:linear-gradient(135deg,${B.navy},#1E293B);padding:24px 32px;text-align:center;">
  <div style="font-size:22px;font-weight:800;color:${B.teal};letter-spacing:1px;">FIDDO</div>
  <div style="font-size:11px;color:${B.light};letter-spacing:0.5px;margin-top:2px;">Programme de fidélité digital</div>
</td>
</tr>

<!-- BODY -->
<tr>
<td style="padding:32px 28px;color:${B.text};font-size:15px;line-height:1.6;">
${body}
</td>
</tr>

<!-- FOOTER -->
<tr>
<td style="padding:20px 28px;border-top:1px solid ${B.border};text-align:center;">
  <p style="margin:0;font-size:11px;color:${B.light};line-height:1.5;">
    FIDDO — H3001 SRL &middot; Belgique<br>
    <a href="https://www.fiddo.be/privacy" style="color:${B.teal};text-decoration:none;">Politique de confidentialité</a>
    &nbsp;&middot;&nbsp;
    <a href="mailto:support@fiddo.be" style="color:${B.teal};text-decoration:none;">support@fiddo.be</a>
  </p>
  ${unsubLine}
</td>
</tr>

</table>
</td></tr></table>
</body>
</html>`;
}

/** Branded CTA button */
function cta(text, url) {
  return `<div style="text-align:center;margin:24px 0;">
  <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,${B.teal},${B.tealDk});color:white;padding:13px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">
    ${text}
  </a>
</div>`;
}

/** Info box (neutral — teal left border) */
function infoBox(content) {
  return `<div style="background:${B.bg};border-left:3px solid ${B.teal};padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;font-size:14px;">${content}</div>`;
}

/** Warning box (amber left border) */
function warnBox(content) {
  return `<div style="background:#FFFBEB;border-left:3px solid ${B.warn};padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;font-size:13px;color:#92400E;">${content}</div>`;
}

/** Big number highlight (points, balance…) */
function bigNum(number, label) {
  return `<div style="background:linear-gradient(135deg,${B.teal},${B.tealDk});border-radius:14px;padding:24px;margin:20px 0;text-align:center;color:white;">
  <div style="font-size:40px;font-weight:800;line-height:1;">${number}</div>
  <div style="font-size:13px;opacity:0.9;margin-top:4px;">${label}</div>
</div>`;
}

/** Progress bar for points */
function progressBar(current, target, rewardDesc) {
  const pct = Math.min((current / target) * 100, 100);
  const remaining = Math.max(target - current, 0);

  if (current >= target) {
    return `<div style="background:${B.ok};color:white;padding:18px;border-radius:12px;text-align:center;margin:20px 0;">
  <div style="font-size:15px;font-weight:700;">Récompense disponible</div>
  <div style="font-size:13px;opacity:0.9;margin-top:4px;">${escHtml(rewardDesc)}</div>
</div>`;
  }

  return `<div style="background:${B.bg};padding:14px 16px;border-radius:10px;margin:20px 0;">
  <div style="font-size:12px;color:${B.muted};margin-bottom:6px;">
    Encore <strong>${remaining}</strong> point${remaining > 1 ? 's' : ''} avant votre récompense
    <span style="float:right;font-weight:600;color:${B.navy};">${current} / ${target}</span>
  </div>
  <div style="background:${B.border};height:8px;border-radius:4px;overflow:hidden;">
    <div style="background:linear-gradient(90deg,${B.teal},${B.mint});height:100%;width:${pct}%;border-radius:4px;"></div>
  </div>
</div>`;
}

/** Heading (consistent across all emails) */
function heading(text) {
  return `<h2 style="color:${B.navy};font-size:20px;font-weight:700;margin:0 0 12px;">${text}</h2>`;
}


// ═══════════════════════════════════════════════════════
// TEMPLATES
// ═══════════════════════════════════════════════════════

/**
 * 1. Validation email (nouveau client)
 */
function sendValidationEmail(clientEmail, validationToken, businessName) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const url = `${baseUrl}/validate?token=${validationToken}`;

  sendMail({
    to: clientEmail,
    subject: `Bienvenue chez ${businessName} — Validez votre compte`,
    html: template(`
      ${heading('Bienvenue chez ' + escHtml(businessName) + ' !')}
      <p>Vous êtes inscrit(e) à notre programme de fidélité. Cliquez ci-dessous pour valider votre adresse email :</p>
      ${cta('Valider mon compte', url)}
      <p style="font-size:12px;color:${B.light};word-break:break-all;">${url}</p>
    `),
  });
}

/**
 * 2. Points crédités
 */
function sendPointsCreditedEmail(clientEmail, pointsEarned, newBalance, businessName, merchantSettings) {
  sendMail({
    to: clientEmail,
    subject: `+${pointsEarned} points chez ${businessName}`,
    html: template(`
      ${heading('Merci de votre visite !')}
      <p>Vous avez gagné des points chez <strong>${escHtml(businessName)}</strong>.</p>
      ${bigNum('+' + pointsEarned, 'points gagnés')}
      <p style="text-align:center;font-size:13px;color:${B.muted};">Nouveau solde : <strong style="color:${B.navy};">${newBalance} points</strong></p>
      ${progressBar(newBalance, merchantSettings.points_for_reward, merchantSettings.reward_description)}
    `),
  });
}

/**
 * 3. Compte marchand validé
 */
function sendMerchantValidatedEmail(merchantEmail, businessName) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  sendMail({
    to: merchantEmail,
    subject: `Votre compte ${businessName} est activé — FIDDO`,
    html: template(`
      ${heading('Votre commerce est activé !')}
      <p>Votre commerce <strong>${escHtml(businessName)}</strong> a été validé sur FIDDO.</p>
      <p>Vous pouvez maintenant vous connecter et commencer à fidéliser vos clients.</p>
      ${cta('Se connecter', baseUrl)}
    `),
  });
}

/**
 * 4. Demande marchand refusée
 */
function sendMerchantRejectedEmail(merchantEmail, businessName, reason) {
  sendMail({
    to: merchantEmail,
    subject: `Demande pour ${businessName} — FIDDO`,
    html: template(`
      ${heading('Demande non approuvée')}
      <p>Votre demande d'inscription pour <strong>${escHtml(businessName)}</strong> n'a pas pu être approuvée.</p>
      ${reason ? infoBox('<strong>Raison :</strong> ' + escHtml(reason)) : ''}
      <p>Si vous pensez qu'il s'agit d'une erreur, contactez-nous à <a href="mailto:support@fiddo.be" style="color:${B.teal};">support@fiddo.be</a>.</p>
    `),
  });
}

/**
 * 5. Notification super admin — marchand modifie ses infos
 */
function sendMerchantInfoChangedEmail(adminEmail, oldName, newName, ownerEmail, changes) {
  const rows = changes.map(c =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid ${B.border};font-weight:600;font-size:13px;">${escHtml(c.field)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid ${B.border};color:${B.danger};text-decoration:line-through;font-size:13px;">${escHtml(c.old)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid ${B.border};color:${B.ok};font-weight:600;font-size:13px;">${escHtml(c.new)}</td>
    </tr>`
  ).join('');

  sendMail({
    to: adminEmail,
    subject: `${oldName} a modifié ses informations — FIDDO Admin`,
    html: template(`
      ${heading('Modification d\'informations')}
      <p>Le propriétaire <strong>${escHtml(ownerEmail)}</strong> a modifié les informations de <strong>${escHtml(oldName)}</strong>.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border-radius:8px;overflow:hidden;border:1px solid ${B.border};">
        <thead>
          <tr style="background:${B.navy};color:white;">
            <th style="padding:10px 12px;text-align:left;font-size:12px;">Champ</th>
            <th style="padding:10px 12px;text-align:left;font-size:12px;">Ancien</th>
            <th style="padding:10px 12px;text-align:left;font-size:12px;">Nouveau</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:13px;color:${B.light};">Notification automatique — aucune action requise.</p>
    `),
  });
}

/**
 * 6. Mot de passe modifié (staff)
 */
function sendPasswordChangedEmail(staffEmail, displayName) {
  sendMail({
    to: staffEmail,
    subject: 'Mot de passe modifié — FIDDO',
    html: template(`
      ${heading('Mot de passe modifié')}
      <p>Bonjour ${escHtml(displayName)},</p>
      <p>Votre mot de passe FIDDO a été modifié avec succès.</p>
      ${warnBox('Si vous n\'êtes pas à l\'origine de cette modification, contactez immédiatement <a href="mailto:support@fiddo.be" style="color:#92400E;font-weight:600;">support@fiddo.be</a>.')}
      <p style="font-size:13px;color:${B.light};">Email de sécurité envoyé automatiquement.</p>
    `),
  });
}

/**
 * 7. Code PIN modifié (client)
 */
function sendPinChangedEmail(clientEmail, businessName) {
  return sendMail({
    to: clientEmail,
    subject: `Code PIN modifié — ${businessName}`,
    html: template(`
      ${heading('Code PIN modifié')}
      <p>Votre code PIN pour <strong>${escHtml(businessName)}</strong> a été mis à jour.</p>
      ${warnBox('Si vous n\'êtes pas à l\'origine de ce changement, contactez le commerce immédiatement.')}
      <p style="font-size:13px;color:${B.light};">Ce code est utilisé pour réclamer vos récompenses. Ne le partagez avec personne.</p>
    `),
  });
}

/**
 * 8. Magic link (connexion client)
 */
function sendMagicLinkEmail(clientEmail, magicUrl) {
  sendMail({
    to: clientEmail,
    subject: 'Votre lien de connexion — FIDDO',
    html: template(`
      ${heading('Connexion à votre espace')}
      <p>Cliquez sur le bouton ci-dessous pour accéder à vos cartes de fidélité :</p>
      ${cta('Accéder à mon compte', magicUrl)}
      <p style="font-size:13px;color:${B.light};">Ce lien est valable 15 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
    `),
  });
}

/**
 * 9. Export (CSV / backup) avec pièce jointe
 */
function sendExportEmail(ownerEmail, businessName, filename, content, mimeType) {
  const isCSV = filename.endsWith('.csv');

  return sendMail({
    to: ownerEmail,
    subject: `${isCSV ? 'Export clients' : 'Backup'} — ${businessName}`,
    html: template(`
      ${heading(isCSV ? 'Export clients' : 'Backup complet')}
      <p>Vous trouverez ci-joint ${isCSV ? "l'export CSV de vos clients" : 'le backup complet de vos données'} pour <strong>${escHtml(businessName)}</strong>.</p>
      ${infoBox('<strong>' + escHtml(filename) + '</strong>')}
      <p style="font-size:13px;color:${B.light};">Cet email a été envoyé suite à votre demande. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
    `),
    attachments: [{
      filename,
      content,
      contentType: mimeType,
    }],
  });
}

/**
 * 10. Notification fusion globale (admin → marchand)
 */
function sendGlobalMergeNotificationEmail(ownerEmail, businessName, action, sourceName, reason) {
  const actionLabel = action === 'merge'
    ? 'fusionnée avec un compte existant'
    : 'transférée depuis un autre compte';

  return sendMail({
    to: ownerEmail,
    subject: `Fusion de comptes client — ${businessName}`,
    html: template(`
      ${heading('Fusion de comptes client')}
      <p>L'équipe FIDDO a effectué une fusion de comptes client qui concerne <strong>${escHtml(businessName)}</strong>.</p>
      ${infoBox(`
        <strong>Action :</strong> Fiche client ${actionLabel}<br>
        <strong>Client concerné :</strong> ${escHtml(sourceName) || '—'}<br>
        <strong>Motif :</strong> ${escHtml(reason)}
      `)}
      <p>Les détails sont visibles dans l'historique des transactions du client.</p>
      <p style="font-size:13px;color:${B.light};">Notification automatique — aucune action requise.</p>
    `),
  });
}

/**
 * 11. Welcome (premier passage chez un marchand)
 */
function sendWelcomeEmail(clientEmail, merchantName, pointsBalance, appUrl, endUserId) {
  const hero = pointsBalance > 0
    ? bigNum(pointsBalance, 'points chez ' + escHtml(merchantName))
    : bigNum('✓', 'Carte activée chez ' + escHtml(merchantName));

  const unsubUrl = endUserId ? buildUnsubUrl(endUserId) : null;

  sendMail({
    to: clientEmail,
    subject: `Bienvenue chez ${merchantName} — FIDDO`,
    headers: unsubUrl ? { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {},
    html: template(`
      ${heading('Bienvenue chez ' + escHtml(merchantName) + ' !')}
      <p>Votre carte de fidélité est activée. Vous cumulez des points à chaque visite et débloquez des récompenses exclusives.</p>
      ${hero}
      <p>Téléchargez l'app FIDDO pour suivre vos points et vous identifier plus rapidement :</p>
      ${cta("Ouvrir l'app FIDDO", appUrl || 'https://www.fiddo.be/app/')}
      <p style="font-size:12px;color:${B.light};">Pas besoin de l'app pour accumuler des points — elle est 100% optionnelle. Votre carte fonctionne avec votre adresse email.</p>
    `, unsubUrl),
  });
}

/**
 * 12. Rappel app (3 jours après premier passage)
 */
function sendAppReminderEmail(clientEmail, merchantName, pointsBalance, appUrl, endUserId) {
  const unsubUrl = endUserId ? buildUnsubUrl(endUserId) : null;

  sendMail({
    to: clientEmail,
    subject: `Vos ${pointsBalance} points vous attendent — FIDDO`,
    headers: unsubUrl ? { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {},
    html: template(`
      ${heading('Vos points vous attendent !')}
      <p>Vous avez <strong>${pointsBalance} points</strong> chez <strong>${escHtml(merchantName)}</strong>. Téléchargez l'app pour suivre votre progression et ne manquer aucune récompense.</p>
      ${cta("Ouvrir l'app FIDDO", appUrl || 'https://www.fiddo.be/app/')}
      <p style="font-size:12px;color:${B.light};">L'app est gratuite et ne prend que quelques secondes à installer.</p>
    `, unsubUrl),
  });
}

/**
 * 13. Compte supprimé (client)
 */
function sendAccountDeletedEmail(clientEmail) {
  return sendMail({
    to: clientEmail,
    subject: 'Votre compte a été supprimé — FIDDO',
    html: template(`
      <div style="text-align:center;margin-bottom:20px;">
        <div style="width:56px;height:56px;border-radius:50%;background:#FEE2E2;display:inline-flex;align-items:center;justify-content:center;font-size:24px;color:${B.danger};">✕</div>
      </div>
      ${heading('<div style="text-align:center;">Compte supprimé</div>')}
      <p style="text-align:center;">Votre compte FIDDO a été supprimé avec succès. Toutes vos données personnelles ont été anonymisées.</p>
      ${warnBox('Si vous n\'êtes pas à l\'origine de cette demande, contactez-nous immédiatement à <a href="mailto:support@fiddo.be" style="color:#92400E;font-weight:600;">support@fiddo.be</a>.')}
    `),
  });
}

module.exports = {
  sendMail,
  escHtml,
  sendValidationEmail,
  sendPointsCreditedEmail,
  sendMerchantValidatedEmail,
  sendMerchantRejectedEmail,
  sendMerchantInfoChangedEmail,
  sendPasswordChangedEmail,
  sendPinChangedEmail,
  sendMagicLinkEmail,
  sendExportEmail,
  sendGlobalMergeNotificationEmail,
  sendWelcomeEmail,
  sendAppReminderEmail,
  sendAccountDeletedEmail,
  verifyUnsubToken,
};
