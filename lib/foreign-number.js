'use strict';

function extractDigits(input) {
  if (input == null) return '';
  const digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('00') && digits.length > 2) {
    return digits.slice(2);
  }
  return digits;
}

module.exports = {
  extractDigits,
};
