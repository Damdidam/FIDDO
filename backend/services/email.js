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

  // Fire-and-forget: don't await in the calling code
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
 * Email de confirmation d'inscription (envoyé au owner après register).
 */
function sendRegistrationConfirmationEmail(ownerEmail, businessName) {
  sendMail({
    to: ownerEmail,
    subject: `FIDDO - Demande d'inscription reçue pour ${businessName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #0891B2;">Demande d'inscription reçue ! 📋</h2>
        <p>Bonjour,</p>
        <p>Nous avons bien reçu votre demande d'inscription pour <strong>${businessName}</strong> sur FIDDO.</p>
        <div style="background-color: #f5f5f5; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Prochaine étape :</strong></p>
          <p style="margin: 10px 0 0;">Notre équipe va vérifier vos informations. Vous recevrez un email dès que votre compte sera activé.</p>
        </div>
        <p>Ce processus prend généralement <strong>24 à 48 heures</strong>.</p>
        <p>Si vous avez des questions, contactez-nous à <a href="mailto:support@fiddo.be">support@fiddo.be</a>.</p>
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #666; text-align: center;">
          FIDDO — Programme de fidélité pour restaurateurs
        </p>
      </div>
    `,
  });
}

module.exports = {
  sendValidationEmail,
  sendPointsCreditedEmail,
  sendMerchantValidatedEmail,
  sendMerchantRejectedEmail,
  sendRegistrationConfirmationEmail,
};
