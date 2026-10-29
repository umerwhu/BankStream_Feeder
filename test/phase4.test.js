'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { runVerification, parseVerificationArgs } = require('../src/verification');
const { createRemoteClient } = require('../src/remote-client');
const { readJson } = require('../src/bounded-json');
const env = { DEMO_API_URL: 'https://control.test', DEMO_API_TOKEN: 'test-token' };

test('verification defaults compose existing source and TapData checks; stage flags remain scoped', async () => {
  const calls = [];
  const source = { customerId: '100002', accountId: 'AC1000021', balance: '100', availableBalance: '90', currency: 'GBP', latestTransactionId: 'RT-test',
    transaction: { id: 'RT-test', amount: '12.50', currency: 'GBP', type: 'WITHDRAWAL', stage: 'POSTED', status: 'COMPLETED' },
    kyc: { customerId: '100002', status: 'VERIFIED', riskRating: 'LOW' } };
  const dependencies = {
    service: { verifyTransaction: async () => { calls.push('transaction'); return { passed: true, transaction: { TRANSACTION_ID: 'RT-test' } }; },
      verifyKyc: async () => { calls.push('kyc'); return { passed: true }; },
      readApiVerificationSources: async (db2, oracle, id) => {
        if (calls.includes('transaction')) assert.equal(id, 'RT-test');
        return source;
      } },
    withDb2: async fn => { calls.push('db2'); return fn({}); },
    withOracle: async fn => { calls.push('oracle'); return fn({}); },
    env: { TAPDATA_API_BASE_URL: 'https://tap.test', TAPDATA_ACCESS_TOKEN: 'partner-token', DEMO_API_CDC_TIMEOUT_MS: '0' },
    fetchImpl: async (url, options) => {
      calls.push('api'); assert.equal(options.headers.authorization, 'Bearer partner-token');
      return { ok: true, status: 200, json: async () => ({ data: url.pathname.endsWith('CUSTOMER_KYC') ?
        [{ CUSTOMER_ID: '100002', KYC_STATUS: 'VERIFIED', RISK_RATING: 'LOW' }] :
        [{ CUSTOMER_ID: '100002', ACCOUNT_CUSTOMER_RELATIONSHIP: [{ ACCOUNT_ID: 'AC1000021', ACCOUNT: {
          BALANCE: '100', AVAILABLE_BALANCE: '90', CURRENCY: 'GBP', ACCOUNT_TRANSACTION: [{ TRANSACTION_ID: 'RT-test',
            TRANSACTION_AMOUNT: '12.50', CURRENCY: 'GBP', TRANSACTION_TYPE: 'WITHDRAWAL', TRANSACTION_STAGE: 'POSTED', TRANSACTION_STATUS: 'COMPLETED' }]
        } }] }] }) };
    }
  };
  const report = await runVerification(dependencies);
  assert.equal(report.passed, true); assert.equal(report.api.result.passed, true);
  assert.ok(['transaction', 'kyc', 'api'].every(key => calls.includes(key)));
  for (const stage of ['transaction', 'kyc', 'api']) {
    calls.length = 0; await runVerification(dependencies, { stage });
    if (stage !== 'api') assert.ok(!calls.includes('api'));
    if (stage === 'transaction') assert.ok(!calls.includes('oracle'));
    if (stage === 'kyc') assert.ok(!calls.includes('db2'));
  }
  dependencies.service.verifyTransaction = async () => ({ passed: false });
  assert.equal((await runVerification(dependencies)).passed, false);
  dependencies.service.verifyTransaction = async () => ({ passed: true, transaction: { TRANSACTION_ID: 'RT-test' } });
  source.latestTransactionId = 'RT-newer';
  assert.equal((await runVerification(dependencies)).api.result.sourceChanged, true);
  assert.deepEqual(parseVerificationArgs(['--stage', 'api', '--transaction-id', 'RT-test']), { stage: 'api', transactionId: 'RT-test' });
  assert.throws(() => parseVerificationArgs(['--stage', 'other']));
  assert.throws(() => parseVerificationArgs(['--transaction-id', 'RT-test']));
});

test('new client endpoint mappings allow only intended fields and accept verification FAIL envelopes', async () => {
  const calls = [];
  const client = createRemoteClient({ env, fetchImpl: async (url, options) => {
    calls.push({ path: url.pathname, ...options });
    const result = { transaction: { passed: false }, passed: false };
    return { ok: true, status: 200, json: async () => ({ version: 1, exitCode: 1, result }) };
  } });
  assert.equal((await client.execute('verify', { stage: 'transaction', schema: 'OTHER' })).passed, false);
  await assert.rejects(client.execute('unknownOperation'), /not yet supported in remote mode/);
  assert.deepEqual(calls.map(c => c.path), ['/api/demo/verify']);
  assert.deepEqual(JSON.parse(calls[0].body), { stage: 'transaction' });
});

test('JSON response reading is bounded for streamed and mocked payloads', async () => {
  await assert.rejects(readJson(new Response('x'.repeat(100)), 10), /too large/);
  await assert.rejects(readJson({ json: async () => ({ secret: 'x'.repeat(100) }) }, 10), /too large/);
});

