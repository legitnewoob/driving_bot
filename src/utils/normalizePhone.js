/**
 * Normalize a UK phone number to the E.164 digits-only format used by the
 * WhatsApp Cloud API (e.g. "447700900000"), matching the format of the
 * `from` field on inbound webhook messages.
 *
 * Accepts UK-local format ("07700 000000"), E.164 with/without "+"
 * ("+447700900000", "447700900000"), and strips any spaces/dashes.
 *
 * @param {string} phone
 * @returns {string}
 */
function normalizePhone(phone) {
  if (!phone) return phone;

  const digits = phone.replace(/[^\d]/g, "");

  if (digits.startsWith("0")) {
    return `44${digits.slice(1)}`;
  }

  return digits;
}

module.exports = { normalizePhone };
