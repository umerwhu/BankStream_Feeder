require('dotenv').config();
const { createInterface } = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { config } = require('./config');
const { connectDb2, connectOracle } = require('./db');
const { createDemoService, DEFAULTS } = require('./customer360-demo');
const { createTapDataVerifier, printReport } = require('./tapdata-api-verification');
const { moneyToMinorUnits, databaseMoneyToMinorUnits, formatMinorUnits, validateAgainstAvailable } = require('./demo-amount');
const { isWithdrawalConfirmed } = require('./withdrawal-confirmation');

const DEMO_KYC_CUSTOMER_ID = process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId;

const service = createDemoService({
  db2Schema: config.db2.schema || 'BANKCORE',
  oracleSchema: config.oracle.schema,
  customerId: process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId,
  kycCustomerId: DEMO_KYC_CUSTOMER_ID,
  accountId: process.env.DEMO_ACCOUNT_ID || DEFAULTS.accountId,
  amount: process.env.DEMO_WITHDRAWAL_AMOUNT || DEFAULTS.amount,
  currency: process.env.DEMO_CURRENCY || DEFAULTS.currency
});

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

async function main(mode) {
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
        const result = await service.transaction(db2, formatMinorUnits(amountCents));
        console.log(`Withdrawal committed: ${result.transactionId}`);
        console.log(`Amount: ${result.amount} ${result.currency}`);
        console.log(`Balance: ${result.previousBalance} -> ${result.newBalance} ${result.currency}`);
        console.log(`Available balance: ${result.previousAvailableBalance} -> ${result.newAvailableBalance} ${result.currency}`);
        console.log(`Transaction timestamp: ${result.transactionTimestamp}`);
        console.log(`Commit completed at: ${result.completionTimestamp}`);
      } catch (error) {
        throw error;
      }
    });
    return;
  }
  if (mode === 'kyc') {
    await withConnection(() => connectOracle(config), async oracle => {
      const preview = await service.currentKyc(oracle);
      console.log(`Customer ${DEMO_KYC_CUSTOMER_ID} current KYC: ${preview.status} / ${preview.riskRating ?? 'N/A'}`);
      if (preview.status === 'REVIEW_REQUIRED' && preview.riskRating === 'HIGH') {
        console.log('No update needed; Oracle already has REVIEW_REQUIRED / HIGH.');
        return;
      }
      if (!(await confirmKyc('Confirm KYC update? (y/N): '))) {
        console.log('KYC update cancelled; no database changes were made.');
        return;
      }
      const result = await service.setKyc(oracle, preview);
      console.log(result.changed ? 'Oracle KYC updated and read back successfully.' : 'No update needed.');
      console.log(`Previous: ${result.previous.status} / ${result.previous.riskRating ?? 'N/A'}`);
      console.log(`Updated:  ${result.current.status} / ${result.current.riskRating ?? 'N/A'}`);
    });
    return;
  }
  if (mode === 'kyc:reset') {
    await withConnection(() => connectOracle(config), async oracle => {
      const current = await service.currentKyc(oracle);
      console.log(`Customer ${DEMO_KYC_CUSTOMER_ID} current KYC: ${current.status} / ${current.riskRating ?? 'N/A'}`);
      console.log('Demo reset target: VERIFIED / LOW.');
      if (current.status === 'VERIFIED' && current.riskRating === 'LOW') {
        console.log('No reset needed; Oracle already has the demo baseline.');
        return;
      }
      if (!(await confirmKyc('Confirm KYC reset? (y/N): '))) {
        console.log('KYC reset cancelled; no database changes were made.');
        return;
      }
      const reset = await service.resetKyc(oracle, current);
      const final = await service.currentKyc(oracle);
      const matches = final.status === 'VERIFIED' && final.riskRating === 'LOW';
      console.log(reset.changed ? `KYC reset ${matches ? 'PASS' : 'FAIL'}.` : `No reset needed (${matches ? 'PASS' : 'FAIL'}).`);
      console.log(`Final KYC: ${final.status} / ${final.riskRating ?? 'N/A'}`);
      if (!matches) process.exitCode = 1;
    });
    return;
  }
  if (mode === 'verify') {
    const args = process.argv.slice(3);
    let stage;
    let transactionId;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--stage' && args[index + 1]) stage = args[++index];
      else if (args[index] === '--transaction-id' && args[index + 1]) transactionId = args[++index];
      else throw new Error('Usage: npm run demo:verify -- --stage transaction|kyc|api [--transaction-id RT-...]');
    }
    if (stage !== undefined && !['transaction', 'kyc', 'api'].includes(stage)) throw new Error('Verification stage must be transaction, kyc, or api; combined verification is available without a stage');
    if (transactionId && !['transaction', 'api'].includes(stage)) throw new Error('--transaction-id is supported with the transaction and api stages');
    if (stage === 'transaction') {
      await withConnection(() => connectDb2(config), async db2 => {
        const result = await service.verifyTransaction(db2, transactionId);
        printTransactionVerification(result);
        if (!result.passed) process.exitCode = 1;
      });
      return;
    }
    if (stage === 'kyc') {
      await withConnection(() => connectOracle(config), async oracle => {
        const result = await service.verifyKyc(oracle);
        console.log(`KYC customer ${result.customerId}: ${result.status} / ${result.riskRating ?? 'N/A'} — ${result.retrieved ? 'RETRIEVED' : 'NOT RETRIEVED'}, ${result.expectedState} — ${result.passed ? 'PASS' : 'FAIL'}`);
        if (!result.passed) process.exitCode = 1;
      });
      return;
    }
    if (stage === 'api') {
      const source = await withConnection(() => connectDb2(config), db2 =>
        withConnection(() => connectOracle(config), async oracle => {
          let latestSource;
          const result = await createTapDataVerifier().verify(async selectedId => {
            latestSource = await service.readApiVerificationSources(db2, oracle, selectedId || transactionId, { checkLatest: !transactionId });
            return latestSource;
          }, { transactionId });
          return { result, source: latestSource };
        }));
      printReport(source.result, source.source);
      if (!source.result.passed) process.exitCode = 1;
      return;
    }
    await withConnection(() => connectDb2(config), async db2 => {
      const result = await service.verifyTransaction(db2);
      printTransactionVerification(result);
      if (!result.passed) process.exitCode = 1;
      await withConnection(() => connectOracle(config), async oracle => {
        const kyc = await service.verifyKyc(oracle);
        console.log(`KYC customer ${kyc.customerId}: ${kyc.status} / ${kyc.riskRating ?? 'N/A'} — ${kyc.retrieved ? 'RETRIEVED' : 'NOT RETRIEVED'}, ${kyc.expectedState} — ${kyc.passed ? 'PASS' : 'FAIL'}`);
        if (!kyc.passed) process.exitCode = 1;
      });
    });
    return;
  }
  throw new Error('Usage: npm run demo:status | demo:transaction | demo:kyc | demo:kyc:reset | demo:verify -- --stage transaction|kyc|api [--transaction-id RT-...]');
}

