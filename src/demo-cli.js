require('dotenv').config();
const { createInterface } = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { getExecutionMode } = require('./execution-mode');
let config, connectDb2, connectOracle, service;
const { createDemoService, DEFAULTS } = require('./customer360-demo');
const { runVerification, parseVerificationArgs, printVerification } = require('./verification');
const { moneyToMinorUnits, databaseMoneyToMinorUnits, formatMinorUnits, validateAgainstAvailable } = require('./demo-amount');
const { isWithdrawalConfirmed } = require('./withdrawal-confirmation');

const DEMO_KYC_CUSTOMER_ID = process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId;

function initializeLocal() {
  ({ config } = require('./config'));
  ({ connectDb2, connectOracle } = require('./db'));
  service = createDemoService({
    db2Schema: config.db2.schema || 'BANKCORE',
    oracleSchema: config.oracle.schema,
    customerId: process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId,
    kycCustomerId: DEMO_KYC_CUSTOMER_ID,
    accountId: process.env.DEMO_ACCOUNT_ID || DEFAULTS.accountId,
    amount: process.env.DEMO_WITHDRAWAL_AMOUNT || DEFAULTS.amount,
    currency: process.env.DEMO_CURRENCY || DEFAULTS.currency
  });
}

async function ask(question) {
  if (!stdin.isTTY) throw new Error('Interactive input is required to enter and confirm a withdrawal amount');
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return await prompt.question(question); }
  finally { prompt.close(); }
}

async function confirmKyc(question) {
  const answer = (await ask(question)).trim().toLowerCase();
  return isWithdrawalConfirmed(answer);
}

async function confirmWithdrawal() {
  const answer = (await ask('Confirm withdrawal? (y/N): ')).trim().toLowerCase();
  if (isWithdrawalConfirmed(answer)) return true;
  if (answer === '' || answer === 'n' || answer === 'no') return false;
  console.log('Unrecognized response; withdrawal cancelled without changes.');
  return false;
}

async function withConnection(connect, action) {
  const connection = await connect();
  try { return await action(connection); }
  finally { await connection.close(); }
}

function printStatus(result) {
  const { customer, transactions, kyc } = result;
  console.log(`Customer ${customer.CUSTOMER_ID}: ${String(customer.CUSTOMER_NAME).trim()} (${String(customer.CUSTOMER_STATUS).trim()})`);
  console.log(`Account ${String(customer.ACCOUNT_ID).trim()} / ${String(customer.ACCOUNT_NUMBER).trim()}: ${String(customer.ACCOUNT_STATUS).trim()}, ${String(customer.CURRENCY).trim()}`);
  console.log(`Balance: ${customer.BALANCE} | Available balance: ${customer.AVAILABLE_BALANCE}`);
  console.log(`Relationship: ${String(customer.OWNERSHIP_ROLE).trim()}; active from ${customer.EFFECTIVE_FROM}${customer.EFFECTIVE_TO ? ` through ${customer.EFFECTIVE_TO}` : ''}`);
  console.log(`Oracle KYC: ${String(kyc[2]).trim()} | Risk rating: ${String(kyc[3] ?? 'N/A').trim()}`);
  console.log(`Recent transactions (${transactions.length}):`);
  if (!transactions.length) console.log('  No transactions returned.');
  for (const row of transactions) console.log(`  ${String(row.TRANSACTION_TIMESTAMP).trim()} | ${String(row.TRANSACTION_ID).trim()} | ${String(row.TRANSACTION_TYPE).trim()} ${row.TRANSACTION_AMOUNT} ${String(row.CURRENCY).trim()} | ${String(row.TRANSACTION_STAGE).trim()} / ${String(row.TRANSACTION_STATUS).trim()}`);
}

async function runWithdrawal(account, submit) {
  console.log(`Customer ${account.customerId} / ${account.customerName}`);
  console.log(`Account ${account.accountId} (${account.currency}) balance: ${account.balance}; available: ${account.availableBalance}`);
  if (account.currency !== 'GBP') throw new Error(`Interactive demo withdrawals require a GBP account; this account is ${account.currency}`);
  if (account.accountStatus.toUpperCase() !== 'ACTIVE') throw new Error(`Account ${account.accountId} is not active`);
  const entered = (await ask('Enter withdrawal amount in GBP (up to 2 decimal places): ')).trim();
  const amountCents = moneyToMinorUnits(entered, 'Withdrawal amount');
  validateAgainstAvailable(amountCents, account.availableBalance);
  console.log(`Entered withdrawal amount: GBP ${formatMinorUnits(amountCents)}`);
  if (!(await confirmWithdrawal())) {
    console.log('Withdrawal cancelled; no database changes were made.');
    return;
  }
  const result = await submit(formatMinorUnits(amountCents));
  console.log(`Withdrawal committed: ${result.transactionId}`);
  console.log(`Amount: ${result.amount} ${result.currency}`);
  console.log(`Balance: ${result.previousBalance} -> ${result.newBalance} ${result.currency}`);
  console.log(`Available balance: ${result.previousAvailableBalance} -> ${result.newAvailableBalance} ${result.currency}`);
  console.log(`Transaction timestamp: ${result.transactionTimestamp}`);
  console.log(`Commit completed at: ${result.completionTimestamp}`);
}

