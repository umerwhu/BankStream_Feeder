'use strict';

// Side-effect-free entry point: no dotenv, process.env or driver imports.
const { createDemoService } = require('./customer360-demo');
const { moneyToMinorUnits, formatMinorUnits, databaseMoneyToMinorUnits, validateAgainstAvailable } = require('./demo-amount');
const { runVerification, validateVerificationOptions } = require('./verification');
const { readJson } = require('./bounded-json');
const { validateHostedRealtimeOptions } = require('./cli');

function createHostedService(settings, { connections, fetchImpl } = {}) {
  const config = structuredClone(settings);
  for (const db of ['db2', 'oracle']) {
    if (!config[db]?.schema || !config[db].user || !config[db].password) throw new Error('Incomplete hosted database configuration');
  }
  if ((!config.db2.host && !config.db2.dsn) || !config.oracle.connectString ||
      !config.demo?.customerId || !config.demo.accountId) throw new Error('Incomplete hosted assignment');
  config.db2.suppressDiagnostics = true;
  const options = { ...config.demo, db2Schema: config.db2.schema, oracleSchema: config.oracle.schema,
    kycCustomerId: config.demo.customerId };
  const demo = createDemoService(options);
  const drivers = () => connections || require('./db');
  async function withDb(kind, action) {
    const db = await drivers()[kind === 'db2' ? 'connectDb2' : 'connectOracle'](config);
    try { return await action(db); }
    finally { await db.close(); }
  }
  return {
    status: () => withDb('db2', db2 => withDb('oracle', oracle => demo.status(db2, oracle))),
    preview: () => withDb('db2', db2 => demo.readWithdrawalAccount(db2)),
    realtime: async (options, execution) => {
      validateHostedRealtimeOptions(options, config.limits);
      const realtimeConfig = { ...config, retryLimit: 0 };
      const runner = require('./realtime').createRealtimeService(realtimeConfig, {
        signal: execution.signal, log: execution.output, progress: execution.progress, coordinate: execution.coordinate,
        stopOnError: true, detailedEvents: true, onIntent: execution.onIntent,
        formatError: () => 'Source operation failed; outcome may require reconciliation'
      });
      if (execution.signal.aborted) return null;
      return withDb('db2', db2 => withDb('oracle', oracle => runner.realtime(db2, oracle, options)));
    },
    kycPreview: () => withDb('oracle', oracle => demo.currentKyc(oracle)),
    kyc: expected => withDb('oracle', oracle => demo.setKyc(oracle, expected)),
    kycReset: expected => withDb('oracle', async oracle => {
      const reset = await demo.resetKyc(oracle, expected);
      const final = await demo.currentKyc(oracle);
      return { ...reset, final, passed: final.status === 'VERIFIED' && final.riskRating === 'LOW' };
    }),
    verify: async options => {
      const report = await runVerification({ service: demo, withDb2: action => withDb('db2', action),
        withOracle: action => withDb('oracle', action), env: config.tapdata || {}, fetchImpl: async (url, options) => {
          const response = await (fetchImpl || globalThis.fetch)(url, { ...options, redirect: 'error' });
          return { ok: response.ok, status: response.status, json: () => readJson(response) };
        } }, options);
      if (report.api?.error) report.api.error = 'Source or TapData verification unavailable';
      if (report.api?.result?.error) report.api.result.error = 'TapData comparison failed or did not synchronize';
      return report;
    },
    dryRun: async () => {
      const output = []; let passed = true;
      try { await require('./dry-run').dryRun({ connectDb2: () => drivers().connectDb2(config), connectOracle: () => drivers().connectOracle(config),
        log: text => output.push({ stream: 'stdout', text }), errorLog: text => output.push({ stream: 'stderr', text }),
        formatError: () => 'connectivity check failed' }); }
      catch { passed = false; }
      return { output, passed };
    },
    transaction: (amount, { transactionUuid, referenceUuid }) => {
      // Preallocate identifiers for audit/reconciliation without changing withdrawal logic.
      const ids = [transactionUuid, referenceUuid];
      const operation = createDemoService({ ...options, makeId: () => {
        const id = ids.shift();
        if (!id) throw new Error('Missing hosted transaction identifier');
        return id;
      } });
      return withDb('db2', db2 => operation.transaction(db2, amount));
    }
  };
}

module.exports = { createHostedService, moneyToMinorUnits, formatMinorUnits, databaseMoneyToMinorUnits, validateAgainstAvailable, validateVerificationOptions, validateHostedRealtimeOptions,
  checkRuntime: require('./runtime-check').checkRuntime };