function printTransactionVerification(result) {
  console.log(`Selected by: ${result.selectedBy}`);
  if (result.transaction) {
    const row = result.transaction;
    console.log(`Transaction ID: ${String(row.TRANSACTION_ID).trim()}`);
    console.log(`Amount: ${row.TRANSACTION_AMOUNT} ${String(row.CURRENCY).trim()}`);
    console.log(`Type / stage / status: ${String(row.TRANSACTION_TYPE).trim()} / ${String(row.TRANSACTION_STAGE).trim()} / ${String(row.TRANSACTION_STATUS).trim()}`);
    console.log(`Timestamp: ${String(row.TRANSACTION_TIMESTAMP).trim()}`);
  } else console.log('Transaction: NOT FOUND');
  console.log(`Customer/account relationship: ${result.relationshipValid ? 'PASS' : 'FAIL'}`);
  console.log(`Completed posted GBP withdrawal: ${result.transactionValid ? 'PASS' : 'FAIL'}`);
  if (result.selectedBy !== 'exact transaction ID') console.log(`Latest transaction remained stable: ${result.stableSelection ? 'PASS' : 'FAIL'}`);
  if (result.account) console.log(`Current DB2 balance: ${result.account.BALANCE} ${result.account.CURRENCY} / available ${result.account.AVAILABLE_BALANCE}`);
  else console.log('Current database account: NOT FOUND');
  console.log(`Source account remained stable during verification: ${result.stableAccount ? 'PASS' : 'FAIL'}`);
  console.log(`Transaction verification: ${result.passed ? 'PASS' : 'FAIL'}`);
}

main(process.argv[2]).catch(error => {
  console.error(`Customer 360 demo failed: ${error.message}`);
  process.exitCode = 1;
});