async function runKyc(mode, adapter) {
  const initial = await adapter.currentKyc();
  const previewCustomerId = initial.customerId;
  if (mode === 'kyc') {

    const preview = initial;
    console.log(`Customer ${previewCustomerId} current KYC: ${preview.status} / ${preview.riskRating ?? 'N/A'}`);
    if (preview.status === 'REVIEW_REQUIRED' && preview.riskRating === 'HIGH') {
      console.log('No update needed; Oracle already has REVIEW_REQUIRED / HIGH.');
      return;
    }
    if (!(await confirmKyc('Confirm KYC update? (y/N): '))) {
      console.log('KYC update cancelled; no database changes were made.');
      return;
    }
    const result = await adapter.setKyc(preview);
    console.log(result.changed ? 'Oracle KYC updated and read back successfully.' : 'No update needed.');
    console.log(`Previous: ${result.previous.status} / ${result.previous.riskRating ?? 'N/A'}`);
    console.log(`Updated:  ${result.current.status} / ${result.current.riskRating ?? 'N/A'}`);
    return;
  }
  if (mode === 'kyc:reset') {

    const current = initial;
    console.log(`Customer ${previewCustomerId} current KYC: ${current.status} / ${current.riskRating ?? 'N/A'}`);
    console.log('Demo reset target: VERIFIED / LOW.');
    if (current.status === 'VERIFIED' && current.riskRating === 'LOW') {
      console.log('No reset needed; Oracle already has the demo baseline.');
      return;
    }
    if (!(await confirmKyc('Confirm KYC reset? (y/N): '))) {
      console.log('KYC reset cancelled; no database changes were made.');
      return;
    }
    const reset = await adapter.resetKyc(current);
    const final = await adapter.finalKyc();
    const matches = final.status === 'VERIFIED' && final.riskRating === 'LOW';
    console.log(reset.changed ? `KYC reset ${matches ? 'PASS' : 'FAIL'}.` : `No reset needed (${matches ? 'PASS' : 'FAIL'}).`);
    console.log(`Final KYC: ${final.status} / ${final.riskRating ?? 'N/A'}`);
    if (!matches) process.exitCode = 1;
    return;
  }

}

async function main(mode) {
  if (getExecutionMode() === 'remote') {
    if (!['status', 'transaction', 'verify', 'kyc', 'kyc:reset'].includes(mode)) throw new Error('This command is not yet supported in remote mode');
    if (mode !== 'verify' && process.argv.length > 3) throw new Error(`Usage: npm run demo:${mode}`);
    const { createRemoteClient } = require('./remote-client');
    const client = createRemoteClient();
    if (mode === 'status') printStatus(await client.execute('status'));
    else if (mode === 'verify') {
      const report = await client.execute('verify', parseVerificationArgs(process.argv.slice(3)));
      printVerification(report);
      if (!report.passed) process.exitCode = 1;
    } else if (mode === 'kyc' || mode === 'kyc:reset') {
      const preview = await client.execute('kycPreview');
      let result;
      await runKyc(mode, { currentKyc: async () => preview.kyc,
        setKyc: async () => client.execute('kyc', { previewId: preview.previewId, confirmed: true, idempotencyKey: require('node:crypto').randomUUID() }),
        resetKyc: async () => (result = await client.execute('kycReset', { previewId: preview.previewId, confirmed: true, idempotencyKey: require('node:crypto').randomUUID() })),
        finalKyc: async () => result.final
      });
    } else {
      const preview = await client.execute('transactionPreview');
      await runWithdrawal(preview.account, amount => client.execute('transaction', {
        amount, previewId: preview.previewId, confirmed: true,
        idempotencyKey: require('node:crypto').randomUUID()
      }));
    }
    return;
  }
  initializeLocal();
  if (mode === 'status') {
    await withConnection(() => connectDb2(config), async db2 => {
      await withConnection(() => connectOracle(config), async oracle => printStatus(await service.status(db2, oracle)));
    });
    return;
  }
  if (mode === 'transaction') {
    await withConnection(() => connectDb2(config), async db2 => {
      try {
        const account = await service.readWithdrawalAccount(db2);
        await runWithdrawal(account, amount => service.transaction(db2, amount));
      } catch (error) {
        throw error;
      }
    });
    return;
  }
  if (['kyc', 'kyc:reset'].includes(mode)) {
    await withConnection(() => connectOracle(config), oracle => runKyc(mode, {
      currentKyc: () => service.currentKyc(oracle), setKyc: preview => service.setKyc(oracle, preview),
      resetKyc: current => service.resetKyc(oracle, current), finalKyc: () => service.currentKyc(oracle)
    }));
    return;
  }
  if (mode === 'verify') {
    const report = await runVerification({ service, withDb2: action => withConnection(() => connectDb2(config), action),
      withOracle: action => withConnection(() => connectOracle(config), action), env: process.env }, parseVerificationArgs(process.argv.slice(3)));
    printVerification(report);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  throw new Error('Usage: npm run demo:status | demo:transaction | demo:kyc | demo:kyc:reset | demo:verify -- --stage transaction|kyc|api [--transaction-id RT-...]');
}


main(process.argv[2]).catch(error => {
  console.error(`Customer 360 demo failed: ${error.message}`);
  process.exitCode = 1;
});
