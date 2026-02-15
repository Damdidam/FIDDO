const nodemailer = require('nodemailer');

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
// TEMPLATES
// ═══════════════════════════════════════════════════════

/**
 * Email de validation initiale (nouveau client).
 */
function sendValidationEmail(clientEmail, validationToken, businessName) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const validationUrl = `${baseUrl}/validate?token=${validationToken}`;

  sendMail({
    to: clientEmail,
    subject: `Bienvenue chez ${businessName} - Validez votre compte fidélité`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #3b82f6;">Bienvenue chez ${escHtml(businessName)} ! 🎉</h2>
        <p>Vous êtes inscrit(e) à notre programme de fidélité.</p>
        <p>Cliquez ci-dessous pour valider votre compte :</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${validationUrl}"
             style="background-color: #3b82f6; color: white; padding: 15px 30px;
                    text-decoration: none; border-radius: 5px; font-weight: bold;">
            Valider mon compte
          </a>
        </div>
        <p style="font-size: 12px; color: #666;">
          Lien : ${validationUrl}
        </p>
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #666;">
          Conformément au RGPD, vous pouvez demander la suppression de vos données à tout moment.
        </p>
      </div>
    `,
  });
}

/**
 * Email de confirmation de points crédités.
 */
function sendPointsCreditedEmail(clientEmail, pointsEarned, newBalance, businessName, merchantSettings) {
  const progressPercent = Math.min((newBalance / merchantSettings.points_for_reward) * 100, 100);
  const pointsRemaining = Math.max(merchantSettings.points_for_reward - newBalance, 0);

  let rewardSection;
  if (newBalance >= merchantSettings.points_for_reward) {
    rewardSection = `
      <div style="background-color: #10B981; color: white; padding: 20px; border-radius: 10px; text-align: center; margin: 20px 0;">
        <h3 style="margin: 0;">🎁 Récompense disponible !</h3>
        <p style="margin: 10px 0 0;">Présentez-vous pour bénéficier de : <strong>${escHtml(merchantSettings.reward_description)}</strong></p>
      </div>
    `;
  } else {
    rewardSection = `
      <div style="background-color: #f5f5f5; padding: 15px; border-radius: 10px; margin: 20px 0;">
        <p style="margin: 0;">Plus que <strong>${pointsRemaining} points</strong> avant votre récompense !</p>
        <div style="background-color: #ddd; height: 20px; border-radius: 10px; overflow: hidden; margin-top: 10px;">
          <div style="background-color: #3b82f6; height: 100%; width: ${progressPercent}%;"></div>
        </div>
      </div>
    `;
  }

  sendMail({
    to: clientEmail,
    subject: `${businessName} - +${pointsEarned} points gagnés ! 🌟`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #3b82f6;">Merci de votre visite ! ✨</h2>
        <div style="background-color: #3b82f6; color: white; padding: 20px; border-radius: 10px; text-align: center;">
          <p style="margin: 0; font-size: 16px;">Vous avez gagné</p>
          <p style="margin: 10px 0; font-size: 48px; font-weight: bold;">+${pointsEarned}</p>
          <p style="margin: 0; font-size: 16px;">points</p>
        </div>
        <div style="text-align: center; margin: 20px 0; font-size: 24px;">
          <strong>Solde : ${newBalance} points</strong>
        </div>
        ${rewardSection}
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #666; text-align: center;">
          ${escHtml(businessName)} | Programme de fidélité
        </p>
      </div>
    `,
  });
}

/**
 * Email de confirmation de validation du merchant.
 */
