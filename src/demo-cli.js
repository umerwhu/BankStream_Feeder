require('dotenv').config();
const { createInterface } = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { config } = require('./config');
const { connectDb2, connectOracle } = require('./db');
const { createDemoService, DEFAULTS } = require('./customer360-demo');

const service = createDemoService({
  db2Schema: config.db2.schema || 'BANKCORE',
  oracleSchema: config.oracle.schema,
  customerId: process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId,
  accountId: process.env.DEMO_ACCOUNT_ID || DEFAULTS.accountId,
  amount: process.env.DEMO_WITHDRAWAL_AMOUNT || DEFAULTS.amount,
  currency: process.env.DEMO_CURRENCY || DEFAULTS.currency
});

async function confirm(expected, action) {
  if (!stdin.isTTY) throw new Error(`Interactive confirmation is required. Run this command in a terminal and type: ${expected}`);
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(`This will ${action}. Type "${expected}" to continue: `);
    if (answer.trim() !== expected) throw new Error('Confirmation did not match; no database changes were made');
  } finally { prompt.close(); }
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
      const result = await service.transaction(db2);
      console.log(`Withdrawal committed: ${result.transactionId}`);
      console.log(`Amount: ${result.amount} ${result.currency}`);
      console.log(`Balance: ${result.previousBalance} -> ${result.newBalance} ${result.currency}`);
      console.log(`Available balance: ${result.previousAvailableBalance} -> ${result.newAvailableBalance} ${result.currency}`);
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
    });
    return;
  }
  if (mode === 'verify') {
    await withConnection(() => connectDb2(config), async db2 => {
      await withConnection(() => connectOracle(config), async oracle => {
        const result = await service.verify(db2, oracle);
        console.log(`Latest demo withdrawal: ${result.withdrawal ? String(result.withdrawal.TRANSACTION_ID).trim() : 'NOT FOUND'}`);
        if (result.withdrawal) console.log(`${result.withdrawal.TRANSACTION_AMOUNT} ${String(result.withdrawal.CURRENCY).trim()} | ${String(result.withdrawal.TRANSACTION_TYPE).trim()} / ${String(result.withdrawal.TRANSACTION_STAGE).trim()} / ${String(result.withdrawal.TRANSACTION_STATUS).trim()} | ${String(result.withdrawal.TRANSACTION_TIMESTAMP).trim()}`);
        console.log(`Withdrawal values: ${result.transactionValid ? 'PASS' : 'FAIL'}`);
        console.log(`Account balance: ${result.account.BALANCE} ${String(result.account.CURRENCY).trim()} | available: ${result.account.AVAILABLE_BALANCE}`);
        console.log(`Oracle KYC: ${result.kyc.status} / ${result.kyc.riskRating} | ${result.kyc.valid ? 'PASS' : 'FAIL'}`);
        if (!result.transactionValid || !result.kyc.valid) process.exitCode = 1;
      });
    });
    return;
  }
  throw new Error('Usage: npm run demo:status | demo:transaction | demo:kyc | demo:verify');
}

main(process.argv[2]).catch(error => {
  console.error(`Customer 360 demo failed: ${error.message}`);
  process.exitCode = 1;
});
