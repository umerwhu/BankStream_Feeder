'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createRemoteClient } = require('../src/remote-client');

const env = { DEMO_API_URL: 'https://demo.test', DEMO_API_TOKEN: 'test-token' };
const preview = { previewId: 'preview-123', account: { customerId: '100002', customerName: 'Demo',
  accountId: 'AC1000021', currency: 'GBP', accountStatus: 'ACTIVE', balance: '100.00', availableBalance: '90.00' } };
const committed = { transactionId: 'RT-test', amount: '12.50', currency: 'GBP', previousBalance: '100.00',
  newBalance: '87.50', previousAvailableBalance: '90.00', newAvailableBalance: '77.50',
  transactionTimestamp: '2026-10-29 12:00:00', completionTimestamp: '2026-10-29T12:00:01Z' };
const input = { amount: '12.5', previewId: preview.previewId, confirmed: true, idempotencyKey: 'key-123' };
const response = result => ({ ok: true, status: 200, json: async () => ({ version: 1, exitCode: 0, result }) });

test('preview is authenticated GET; submission is allowlisted JSON with stable idempotency header', async () => {
  const calls = [];
  const client = createRemoteClient({ env, fetchImpl: async (url, options) => {
    calls.push({ url: url.href, ...options });
    return response(options.method === 'GET' ? preview : committed);
  } });
  assert.deepEqual(await client.execute('transactionPreview'), preview);
  const supplied = { ...input, partnerId: 'other', schema: 'OTHER', connection: 'evil' };
  assert.deepEqual(await client.execute('transaction', supplied), committed);
  await client.execute('transaction', supplied);
  assert.equal(calls[0].url, 'https://demo.test/api/demo/transaction/preview');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
  for (const call of calls) {
    assert.equal(call.headers.authorization, 'Bearer test-token');
    assert.equal(call.redirect, 'error');
  }
  for (const call of calls.slice(1)) {
    assert.equal(call.url, 'https://demo.test/api/demo/transaction');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['idempotency-key'], 'key-123');
    assert.deepEqual(JSON.parse(call.body), { amount: '12.50', previewId: 'preview-123', confirmed: true });
  }
});

test('invalid confirmation, preview, amount or idempotency key never reaches HTTP', async () => {
  const client = createRemoteClient({ env, fetchImpl: () => assert.fail('HTTP must not run') });
  for (const change of [{ confirmed: false }, { previewId: '' }, { idempotencyKey: '' },
    { idempotencyKey: 'bad\r\nkey' }, { amount: '1.234' }, { amount: '0' }]) {
    await assert.rejects(client.execute('transaction', { ...input, ...change }));
  }
});

test('malformed preview and transaction responses are rejected', async () => {
  for (const [operation, data] of [['transactionPreview', { ...preview, previewId: '' }],
    ['transactionPreview', { ...preview, account: { ...preview.account, availableBalance: 'invalid' } }],
    ['transaction', {}]]) {
    await assert.rejects(createRemoteClient({ env, fetchImpl: async () => response(data) }).execute(operation, input), /invalid transaction response/);
  }
});

test('preview and submission handle authentication and stale preview failures without retrying', async () => {
  for (const operation of ['transactionPreview', 'transaction']) {
    for (const status of [401, 403, 409, 500]) {
      let calls = 0;
      await assert.rejects(createRemoteClient({ env, fetchImpl: async () => {
        calls++; return { ok: false, status };
      } }).execute(operation, input), /authentication failed|HTTP 409|HTTP 500/);
      assert.equal(calls, 1);
    }
  }
});

test('mutation network errors and timeouts retain the key for reconciliation and never retry', async () => {
  for (const stall of [false, true]) {
    let calls = 0;
    await assert.rejects(createRemoteClient({ env: { ...env, DEMO_API_TIMEOUT_MS: '10' }, fetchImpl: async () => {
      calls++;
      if (stall) return new Promise(() => {});
      throw new Error('secret');
    } }).execute('transaction', input), error => /outcome may be unknown/.test(error.message) &&
      /key-123/.test(error.message) && !/secret|test-token/.test(error.message));
    assert.equal(calls, 1);
  }
  await assert.rejects(createRemoteClient({ env: { ...env, DEMO_API_TIMEOUT_MS: '10' },
    fetchImpl: () => new Promise(() => {}) }).execute('transactionPreview'), /timed out/);
});