function sendMerchantValidatedEmail(merchantEmail, businessName) {
  sendMail({
    to: merchantEmail,
    subject: `FIDDO - Votre compte ${businessName} est activé ! 🎉`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #3b82f6;">Félicitations ! 🎉</h2>
        <p>Votre commerce <strong>${escHtml(businessName)}</strong> a été validé sur FIDDO.</p>
        <p>Vous pouvez maintenant vous connecter et commencer à fidéliser vos clients.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.BASE_URL || 'http://localhost:3000'}"
             style="background-color: #3b82f6; color: white; padding: 15px 30px;
                    text-decoration: none; border-radius: 5px; font-weight: bold;">
            Se connecter
          </a>
        </div>
      </div>
    `,
  });
}

/**
 * Email de refus du merchant.
 */
function sendMerchantRejectedEmail(merchantEmail, businessName, reason) {
  sendMail({
    to: merchantEmail,
    subject: `FIDDO - Demande pour ${businessName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #EF4444;">Demande non approuvée</h2>
        <p>Votre demande d'inscription pour <strong>${escHtml(businessName)}</strong> n'a pas pu être approuvée.</p>
        ${reason ? `<p><strong>Raison :</strong> ${escHtml(reason)}</p>` : ''}
        <p>Si vous pensez qu'il s'agit d'une erreur, contactez-nous à support@fiddo.be.</p>
      </div>
    `,
  });
}

/**
 * Email de notification au super admin quand un merchant modifie ses infos.
 */
function sendMerchantInfoChangedEmail(adminEmail, oldName, newName, ownerEmail, changes) {
  const changeRows = changes.map(c =>
    `<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:600;">${escHtml(c.field)}</td>
     <td style="padding:6px 12px;border:1px solid #ddd;color:#EF4444;text-decoration:line-through;">${escHtml(c.old)}</td>
     <td style="padding:6px 12px;border:1px solid #ddd;color:#10B981;font-weight:600;">${escHtml(c.new)}</td></tr>`
  ).join('');

  sendMail({
    to: adminEmail,
    subject: `🔔 FIDDO Admin — ${oldName} a modifié ses informations`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1F2937;">🔔 Modification d'informations commerce</h2>
        <p>Le propriétaire <strong>${escHtml(ownerEmail)}</strong> a modifié les informations de <strong>${escHtml(oldName)}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;">
          <thead>
            <tr style="background:#1F2937;color:white;">
              <th style="padding:8px 12px;text-align:left;">Champ</th>
              <th style="padding:8px 12px;text-align:left;">Ancien</th>
              <th style="padding:8px 12px;text-align:left;">Nouveau</th>
            </tr>
          </thead>
          <tbody>${changeRows}</tbody>
        </table>
        <p style="font-size:12px;color:#666;">Aucune action requise — notification automatique.</p>
      </div>
    `,
  });
}

/**
 * Email de confirmation de changement de mot de passe.
 */
function sendPasswordChangedEmail(staffEmail, displayName) {
  sendMail({
    to: staffEmail,
    subject: 'FIDDO — Votre mot de passe a été modifié',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #3b82f6;">Mot de passe modifié 🔒</h2>
        <p>Bonjour ${escHtml(displayName)},</p>
        <p>Votre mot de passe FIDDO a été modifié avec succès.</p>
        <p>Si vous n'êtes pas à l'origine de cette modification, contactez immédiatement <strong>support@fiddo.be</strong>.</p>
        <hr style="margin:30px 0;border:none;border-top:1px solid #ddd;">
        <p style="font-size:12px;color:#666;">Email de sécurité envoyé automatiquement.</p>
      </div>
    `,
  });
}

/**
 * Email de notification de changement de code PIN fidélité.
 */
function sendPinChangedEmail(clientEmail, businessName) {
  return sendMail({
    to: clientEmail,
    subject: `Votre code PIN a été modifié — ${businessName}`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: auto; padding: 2rem;">
        <h2 style="color: #3b82f6;">🔒 Code PIN modifié</h2>
        <p>Bonjour,</p>
        <p>Votre code PIN pour <strong>${escHtml(businessName)}</strong> a été mis à jour.</p>
        <div style="background: #FEF3C7; border-left: 3px solid #F59E0B; padding: 1rem; margin: 1rem 0; border-radius: 4px;">
          <p style="margin: 0; font-size: 0.9rem;">⚠️ Si vous n'êtes pas à l'origine de ce changement, veuillez contacter le commerce immédiatement.</p>
        </div>
        <p style="color: #6b7280; font-size: 0.85rem;">Ce code est utilisé pour réclamer vos récompenses. Ne le partagez avec personne.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 1.5rem 0;">
        <p style="font-size: 0.75rem; color: #94a3b8;">FIDDO — Programme de fidélité</p>
      </div>
    `,
  });
}


