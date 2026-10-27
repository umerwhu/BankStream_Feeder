'use strict';

function moneyToMinorUnits(value, label = 'Amount') {
  const input = String(value ?? '').trim();
  const match = input.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`${label} must be a positive amount with up to two decimal places`);
  const fraction = match[3] || '';
  if (fraction.length > 2) throw new Error(`${label} must have no more than two decimal places`);
  const units = BigInt(match[2]) * 100n + BigInt((fraction + '00').slice(0, 2));
  const signed = match[1] === '-' ? -units : units;
  if (signed <= 0n) throw new Error(`${label} must be greater than zero`);
  return signed;
}

function databaseMoneyToMinorUnits(value, label = 'Balance') {
  const input = String(value ?? '').trim();
  const match = input.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`${label} is not a valid decimal currency value`);
  const fraction = match[3] || '';
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) throw new Error(`${label} has fractions smaller than one penny`);
  const cents = (fraction + '00').slice(0, 2);
  const units = BigInt(match[2]) * 100n + BigInt(cents);
  return match[1] === '-' ? -units : units;
}

function formatMinorUnits(value) {
  const units = typeof value === 'bigint' ? value : BigInt(value);
  const sign = units < 0n ? '-' : '';
  const absolute = units < 0n ? -units : units;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function validateAgainstAvailable(amount, available) {
  const amountCents = typeof amount === 'bigint' ? amount : moneyToMinorUnits(amount, 'Withdrawal amount');
  const availableCents = typeof available === 'bigint' ? available : databaseMoneyToMinorUnits(available, 'Available balance');
  if (amountCents > availableCents) throw new Error(`Withdrawal amount ${formatMinorUnits(amountCents)} GBP exceeds available balance ${formatMinorUnits(availableCents)} GBP`);
  return amountCents;
}

module.exports = { moneyToMinorUnits, databaseMoneyToMinorUnits, formatMinorUnits, validateAgainstAvailable };
