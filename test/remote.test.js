'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { getExecutionMode, getRemoteConfig } = require('../src/execution-mode');
const { createRemoteClient } = require('../src/remote-client');

const env = { DEMO_API_URL: 'https://demo.example.test', DEMO_API_TOKEN: 'test-token' };
const result = {
  customer: { CUSTOMER_ID: 100002, CUSTOMER_NAME: 'Demo', CUSTOMER_STATUS: 'ACTIVE', ACCOUNT_ID: 'AC1000021',
    ACCOUNT_NUMBER: '123', ACCOUNT_STATUS: 'ACTIVE', CURRENCY: 'GBP', BALANCE: '100', AVAILABLE_BALANCE: '90',
    OWNERSHIP_ROLE: 'PRIMARY', EFFECTIVE_FROM: '2026-01-01' },
  transactions: [], kyc: [100002, 'K1', 'VERIFIED', 'LOW']
};
const payload = { version: 1, result, exitCode: 0 };
const ok = () => ({ ok: true, status: 200, json: async () => payload });

test('execution mode defaults to local without needing remote or database settings', () => {
  assert.equal(getExecutionMode({}), 'local');
  assert.equal(getExecutionMode({ FEEDER_MODE: 'local' }), 'local');
  assert.equal(getExecutionMode({ FEEDER_MODE: 'remote' }), 'remote');
  for (const value of ['', 'REMOTE', 'other']) assert.throws(() => getExecutionMode({ FEEDER_MODE: value }), /FEEDER_MODE/);
});

test('remote configuration requires HTTPS, safe bearer token and bounded timeout', () => {
  assert.equal(getRemoteConfig(env).timeoutMs, 30000);
  for (const url of [undefined, 'bad', 'http://demo.test', 'https://user:pass@demo.test', 'https://demo.test/?token=x', 'https://demo.test/#x']) {
    assert.throws(() => getRemoteConfig({ ...env, DEMO_API_URL: url }), /DEMO_API_URL/);
  }
  for (const token of [undefined, '', 'a\r\nb', 'a b']) assert.throws(() => getRemoteConfig({ ...env, DEMO_API_TOKEN: token }), /DEMO_API_TOKEN/);
  for (const value of ['0', '-1', '1.5', 'NaN', '300001']) assert.throws(() => getRemoteConfig({ ...env, DEMO_API_TIMEOUT_MS: value }), /TIMEOUT/);
});

test('status uses fixed GET endpoint, bearer authentication and disables redirects', async () => {
  const client = createRemoteClient({ env, fetchImpl: async (url, options) => {
    assert.equal(url.href, 'https://demo.example.test/api/demo/status');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
    return ok();
  } });
  assert.deepEqual(await client.execute('status'), result);
  await assert.rejects(client.execute('../transaction'), /not yet supported/);
});

for (const [label, status] of [['invalid', 401], ['expired', 401], ['revoked', 403]]) {
  test(`${label} token response fails without disclosing server details`, async () => {
    const client = createRemoteClient({ env, fetchImpl: async () => ({ status, ok: false, json: async () => { throw new Error('secret'); } }) });
    await assert.rejects(client.execute('status'), error => /authentication failed/.test(error.message) && !/secret|test-token/.test(error.message));
  });
}

test('missing token prevents any network request', () => {
  assert.throws(() => createRemoteClient({ env: { DEMO_API_URL: env.DEMO_API_URL }, fetchImpl: () => assert.fail('network called') }), /DEMO_API_TOKEN/);
});

test('network and server errors never echo transport messages or response bodies', async () => {
  for (const fetchImpl of [async () => { throw new Error('secret test-token'); }, async () => ({ status: 500, ok: false })]) {
    await assert.rejects(createRemoteClient({ env, fetchImpl }).execute('status'), error =>
      /Unable to reach|HTTP 500/.test(error.message) && !/secret|test-token/.test(error.message));
  }
});

test('timeout covers stalled requests and stalled JSON bodies', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })]) {
    await assert.rejects(createRemoteClient({ env: { ...env, DEMO_API_TIMEOUT_MS: '10' }, fetchImpl }).execute('status'), /timed out/);
  }
});

test('malformed JSON and incompatible status envelopes fail safely', async () => {
  for (const json of [async () => { throw new Error('secret'); }, async () => ({}), async () => ({ ...payload, result: null }), async () => ({ ...payload, exitCode: 1 })]) {
    await assert.rejects(createRemoteClient({ env, fetchImpl: async () => ({ ok: true, status: 200, json }) }).execute('status'), /invalid.*response/);
  }
});

// Run the real CLI in isolated processes; prevent dotenv from reading developer credentials.
// Driver/config imports are trapped, and local connection calls are replaced with fixtures.
function runCli({ mode, command = 'status', entry = 'demo-cli.js', fail = false }) {
  const script = `
    const Module = require('node:module');
    const original = Module._load;
    const fixture = ${JSON.stringify(result)};
    Module._load = function(name, parent, main) {
      if (name === 'dotenv') return { config() {} };
      if (${JSON.stringify(mode)} === 'remote' && ['oracledb', 'odbc', './db', './config', './realtime', './db2-jdbc-bridge'].includes(name)) {
        throw new Error('FORBIDDEN DATABASE IMPORT: ' + name);
      }
      if (name === './db') return {
        connectDb2: async () => ({ query: async sql => /FETCH FIRST 10/.test(sql) ? fixture.transactions : [fixture.customer], close: async () => {} }),
        connectOracle: async () => ({ execute: async () => ({ rows: [fixture.kyc] }), close: async () => {} })
      };
      return original.apply(this, arguments);
    };
    globalThis.fetch = async () => ${fail ? "({ ok: false, status: 401 })" : `({ ok: true, status: 200, json: async () => (${JSON.stringify(payload)}) })`};
    process.argv = [process.execPath, ${JSON.stringify(entry)}, ${JSON.stringify(command)}];
    require(${JSON.stringify(path.resolve(__dirname, '../src', entry))});
  `;
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (/^(FEEDER_|DEMO_|DB2I_|ORACLE_|TAPDATA_)/.test(key)) delete childEnv[key];
  if (mode !== undefined) childEnv.FEEDER_MODE = mode;
  if (mode === 'remote') Object.assign(childEnv, env);
  return spawnSync(process.execPath, ['-e', script], { env: childEnv, encoding: 'utf8', timeout: 10000 });
}

test('remote status works without DB credentials or database imports and preserves local output', () => {
  const remote = runCli({ mode: 'remote' });
  const local = runCli({ mode: 'local' });
  const defaultLocal = runCli({});
  for (const child of [remote, local, defaultLocal]) assert.equal(child.status, 0, child.stderr);
  assert.equal(remote.stdout, local.stdout);
  assert.equal(local.stdout, defaultLocal.stdout);
  assert.match(remote.stdout, /Customer 100002: Demo/);
  assert.match(remote.stdout, /Oracle KYC: VERIFIED/);
});

test('remote CLI authentication failure exits with code 1', () => {
  const child = runCli({ mode: 'remote', fail: true });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /authentication failed/);
});

test('remote realtime rejects incompatible start responses before database imports', () => {
  for (const command of ['realtime']) {
    const child = runCli({ mode: 'remote', command, entry: command === 'realtime' ? 'demo.js' : 'demo-cli.js' });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /invalid realtime response/);
    assert.doesNotMatch(child.stderr, /FORBIDDEN/);
  }
});