function sendMagicLinkEmail(clientEmail, magicUrl) {
  sendMail({
    to: clientEmail,
    subject: 'Votre lien de connexion FIDDO',
    html: `
      <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <h1 style="color: #3b82f6; font-size: 24px; margin-bottom: 8px;">FIDDO</h1>
        <p style="color: #64748B; font-size: 14px; margin-bottom: 24px;">Votre espace fidélité</p>
        <p style="color: #1E293B; font-size: 16px; line-height: 1.5;">
          Cliquez sur le bouton ci-dessous pour accéder à vos cartes de fidélité :
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${magicUrl}" style="background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block;">
            Accéder à mon compte
          </a>
        </div>
        <p style="color: #94A3B8; font-size: 13px; line-height: 1.5;">
          Ce lien est valable 15 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.
        </p>
      </div>
    `,
  });
}

/**
 * Email d'export avec pièce jointe (CSV ou backup).
 */
function sendExportEmail(ownerEmail, businessName, filename, content, mimeType) {
  const isCSV = filename.endsWith('.csv');
  return sendMail({
    to: ownerEmail,
    subject: `FIDDO — ${isCSV ? 'Export clients' : 'Backup'} ${businessName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #3b82f6;">${isCSV ? '📥 Export clients' : '💾 Backup'}</h2>
        <p>Bonjour,</p>
        <p>Vous trouverez ci-joint ${isCSV ? "l'export CSV de vos clients" : 'le backup complet de vos données'} pour <strong>${escHtml(businessName)}</strong>.</p>
        <p style="background: #F1F5F9; padding: 12px 16px; border-radius: 8px; font-size: 14px;">
          📎 <strong>${escHtml(filename)}</strong>
        </p>
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #666;">
          Cet email a été envoyé suite à votre demande depuis l'interface FIDDO.
          Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.
        </p>
      </div>
    `,
    attachments: [{
      filename,
      content,
      contentType: mimeType,
    }],
  });
}

/**
 * Notify merchant owner that a global merge affected one of their clients.
 */
