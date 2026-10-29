'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHostedService } = require('../src/hosted-service');

test('hosted package export loads without CLI, dotenv, environment config or database drivers', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const Module = require('node:module'); const load = Module._load;
    Module._load = function(name) {
      if (['dotenv', './config', './db', 'odbc', 'oracledb'].includes(name)) throw Error('Unexpected import: ' + name);
      return load.apply(this, arguments);
    };
    const api = require('banking-customer360-demo/service');
    if (typeof api.createHostedService !== 'function') throw Error('Missing service export');
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
});

test('hosted service snapshots explicit assignments and closes request-scoped connections', async () => {
  const settings = { db2: { schema: 'NEOCORE', host: 'mock', user: 'neo', password: 'dummy' },
    oracle: { schema: 'NEO_CRM', user: 'neo', password: 'dummy', connectString: 'mock' },
    demo: { customerId: '100002', accountId: 'AC1000021' } };
  let closed = 0;
  const service = createHostedService(settings, { connections: { connectDb2: async config => {
    assert.equal(config.db2.schema, 'NEOCORE');
    return { close: async () => { closed++; }, query: async (sql, binds) => {
      assert.match(sql, /NEOCORE\.CUSTOMER/);
      assert.deepEqual(binds, ['100002', 'AC1000021']);
      return [{ CUSTOMER_ID: '100002', ACCOUNT_ID: 'AC1000021', CUSTOMER_NAME: 'Demo', ACCOUNT_STATUS: 'ACTIVE', CURRENCY: 'GBP', BALANCE: 100, AVAILABLE_BALANCE: 90 }];
    } };
  } } });
  settings.db2.schema = 'KEPCORE'; settings.demo.customerId = '100011';
  assert.equal((await service.preview()).customerId, '100002');
  assert.equal(closed, 1);
  assert.throws(() => createHostedService({}), /Incomplete/);
});
