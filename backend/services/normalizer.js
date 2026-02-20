// ═══════════════════════════════════════════════════════
// services/normalizer.js
// Email + phone normalization for consistent identity
// ═══════════════════════════════════════════════════════

/**
 * Normalize email for storage and lookup.
 * Rule: trim + toLowerCase only.
 * No Gmail dot-stripping, no +tag removal — that belongs in
 * the duplicate detector, not in the primary key.
 *
 * @param {string|null|undefined} email
 * @returns {string|null} normalized email or null
 */
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return null;
  // Basic format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Normalize phone to E.164 format.
 * Default country: Belgium (+32).
 *
 * Accepted inputs:
 *   +32497123456      → +32497123456
 *   0032497123456     → +32497123456
 *   0497123456        → +32497123456
 *   0497 12 34 56     → +32497123456
 *   497123456         → +32497123456
 *
 * @param {string|null|undefined} phone
 * @param {string} defaultCountryCode - default "+32"
 * @returns {string|null} E.164 phone or null
 */
function normalizePhone(phone, defaultCountryCode = '+32') {
  if (!phone || typeof phone !== 'string') return null;

  // Strip all non-digit chars except leading +
  let cleaned = phone.trim();
  const hasPlus = cleaned.startsWith('+');
  cleaned = cleaned.replace(/[^\d]/g, '');

  if (!cleaned || cleaned.length < 8) return null;

  // Already international with +
  if (hasPlus) {
    return '+' + cleaned;
  }

  // International with 00 prefix (e.g., 0032...)
  if (cleaned.startsWith('00')) {
    return '+' + cleaned.substring(2);
  }

  // Local format with leading 0 (e.g., 0497...)
  if (cleaned.startsWith('0')) {
    return defaultCountryCode + cleaned.substring(1);
  }

  // Raw digits, assume local without leading 0 (e.g., 497123456)
  return defaultCountryCode + cleaned;
}

/**
 * Validate email format (basic).
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Validate phone (after normalization, must be 10-15 digits).
 * @param {string} phone - raw input
 * @returns {boolean}
 */
function isValidPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  // E.164: + followed by 10-15 digits
  return /^\+\d{10,15}$/.test(normalized);
}

/**
 * Validate Belgian VAT number.
 * Format: BE0 followed by 9 digits (e.g., BE0123456789).
 * @param {string} vat
 * @returns {string|null} normalized VAT or null if invalid
 */
function normalizeVAT(vat) {
  if (!vat || typeof vat !== 'string') return null;
  const cleaned = vat.replace(/[\s.]/g, '').toUpperCase();
  if (!/^BE0\d{9}$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Canonicalize email for duplicate detection.
 * Gmail/Googlemail only: strips dots and +tags from local part.
 *   hakim.abbes@gmail.com      → hakimabbes@gmail.com
 *   hakim.abbes+75@gmail.com   → hakimabbes@gmail.com
 *   h.a.k.i.m@gmail.com       → hakim@gmail.com
 * Non-Gmail: returns normalizeEmail() unchanged (dots/+tags may matter).
 *
 * @param {string|null|undefined} email
 * @returns {string|null} canonical email or null
 */
function canonicalizeEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const [local, domain] = normalized.split('@');
  if (!local || !domain) return normalized;

  // Only Gmail/Googlemail treat dots and +tags as identical
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const stripped = local.split('+')[0].replace(/\./g, '');
    return stripped + '@gmail.com'; // googlemail.com → gmail.com
  }

  return normalized;
}

module.exports = {
  normalizeEmail,
  canonicalizeEmail,
  normalizePhone,
  isValidEmail,
  isValidPhone,
  normalizeVAT,
};
