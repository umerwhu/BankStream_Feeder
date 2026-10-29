'use strict';
const { createTapDataVerifier, printReport } = require('./tapdata-api-verification');

function validateVerificationOptions({ stage, transactionId } = {}) {
  if (stage !== undefined && !['transaction', 'kyc', 'api'].includes(stage)) throw new Error('Verification stage must be transaction, kyc, or api; combined verification is available without a stage');
  if (transactionId !== undefined && (typeof transactionId !== 'string' || !transactionId || transactionId.length > 256 || /[\r\n\0]/.test(transactionId))) throw new Error('Invalid transaction ID');
  if (transactionId && !['transaction', 'api'].includes(stage)) throw new Error('--transaction-id is supported with the transaction and api stages');
  return { stage, transactionId };
}
function parseVerificationArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stage' && args[i + 1]) options.stage = args[++i];
    else if (args[i] === '--transaction-id' && args[i + 1]) options.transactionId = args[++i];
    else throw new Error('Usage: npm run demo:verify -- --stage transaction|kyc|api [--transaction-id RT-...]');
  }
  return validateVerificationOptions(options);
}
async function runVerification({ service, withDb2, withOracle, env, fetchImpl }, options = {}) {
  const { stage, transactionId } = validateVerificationOptions(options);
  const report = {};
  async function run(db2, oracle) {
    if (!stage || stage === 'transaction') report.transaction = await service.verifyTransaction(db2, transactionId);
    if (!stage || stage === 'kyc') report.kyc = await service.verifyKyc(oracle);
    if (!stage || stage === 'api') {
      let source;
      try {
        const result = await createTapDataVerifier({ env, fetchImpl }).verify(async selectedId => {
          source = await service.readApiVerificationSources(db2, oracle,
            selectedId || transactionId || report.transaction?.transaction?.TRANSACTION_ID, { checkLatest: !transactionId });
          return source;
        }, { transactionId });
        report.api = { result, source, passed: result.passed };
      } catch (error) { report.api = { passed: false, error: error.message }; }
    }
  }
  if (stage === 'transaction') await withDb2(db => run(db));
  else if (stage === 'kyc') await withOracle(db => run(undefined, db));
  else await withDb2(db2 => withOracle(oracle => run(db2, oracle)));
  report.passed = Object.values(report).every(result => result.passed);
  return report;
}

function printVerification(report) {
  if (report.transaction) printTransactionVerification(report.transaction);
  if (report.kyc) {
    const result = report.kyc;
    console.log(`KYC customer ${result.customerId}: ${result.status} / ${result.riskRating ?? 'N/A'} — ${result.retrieved ? 'RETRIEVED' : 'NOT RETRIEVED'}, ${result.expectedState} — ${result.passed ? 'PASS' : 'FAIL'}`);
  }
  if (report.api?.source) printReport(report.api.result, report.api.source);
  else if (report.api) console.log(`TapData API verification: FAIL (${report.api.error})`);
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

module.exports = { runVerification, parseVerificationArgs, validateVerificationOptions, printVerification };
