const nodemailer = require('nodemailer');

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
        <h2 style="color: #0891B2;">Bienvenue chez ${businessName} ! 🎉</h2>
        <p>Vous êtes inscrit(e) à notre programme de fidélité.</p>
        <p>Cliquez ci-dessous pour valider votre compte :</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${validationUrl}"
             style="background-color: #0891B2; color: white; padding: 15px 30px;
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
        <p style="margin: 10px 0 0;">Présentez-vous pour bénéficier de : <strong>${merchantSettings.reward_description}</strong></p>
      </div>
    `;
  } else {
    rewardSection = `
      <div style="background-color: #f5f5f5; padding: 15px; border-radius: 10px; margin: 20px 0;">
        <p style="margin: 0;">Plus que <strong>${pointsRemaining} points</strong> avant votre récompense !</p>
        <div style="background-color: #ddd; height: 20px; border-radius: 10px; overflow: hidden; margin-top: 10px;">
          <div style="background-color: #0891B2; height: 100%; width: ${progressPercent}%;"></div>
        </div>
      </div>
    `;
  }

  sendMail({
    to: clientEmail,
    subject: `${businessName} - +${pointsEarned} points gagnés ! 🌟`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #0891B2;">Merci de votre visite ! ✨</h2>
        <div style="background-color: #0891B2; color: white; padding: 20px; border-radius: 10px; text-align: center;">
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
          ${businessName} | Programme de fidélité
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
        <h2 style="color: #0891B2;">Félicitations ! 🎉</h2>
        <p>Votre commerce <strong>${businessName}</strong> a été validé sur FIDDO.</p>
        <p>Vous pouvez maintenant vous connecter et commencer à fidéliser vos clients.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.BASE_URL || 'http://localhost:3000'}"
             style="background-color: #0891B2; color: white; padding: 15px 30px;
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
        <p>Votre demande d'inscription pour <strong>${businessName}</strong> n'a pas pu être approuvée.</p>
        ${reason ? `<p><strong>Raison :</strong> ${reason}</p>` : ''}
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
    `<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:600;">${c.field}</td>
     <td style="padding:6px 12px;border:1px solid #ddd;color:#EF4444;text-decoration:line-through;">${c.old}</td>
     <td style="padding:6px 12px;border:1px solid #ddd;color:#10B981;font-weight:600;">${c.new}</td></tr>`
  ).join('');

  sendMail({
    to: adminEmail,
    subject: `🔔 FIDDO Admin — ${oldName} a modifié ses informations`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1F2937;">🔔 Modification d'informations commerce</h2>
        <p>Le propriétaire <strong>${ownerEmail}</strong> a modifié les informations de <strong>${oldName}</strong>.</p>
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
        <h2 style="color: #0891B2;">Mot de passe modifié 🔒</h2>
        <p>Bonjour ${displayName},</p>
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
  sendMail({
    to: clientEmail,
    subject: `${businessName} — Votre code PIN fidélité a été modifié 🔒`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #0891B2;">Code PIN modifié 🔒</h2>
        <p>Votre code PIN de fidélité chez <strong>${businessName}</strong> a été modifié.</p>
        <div style="background-color: #FEF3C7; border-left: 4px solid #F59E0B; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 0; color: #92400E;">
            <strong>⚠️ Vous n'êtes pas à l'origine de ce changement ?</strong><br>
            Rendez-vous en personne chez <strong>${businessName}</strong> pour faire corriger votre code PIN.
          </p>
        </div>
        <p style="font-size: 13px; color: #666;">
          Ce code PIN protège vos récompenses fidélité. Ne le partagez avec personne.
        </p>
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #666; text-align: center;">
          ${businessName} | Programme de fidélité
        </p>
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
        <h1 style="color: #0891B2; font-size: 24px; margin-bottom: 8px;">FIDDO</h1>
        <p style="color: #64748B; font-size: 14px; margin-bottom: 24px;">Votre espace fidélité</p>
        <p style="color: #1E293B; font-size: 16px; line-height: 1.5;">
          Cliquez sur le bouton ci-dessous pour accéder à vos cartes de fidélité :
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${magicUrl}" style="background: linear-gradient(135deg, #0891B2, #0E7490); color: white; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block;">
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

module.exports = {
  sendMail,
  sendValidationEmail,
  sendPointsCreditedEmail,
  sendMerchantValidatedEmail,
  sendMerchantRejectedEmail,
  sendMerchantInfoChangedEmail,
  sendPasswordChangedEmail,
  sendPinChangedEmail,
  sendMagicLinkEmail,
};