function runTransaction({ answers = ['12.5', 'y'], mode = 'remote', status = 200, account = preview.account, tty = true } = {}) {
  const script = `
    const Module = require('node:module'); const load = Module._load;
    const answers = ${JSON.stringify(answers)}; const account = ${JSON.stringify(account)};
    const committed = ${JSON.stringify(committed)};
    Object.defineProperty(process.stdin, 'isTTY', { value: ${tty} });
    Module._load = function(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'node:readline/promises') return { createInterface: () => ({
        question: async question => { console.log('PROMPT ' + question); return answers.shift(); }, close() {}
      }) };
      if (${JSON.stringify(mode)} === 'remote' && ['./db','./config','oracledb','odbc','./db2-jdbc-bridge'].includes(name)) throw Error('FORBIDDEN DB IMPORT');
      if (${JSON.stringify(mode)} === 'local' && name === './db') return { connectDb2: async () => ({ close: async () => {} }) };
      if (${JSON.stringify(mode)} === 'local' && name === './customer360-demo') return {
        DEFAULTS: {}, createDemoService: () => ({ readWithdrawalAccount: async () => account,
          transaction: async (db, amount) => { if (amount !== '12.50') throw Error('wrong amount'); return committed; } })
      };
      return load.apply(this, arguments);
    };
    globalThis.fetch = async (url, options) => {
      console.error('HTTP ' + options.method + ' ' + url.pathname);
      if (${status} !== 200) return { ok: false, status: ${status} };
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        if (body.amount !== '12.50' || body.previewId !== 'preview-123' || body.confirmed !== true) throw Error('wrong body');
        if (!/^[a-f0-9-]{36}$/.test(options.headers['idempotency-key'])) throw Error('missing UUID');
      }
      return { ok: true, status: 200, json: async () => ({ version: 1, exitCode: 0,
        result: options.method === 'GET' ? { previewId: 'preview-123', account } : committed }) };
    };
    process.argv = [process.execPath, 'demo-cli.js', 'transaction'];
    require(${JSON.stringify(path.resolve(__dirname, '../src/demo-cli.js'))});
  `;
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (/^(FEEDER_|DEMO_|DB2I_|ORACLE_|TAPDATA_)/.test(key)) delete childEnv[key];
  Object.assign(childEnv, env, { FEEDER_MODE: mode });
  return spawnSync(process.execPath, ['-e', script], { env: childEnv, encoding: 'utf8', timeout: 10000 });
}

test('remote CLI reuses local amount prompts, confirmation and committed output without DB imports', () => {
  const local = runTransaction({ mode: 'local' });
  const remote = runTransaction();
  assert.equal(local.status, 0, local.stderr);
  assert.equal(remote.status, 0, remote.stderr);
  assert.equal(local.stdout, remote.stdout);
  assert.match(remote.stdout, /Enter withdrawal amount in GBP/);
  assert.match(remote.stdout, /Confirm withdrawal\? \(y\/N\)/);
  assert.match(remote.stdout, /Amount: 12.50 GBP/);
  assert.match(remote.stderr, /HTTP POST \/api\/demo\/transaction/);
  for (const answer of ['Y', 'yes', ' YES ']) assert.equal(runTransaction({ answers: ['12.5', answer] }).status, 0);
});

test('cancelled, unconfirmed and invalid withdrawals never submit mutations', () => {
  for (const answer of ['n', 'no', '', 'maybe']) {
    const child = runTransaction({ answers: ['12.5', answer] });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Withdrawal cancelled; no database changes were made/);
    assert.doesNotMatch(child.stderr, /HTTP POST/);
  }
  for (const amount of ['0', '-1', 'abc', '1.234', '90.01']) {
    const child = runTransaction({ answers: [amount] });
    assert.equal(child.status, 1);
    assert.doesNotMatch(child.stderr, /HTTP POST/);
    assert.doesNotMatch(child.stdout, /Confirm withdrawal/);
  }
});

test('preview failures, unsuitable accounts and noninteractive input prevent submission', () => {
  for (const options of [{ status: 401 }, { status: 403 }, { tty: false },
    { account: { ...preview.account, currency: 'USD' } }, { account: { ...preview.account, accountStatus: 'CLOSED' } }]) {
    const child = runTransaction(options);
    assert.equal(child.status, 1, child.stdout);
    assert.doesNotMatch(child.stderr, /HTTP POST|FORBIDDEN/);
  }
});
