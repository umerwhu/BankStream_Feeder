'use strict';

function isWithdrawalConfirmed(answer) {
  const normalized = String(answer ?? '').trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

module.exports = { isWithdrawalConfirmed };
