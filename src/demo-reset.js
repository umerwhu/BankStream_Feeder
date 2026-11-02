'use strict';

const { createDemoService, DEFAULTS } = require('./customer360-demo');
const { databaseMoneyToMinorUnits, formatMinorUnits } = require('./demo-amount');

function createDemoReset(settings = {}) {
  const customerId = String(settings.customerId || DEFAULTS.customerId).trim();
  const accountId = String(settings.accountId || DEFAULTS.accountId).trim();
  const schema = String(settings.db2Schema || 'BANKCORE').trim().toUpperCase();
  const service = createDemoService({ ...settings, customerId, accountId, kycCustomerId: customerId });
  // createDemoService validates identifiers, including the schema, before SQL is built.
  const matches = row => databaseMoneyToMinorUnits(row.balance, 'Balance') === 4000000n &&
    databaseMoneyToMinorUnits(row.availableBalance, 'Available balance') === 4000000n;

  async function resetBalances(db2) {
    await service.readWithdrawalAccount(db2);
    await db2.beginTransaction();
    let committed = false;
    try {
      const rows = await db2.query(`SELECT ACCOUNT_ID FROM ${schema}.BANK_ACCOUNT WHERE ACCOUNT_ID=? FOR UPDATE`, [accountId]);
      if (rows.length !== 1) throw new Error('Expected exactly one account to reset');
      const current = await service.readWithdrawalAccount(db2);
      if (!matches(current)) {
        const updated = await db2.query(
          `UPDATE ${schema}.BANK_ACCOUNT SET BALANCE=CAST(? AS DECIMAL(31,2)),AVAILABLE_BALANCE=CAST(? AS DECIMAL(31,2)),LAST_UPDATED_TIMESTAMP=CURRENT_TIMESTAMP WHERE ACCOUNT_ID=?`,
          ['40000.00', '40000.00', accountId]);
        if (Number.isFinite(updated?.count) && updated.count !== 1) throw new Error('Account reset did not update exactly one row');
      }
      if (!matches(await service.readWithdrawalAccount(db2))) throw new Error('Account balances did not match 40000 before commit');
      await db2.commit();
      committed = true;
      const final = await service.readWithdrawalAccount(db2);
      if (!matches(final)) throw new Error('Account reset committed, but read-back did not match 40000');
      return { passed: true, changed: !matches(current), balance: formatMinorUnits(databaseMoneyToMinorUnits(final.balance)),
        availableBalance: formatMinorUnits(databaseMoneyToMinorUnits(final.availableBalance)) };
    } catch (error) {
      if (!committed) try { await db2.rollback(); } catch {}
      throw error;
    }
  }

  async function run({ withDb2, withOracle }, operation = 'both') {
    if (!['kyc', 'account', 'both'].includes(operation)) throw new Error('Invalid reset operation');
    const report = { customerId, accountId };
    // Separate commits: preserve each outcome even if the other database fails.
    if (operation !== 'account') try {
      report.kyc = await withOracle(async oracle => {
        const reset = await service.resetKyc(oracle);
        const final = await service.currentKyc(oracle);
        if (final.status !== 'VERIFIED' || final.riskRating !== 'LOW') throw new Error('KYC read-back did not match VERIFIED / LOW');
        return { passed: true, changed: reset.changed, status: final.status, riskRating: final.riskRating };
      });
    } catch (error) { report.kyc = { passed: false, error: error.message }; }
    if (operation !== 'kyc') try { report.account = await withDb2(resetBalances); }
    catch (error) { report.account = { passed: false, error: error.message }; }
    report.passed = [report.kyc, report.account].filter(Boolean).every(result => result.passed);
    return report;
  }

  return { run };
}

module.exports = { createDemoReset };