function cli({ command, mode = 'remote', answer = 'y', passed = true, args = [], target = false }) {
  const script = `
    const Module = require('node:module'); const load = Module._load;
    let state = { customerId: '100002', kycRecordId: 'K1', status: ${JSON.stringify(target ? 'REVIEW_REQUIRED' : 'VERIFIED')}, riskRating: ${JSON.stringify(target ? 'HIGH' : 'LOW')} };
    if (${JSON.stringify(command)} === 'kyc:reset') state = { ...state, status: 'REVIEW_REQUIRED', riskRating: 'HIGH' };
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Module._load = function(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'node:readline/promises') return { createInterface: () => ({ question: async question => { console.log(question); return ${JSON.stringify(answer)}; }, close() {} }) };
      if (${JSON.stringify(mode)} === 'remote' && ['./config','./db','oracledb','odbc'].includes(name)) throw Error('FORBIDDEN DRIVER');
      if (name === './config') return { config: { db2: {}, oracle: {} } };
      if (name === './db') return { connectOracle: async () => ({ close: async () => {} }) };
      if (${JSON.stringify(mode)} === 'local' && name === './customer360-demo') return { DEFAULTS: {}, createDemoService: () => ({
        currentKyc: async () => ({ ...state }),
        setKyc: async () => { const previous = { ...state }; state = { ...state, status: 'REVIEW_REQUIRED', riskRating: 'HIGH' }; return { changed: true, previous, current: state }; },
        resetKyc: async () => { state = { ...state, status: 'VERIFIED', riskRating: 'LOW' }; return { changed: true, current: state }; }
      }) };
      return load.apply(this, arguments);
    };
    globalThis.fetch = async (url, options) => {
      console.error('HTTP ' + options.method + ' ' + url.pathname);
      let result;
      if (url.pathname.endsWith('/preview')) result = { previewId: 'preview-kyc', kyc: state };
      else if (url.pathname.endsWith('/verify')) {
        const input = JSON.parse(options.body); if (JSON.stringify(input) !== ${JSON.stringify(JSON.stringify(args.length ? { stage: args[1] } : {}))}) throw Error('wrong flags');
        result = { passed: ${passed}, kyc: { ...state, retrieved: true, expectedState: 'fixed demo baseline', passed: ${passed} } };
      } else {
        const body = JSON.parse(options.body);
        if (body.previewId !== 'preview-kyc' || body.confirmed !== true || !options.headers['idempotency-key']) throw Error('missing protection');
        const previous = { ...state };
        state = { ...state, status: url.pathname.endsWith('/reset') ? 'VERIFIED' : 'REVIEW_REQUIRED', riskRating: url.pathname.endsWith('/reset') ? 'LOW' : 'HIGH' };
        result = url.pathname.endsWith('/reset') ? { changed: true, final: state, passed: true } : { changed: true, previous, current: state };
      }
      return { ok: true, status: 200, json: async () => ({ version: 1, exitCode: result.passed === false ? 1 : 0, result }) };
    };
    process.argv = [process.execPath, 'cli', ${JSON.stringify(command)}, ...${JSON.stringify(args)}];
    require(${JSON.stringify(path.resolve(__dirname, '../src'))} + '/demo-cli.js');
  `;
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (/^(FEEDER_|DEMO_|DB2I_|ORACLE_|TAPDATA_)/.test(key)) delete childEnv[key];
  Object.assign(childEnv, env, { FEEDER_MODE: mode });
  return spawnSync(process.execPath, ['-e', script], { env: childEnv, encoding: 'utf8', timeout: 10000 });
}

test('KYC update and reset preserve local prompts/output; remote cancellations send no POST', () => {
  for (const command of ['kyc', 'kyc:reset']) {
    const remote = cli({ command }); const local = cli({ command, mode: 'local' });
    assert.equal(remote.status, 0, remote.stderr); assert.equal(local.status, 0, local.stderr);
    assert.equal(remote.stdout, local.stdout);
    assert.match(remote.stderr, /HTTP POST/);
    for (const answer of ['n', '', 'no', 'maybe']) {
      const cancelled = cli({ command, answer });
      assert.equal(cancelled.status, 0, cancelled.stderr); assert.match(cancelled.stdout, /cancelled/);
      assert.doesNotMatch(cancelled.stderr, /HTTP POST|FORBIDDEN/);
    }
  }
  const noUpdate = cli({ command: 'kyc', target: true });
  assert.match(noUpdate.stdout, /No update needed/); assert.doesNotMatch(noUpdate.stderr, /HTTP POST/);
});

test('remote verification flags and PASS/FAIL exit status need no local credentials', () => {
  for (const passed of [true, false]) {
    for (const command of ['verify']) {
      const child = cli({ command, passed });
      assert.equal(child.status, passed ? 0 : 1, child.stderr);
      assert.doesNotMatch(child.stderr, /FORBIDDEN/);
      if (command === 'verify') assert.match(child.stdout, passed ? /PASS/ : /FAIL/);
    }
  }
  assert.equal(cli({ command: 'verify', args: ['--stage', 'kyc'] }).status, 0);
});
