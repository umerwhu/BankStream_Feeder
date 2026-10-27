require('dotenv').config();
const { createInterface } = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { config } = require('./config');
const { connectDb2, connectOracle } = require('./db');
const { createDemoService, DEFAULTS } = require('./customer360-demo');
const { createDemoStateStore } = require('./customer360-demo-state');
const { confirmAction } = require('./demo-confirmation');
const { createTapDataVerifier, printReport } = require('./tapdata-api-verification');

const stateStore = createDemoStateStore();

const service = createDemoService({
  db2Schema: config.db2.schema || 'BANKCORE',
  oracleSchema: config.oracle.schema,
  customerId: process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId,
  accountId: process.env.DEMO_ACCOUNT_ID || DEFAULTS.accountId,
  amount: process.env.DEMO_WITHDRAWAL_AMOUNT || DEFAULTS.amount,
  currency: process.env.DEMO_CURRENCY || DEFAULTS.currency,
  stateStore
});

async function confirm(expected, action) {
  const prompt = createInterface({ input: stdin, output: stdout });
  try { await confirmAction({ expected, action, interactive: stdin.isTTY, ask: message => prompt.question(message) }); }
  finally { prompt.close(); }
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
    const expected = `WITHDRAW ${process.env.DEMO_ACCOUNT_ID || DEFAULTS.accountId} GBP 200`;
    await confirm(expected, `insert one completed GBP 200 withdrawal for customer ${process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId}`);
    await withConnection(() => connectDb2(config), async db2 => {
      try {
        const result = await service.transaction(db2);
        console.log(`Withdrawal committed: ${result.transactionId}`);
        console.log(`Amount: ${result.amount} ${result.currency}`);
        console.log(`Balance: ${result.previousBalance} -> ${result.newBalance} ${result.currency}`);
        console.log(`Available balance: ${result.previousAvailableBalance} -> ${result.newAvailableBalance} ${result.currency}`);
        console.log(`Transaction timestamp: ${result.transactionTimestamp}`);
        console.log(`Commit completed at: ${result.completionTimestamp}`);
        console.log('Local transaction verification record saved.');
      } catch (error) {
        if (error.committedTransaction) {
          console.error(`WARNING: The withdrawal is already committed. Transaction ID: ${error.committedTransaction.transactionId}`);
          console.error('Its local verification record was not saved. Do not rerun unless you intend another withdrawal.');
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });
    return;
  }
  if (mode === 'kyc') {
    const expected = `UPDATE KYC ${process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId}`;
    await confirm(expected, `set Oracle KYC status to REVIEW_REQUIRED and risk rating to HIGH for customer ${process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId}`);
    await withConnection(() => connectOracle(config), async oracle => {
      const result = await service.setKyc(oracle);
      console.log(result.changed ? 'Oracle KYC updated.' : 'No change required; Oracle KYC already has the requested values.');
      console.log(`Previous: ${result.previous.status} / ${result.previous.riskRating ?? 'N/A'}`);
      console.log(`Current:  ${result.current.status} / ${result.current.riskRating}`);
      console.log(`Original baseline: ${result.baseline.kycStatus} / ${result.baseline.riskRating ?? 'N/A'} (saved locally)`);
    });
    return;
  }
  if (mode === 'kyc:reset') {
    const baseline = await stateStore.loadKycBaseline(process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId);
    if (!baseline) throw new Error('No reliable saved KYC baseline exists; refusing to guess original values');
    await withConnection(() => connectOracle(config), async oracle => {
      const current = await service.currentKyc(oracle);
      console.log(`Customer ${current.customerId} current KYC: ${current.status} / ${current.riskRating ?? 'N/A'}`);
      console.log(`Saved original KYC: ${baseline.kycStatus} / ${baseline.riskRating ?? 'N/A'}`);
      const expected = `RESET KYC ${current.customerId}`;
      await confirm(expected, `restore only customer ${current.customerId}'s Oracle KYC status and risk rating to the saved original values`);
      const reset = await service.resetKyc(oracle, current);
      const final = await service.currentKyc(oracle);
      const matches = final.status === baseline.kycStatus && final.riskRating === baseline.riskRating;
      console.log(reset.changed ? `KYC reset ${matches ? 'PASS' : 'FAIL'}.` : `No reset needed; KYC already matches baseline (${matches ? 'PASS' : 'FAIL'}).`);
      console.log(`Final KYC: ${final.status} / ${final.riskRating ?? 'N/A'}`);
      if (!matches) process.exitCode = 1;
    });
    return;
  }
  if (mode === 'verify') {
    const args = process.argv.slice(3);
    let stage;
    for (let index = 0; index < args.length; index++) {
      if (args[index] !== '--stage' || !args[index + 1]) throw new Error('Usage: npm run demo:verify [-- --stage transaction|kyc|api]');
      stage = args[++index];
    }
    if (stage !== undefined && !['transaction', 'kyc', 'api'].includes(stage)) throw new Error('Verification stage must be transaction, kyc, or api; combined verification is available without a stage');
    if (stage === 'transaction') {
      let record;
      try { record = await stateStore.loadTransaction(process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId); }
      catch (error) { console.error(`FAIL transaction verification: ${error.message}`); process.exitCode = 1; return; }
      await withConnection(() => connectDb2(config), async db2 => {
        const result = await service.verifyTransaction(db2, record);
        printTransactionVerification(result);
        if (!result.passed) process.exitCode = 1;
      });
      return;
    }
    if (stage === 'kyc') {
      await withConnection(() => connectOracle(config), async oracle => {
        const result = await service.verifyKyc(oracle);
        console.log(`KYC customer ${result.customerId}: ${result.status} / ${result.riskRating ?? 'N/A'} — ${result.passed ? 'PASS' : 'FAIL'}`);
        if (!result.passed) process.exitCode = 1;
      });
      return;
    }
    if (stage === 'api') {
      let record;
      try { record = await stateStore.loadTransaction(process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId); }
      catch (error) { console.error(`API verification failed: ${error.message}`); process.exitCode = 1; return; }
      if (!record) {
        console.error('API verification failed: no local demo transaction record; run demo:transaction first only if you intend a withdrawal.');
        process.exitCode = 1;
        return;
      }
      const source = await withConnection(() => connectDb2(config), db2 =>
        withConnection(() => connectOracle(config), oracle => service.readApiVerificationSources(db2, oracle, record)));
      const result = await createTapDataVerifier().verify(source);
      printReport(result, source);
      if (!result.passed) process.exitCode = 1;
      return;
    }
    let record; let recordError;
    try { record = await stateStore.loadTransaction(process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId); }
    catch (error) { recordError = error.message; }
    await withConnection(() => connectDb2(config), async db2 => {
      const result = recordError ? { passed: false, error: recordError } : await service.verifyTransaction(db2, record);
      printTransactionVerification(result);
      if (!result.passed) process.exitCode = 1;
      await withConnection(() => connectOracle(config), async oracle => {
        const kyc = await service.verifyKyc(oracle);
        console.log(`KYC customer ${kyc.customerId}: ${kyc.status} / ${kyc.riskRating ?? 'N/A'} — ${kyc.passed ? 'PASS' : 'FAIL'}`);
        if (!kyc.passed) process.exitCode = 1;
      });
    });
    return;
  }
  throw new Error('Usage: npm run demo:status | demo:transaction | demo:kyc | demo:kyc:reset | demo:verify [-- --stage transaction|kyc|api]');
}

function printTransactionVerification(result) {
  if (result.error) { console.log(`Transaction verification: FAIL — ${result.error}`); return; }
  const record = result.record;
  console.log(`Recorded transaction ID: ${record.transactionId}`);
  console.log(`Recorded transaction: ${record.amount} ${record.currency}; balance ${record.previousBalance} -> ${record.newBalance}; available ${record.previousAvailableBalance} -> ${record.newAvailableBalance}`);
  if (result.transaction) console.log(`Source transaction: ${result.transaction.TRANSACTION_TYPE} / ${result.transaction.TRANSACTION_STAGE} / ${result.transaction.TRANSACTION_STATUS} — ${result.transaction.TRANSACTION_AMOUNT} ${result.transaction.CURRENCY}`);
  else console.log('Source transaction: NOT FOUND');
  console.log(`Customer/account relationship: ${result.relationshipValid ? 'PASS' : 'FAIL'}`);
  console.log(`Exact source transaction and GBP 200 fields: ${result.transactionValid ? 'PASS' : 'FAIL'}`);
  console.log(`Recorded balance deductions: ${result.recordedDeductionValid ? 'PASS' : 'FAIL'}`);
  if (result.account) console.log(`Current database balances: ${result.account.BALANCE} ${result.account.CURRENCY} / available ${result.account.AVAILABLE_BALANCE}`);
  else console.log('Current database account: NOT FOUND');
  if (result.currentMatchesRecordedAfter) console.log('Current balances still match the recorded post-withdrawal balances.');
  else console.log('Current balances differ from the recorded post-withdrawal snapshot; later account activity may have changed them. The exact recorded withdrawal is checked by transaction ID.');
  console.log(`Transaction verification: ${result.passed ? 'PASS' : 'FAIL'}`);
}

main(process.argv[2]).catch(error => {
  console.error(`Customer 360 demo failed: ${error.message}`);
  process.exitCode = 1;
});
