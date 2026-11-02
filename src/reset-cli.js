'use strict';
require('dotenv').config();
const { createInterface } = require('node:readline/promises');
const { getExecutionMode } = require('./execution-mode');
const { createDemoReset } = require('./demo-reset');
const { createDemoService, DEFAULTS } = require('./customer360-demo');
const { isWithdrawalConfirmed } = require('./withdrawal-confirmation');
const { databaseMoneyToMinorUnits } = require('./demo-amount');

const choices = { '1': ['kyc', 'Reset KYC'], '2': ['account', 'Reset Account Balances'], '3': ['both', 'Reset Both'] };

async function runResetCommand({ preview, execute, ask, log = console.log }) {
  log('========== BANKSTREAM DEMO RESET ==========\n');
  log('Select reset operation:\n\n1. Reset KYC\n2. Reset Account Balances\n3. Reset Both (KYC + Account Balances)\n4. Cancel\n');
  let choice;
  while (true) {
    choice = String(await ask('Enter your choice (1-4): ')).trim();
    if (choice === '4') { log('Demo reset cancelled; no database changes were made.'); return; }
    if (choices[choice]) break;
    log('Invalid selection. Enter a number from 1 to 4.');
  }
  const [operation, label] = choices[choice];
  const current = await preview(operation);
  log(`\nSelected Operation: ${label}`);
  log(`Customer ID       : ${operation === 'kyc' ? current.kyc.customerId : current.account.customerId}`);
  if (operation !== 'kyc') log(`Account ID        : ${current.account.accountId}`);
  if (operation !== 'account') log(`KYC Status        : ${current.kyc.status}\nRisk Level        : ${current.kyc.riskRating ?? 'N/A'}`);
  if (operation !== 'kyc') log(`Balance           : ${current.account.balance}\nAvailable Balance : ${current.account.availableBalance}`);
  const needsKyc = operation !== 'account' && !(current.kyc.status === 'VERIFIED' && current.kyc.riskRating === 'LOW');
  const needsAccount = operation !== 'kyc' && !(databaseMoneyToMinorUnits(current.account.balance) === 4000000n &&
    databaseMoneyToMinorUnits(current.account.availableBalance) === 4000000n);
  if (!needsKyc && !needsAccount) {
    log(operation === 'kyc' ? 'KYC is already VERIFIED / LOW. No reset required.' : operation === 'account' ?
      'Account balances are already 40000. No reset required.' : 'KYC and account balances are already at their default values. No reset required.');
    return;
  }
  const resetOperation = needsKyc && needsAccount ? 'both' : needsKyc ? 'kyc' : 'account';
  log(`Will reset: ${[needsKyc ? 'KYC to VERIFIED / LOW' : null, needsAccount ? 'balance and available balance to 40000' : null].filter(Boolean).join('; ')}.`);
  if (!isWithdrawalConfirmed(String(await ask('Are you sure you want to continue? (y/N): ')).trim().toLowerCase())) {
    log('Demo reset cancelled; no database changes were made.'); return;
  }
  const result = await execute(current, resetOperation);
  if (operation === 'both') {
    if (!needsKyc) result.kyc = { passed: true, changed: false, status: current.kyc.status, riskRating: current.kyc.riskRating };
    if (!needsAccount) result.account = { passed: true, changed: false, balance: current.account.balance, availableBalance: current.account.availableBalance };
  }
  log('\n========== RESET SUMMARY ==========\n');
  log(`Customer ID       : ${result.customerId}`);
  if (operation !== 'kyc') log(`Account ID        : ${result.accountId}`);
  if (operation !== 'account') {
    log(result.kyc.passed ? `KYC Reset         : ${result.kyc.changed ? 'SUCCESS' : 'SKIPPED - no reset required'}` : `KYC Reset         : FAILED - ${result.kyc.error}`);
    if (result.kyc.passed) log(`KYC Status        : ${result.kyc.status}\nRisk Level        : ${result.kyc.riskRating}`);
  }
  if (operation !== 'kyc') {
    log(result.account.passed ? `Account Reset     : ${result.account.changed ? 'SUCCESS' : 'SKIPPED - no reset required'}` : `Account Reset     : FAILED - ${result.account.error}`);
    if (result.account.passed) log(`Balance           : ${result.account.balance}\nAvailable Balance : ${result.account.availableBalance}`);
  }
  log(result.passed ? '\nReset completed successfully.' : '\nReset failed or partially completed. A failed step may have committed; reconcile the reported outcomes before retrying.');
  return result;
}

async function main() {
  if (process.argv.length > 2) throw new Error('Usage: npm run demo:reset');
  if (!process.stdin.isTTY) throw new Error('Interactive input is required to select and confirm a demo reset');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let adapter;
    const initialize = () => {
      if (adapter) return adapter;
      if (getExecutionMode() === 'remote') {
        const client = require('./remote-client').createRemoteClient();
        adapter = { preview: () => client.execute('resetPreview'), execute: (preview, operation) => client.execute('reset', {
          previewId: preview.previewId, operation, confirmed: true, idempotencyKey: require('node:crypto').randomUUID()
        }) };
      } else {
        const { config } = require('./config');
        const connections = require('./db');
        const settings = { db2Schema: config.db2.schema || 'BANKCORE', oracleSchema: config.oracle.schema,
          customerId: process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId,
          accountId: process.env.DEMO_ACCOUNT_ID || DEFAULTS.accountId };
        const service = createDemoService({ ...settings, kycCustomerId: settings.customerId });
        const withDb = kind => async action => {
          const connection = await connections[kind](config);
          try { return await action(connection); } finally { await connection.close(); }
        };
        const withDb2 = withDb('connectDb2'); const withOracle = withDb('connectOracle');
        adapter = { preview: async operation => ({
          account: { customerId: settings.customerId, accountId: settings.accountId },
          ...(operation !== 'account' ? { kyc: await withOracle(oracle => service.currentKyc(oracle)) } : {}),
          ...(operation !== 'kyc' ? { account: await withDb2(db2 => service.readWithdrawalAccount(db2)) } : {})
        }), execute: (_preview, operation) => createDemoReset(settings).run({ withDb2, withOracle }, operation) };
      }
      return adapter;
    };
    const report = await runResetCommand({ preview: operation => initialize().preview(operation),
      execute: (preview, operation) => initialize().execute(preview, operation), ask: question => prompt.question(question) });
    if (report && !report.passed) process.exitCode = 1;
  } finally { prompt.close(); }
}

if (require.main === module) main().catch(error => { console.error(`Demo reset failed: ${error.message}`); process.exitCode = 1; });
module.exports = { runResetCommand };
