'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { moneyToMinorUnits, databaseMoneyToMinorUnits, formatMinorUnits, validateAgainstAvailable } = require('../src/demo-amount');
const { confirmAction } = require('../src/demo-confirmation');
const { isWithdrawalConfirmed } = require('../src/withdrawal-confirmation');

test('accepts positive amounts with zero, one, or two decimal places', () => {
  assert.equal(formatMinorUnits(moneyToMinorUnits('5')), '5.00');
  assert.equal(formatMinorUnits(moneyToMinorUnits('5.2')), '5.20');
  assert.equal(formatMinorUnits(moneyToMinorUnits('5.27')), '5.27');
});

test('rejects zero, negative, malformed, and over-precision amounts', () => {
  for (const value of ['0', '0.00', '-1', '-0.01', '1.001', 'abc', '', '1,000.00']) {
    assert.throws(() => moneyToMinorUnits(value), /greater than zero|positive amount|two decimal places/,
      `input ${JSON.stringify(value)} should fail`);
  }
});

test('rejects amounts above available funds and allows an exact-balance withdrawal', () => {
  assert.throws(() => validateAgainstAvailable('100.01', '100.00'), /exceeds available balance/);
  assert.equal(formatMinorUnits(validateAgainstAvailable('100.00', '100.00')), '100.00');
});

test('decimal arithmetic uses integer minor units and tolerates redundant DB trailing zeroes', () => {
  const balance = databaseMoneyToMinorUnits('4381.3200');
  const withdrawal = moneyToMinorUnits('200.17');
  assert.equal(formatMinorUnits(balance - withdrawal), '4181.15');
  assert.equal(databaseMoneyToMinorUnits('0.10') - moneyToMinorUnits('0.10'), 0n);
  assert.throws(() => databaseMoneyToMinorUnits('1.001'), /fractions smaller than one penny/);
});

test('a nonmatching confirmation cancels before a withdrawal action can run', async () => {
  let executed = false;
  await assert.rejects(async () => {
    await confirmAction({ expected: 'WITHDRAW 12.34 GBP AC1000021', action: 'withdraw GBP 12.34', ask: async () => 'cancel' });
    executed = true;
  }, /no database changes were made/);
  assert.equal(executed, false);
});

test('withdrawal confirmation accepts y/yes and cancels on n/no/blank', () => {
  assert.equal(isWithdrawalConfirmed('y'), true);
  assert.equal(isWithdrawalConfirmed('YES'), true);
  for (const response of ['n', 'no', '', '  ', undefined, 'cancel']) assert.equal(isWithdrawalConfirmed(response), false);
});
