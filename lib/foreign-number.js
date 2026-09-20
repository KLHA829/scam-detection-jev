'use strict';

const CN_EXCLUSIONS = new Set(['880', '881', '882', '883', '888']);

function extractDigits(input) {
  if (input == null) return '';
  const digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('00') && digits.length > 2) {
    return digits.slice(2);
  }
  return digits;
}

function isChinaExclusionPrefix(digits) {
  if (!digits) return false;
  return CN_EXCLUSIONS.has(digits.slice(0, 3));
}

/**
 * Local dials: HK (852), TW (886), CN (86).
 * Check 3-digit codes first so 886 is Taiwan, not China.
 * 880–883 and 888 are never treated as CN even if a naive `86` prefix is used.
 */
function isLocalDial(formattedNumber) {
  const digits = extractDigits(formattedNumber);
  if (!digits) return false;
  if (digits.startsWith('852')) return true;
  if (digits.startsWith('886')) return true;
  if (isChinaExclusionPrefix(digits)) return false;
  if (digits.startsWith('86')) return true;
  return false;
}

function isNonLocalDial(formattedNumber) {
  const digits = extractDigits(formattedNumber);
  if (!digits) return false;
  return !isLocalDial(digits);
}

module.exports = {
  CN_EXCLUSIONS,
  extractDigits,
  isChinaExclusionPrefix,
  isLocalDial,
  isNonLocalDial,
};