function sendGlobalMergeNotificationEmail(ownerEmail, businessName, action, sourceName, reason) {
  const actionLabel = action === 'merge'
    ? 'fusionnée avec un compte existant'
    : 'transférée depuis un autre compte';

  return sendMail({
    to: ownerEmail,
    subject: `[FIDDO] Fusion de comptes client — ${businessName}`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: auto; padding: 2rem;">
        <h2 style="color: #3b82f6;">🔀 Fusion de comptes client</h2>
        <p>Bonjour,</p>
        <p>L'équipe FIDDO a effectué une fusion de comptes client qui concerne <strong>${escHtml(businessName)}</strong>.</p>
        <div style="background: #f8fafc; border-left: 3px solid #3b82f6; padding: 1rem; margin: 1rem 0; border-radius: 4px;">
          <p style="margin: 0;"><strong>Action :</strong> Fiche client ${actionLabel}</p>
          <p style="margin: 0.5rem 0 0;"><strong>Client concerné :</strong> ${escHtml(sourceName) || '—'}</p>
          <p style="margin: 0.5rem 0 0;"><strong>Motif :</strong> ${escHtml(reason)}</p>
        </div>
        <p>Les détails sont visibles dans l'historique des transactions du client (type : <em>merge</em>).</p>
        <p style="color: #6b7280; font-size: 0.85rem;">Aucune action requise de votre part.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 1.5rem 0;">
        <p style="font-size: 0.75rem; color: #94a3b8;">FIDDO — Programme de fidélité</p>
      </div>
    `,
  });
}

/**
 * Welcome email — sent after first identification at a merchant via QR landing.
 * Includes points info and app download link.
 */
function sendWelcomeEmail(clientEmail, merchantName, pointsBalance, appUrl) {
  const pointsSection = pointsBalance > 0
    ? `<div style="background: linear-gradient(135deg, #3b82f6, #2563eb); border-radius: 16px; padding: 24px; margin: 24px 0; text-align: center; color: white;">
          <div style="font-size: 36px; font-weight: 800;">${pointsBalance}</div>
          <div style="font-size: 14px; opacity: 0.9; margin-top: 4px;">points chez ${escHtml(merchantName)}</div>
        </div>`
    : `<div style="background: linear-gradient(135deg, #3b82f6, #2563eb); border-radius: 16px; padding: 24px; margin: 24px 0; text-align: center; color: white;">
          <div style="font-size: 24px; font-weight: 800;">✓ Carte activée</div>
          <div style="font-size: 14px; opacity: 0.9; margin-top: 4px;">chez ${escHtml(merchantName)}</div>
        </div>`;

  sendMail({
    to: clientEmail,
    subject: `Bienvenue chez ${merchantName} — FIDDO`,
    html: `
      <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <h1 style="color: #3b82f6; font-size: 24px; margin-bottom: 4px;">FIDDO</h1>
        <p style="color: #64748B; font-size: 14px; margin-bottom: 28px;">Votre fidélité récompensée</p>

        <h2 style="color: #1E293B; font-size: 20px; margin-bottom: 16px;">Bienvenue chez ${escHtml(merchantName)} ! 🎉</h2>

        <p style="color: #1E293B; font-size: 15px; line-height: 1.6;">
          Votre carte de fidélité est activée. Vous cumulez des points à chaque visite et
          débloquez des récompenses exclusives.
        </p>

        ${pointsSection}

        <p style="color: #1E293B; font-size: 15px; line-height: 1.6;">
          Téléchargez l'app FIDDO pour suivre vos points, recevoir des notifications
          et vous identifier plus rapidement :
        </p>

        <div style="text-align: center; margin: 28px 0;">
          <a href="${appUrl || 'https://www.fiddo.be/app/'}" style="background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block;">
            Télécharger l'app
          </a>
        </div>

        <p style="color: #94A3B8; font-size: 12px; line-height: 1.5;">
          Pas besoin de l'app pour accumuler des points — elle est 100% optionnelle.
          Votre carte fonctionne avec votre adresse email.
        </p>
      </div>
    `,
  });
}


/**
 * App reminder — sent 3 days after first identification if user hasn't opened the app.
 */
function sendAppReminderEmail(clientEmail, merchantName, pointsBalance, appUrl) {
  sendMail({
    to: clientEmail,
    subject: `Vos ${pointsBalance} points vous attendent — FIDDO`,
    html: `
      <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <h1 style="color: #3b82f6; font-size: 24px; margin-bottom: 4px;">FIDDO</h1>
        <p style="color: #64748B; font-size: 14px; margin-bottom: 28px;">Votre fidélité récompensée</p>

        <h2 style="color: #1E293B; font-size: 20px; margin-bottom: 16px;">Vos points vous attendent ! 📱</h2>

        <p style="color: #1E293B; font-size: 15px; line-height: 1.6;">
          Vous avez <strong>${pointsBalance} points</strong> chez <strong>${escHtml(merchantName)}</strong>.
          Téléchargez l'app pour suivre votre progression et ne manquer aucune récompense.
        </p>

        <div style="text-align: center; margin: 28px 0;">
          <a href="${appUrl || 'https://www.fiddo.be/app/'}" style="background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block;">
            Télécharger l'app
          </a>
        </div>

        <p style="color: #94A3B8; font-size: 12px; line-height: 1.5;">
          L'app est gratuite et ne prend que quelques secondes à installer.
        </p>
      </div>
    `,
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
};
