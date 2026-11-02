'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDemoReset } = require('../src/demo-reset');
const { runResetCommand } = require('../src/reset-cli');
const { createRemoteClient } = require('../src/remote-client');

function fixture({ failAccount = false, failKyc = false, mismatch = false } = {}) {
  const state = { balance: '123.00', available: '100.00', status: 'REVIEW_REQUIRED', risk: 'HIGH', updates: 0, kycUpdates: 0, rollbacks: 0 };
  let snapshot;
  const db2 = {
    beginTransaction: async () => { snapshot = { balance: state.balance, available: state.available }; },
    commit: async () => {}, rollback: async () => { Object.assign(state, snapshot); state.rollbacks++; },
    query: async (sql, binds) => {
      assert.match(sql, /CUSTOMCORE\./);
      if (sql.includes('JOIN')) {
        assert.deepEqual(binds, ['765432', 'CUSTOM-ACCOUNT']);
        return [{ CUSTOMER_ID: binds[0], ACCOUNT_ID: binds[1], BALANCE: state.balance, AVAILABLE_BALANCE: state.available }];
      }
      if (sql.includes('FOR UPDATE')) { assert.deepEqual(binds, ['CUSTOM-ACCOUNT']); return [{ ACCOUNT_ID: binds[0] }]; }
      assert.match(sql, /^UPDATE CUSTOMCORE\.BANK_ACCOUNT SET BALANCE=CAST/);
      assert.deepEqual(binds, ['40000.00', '40000.00', 'CUSTOM-ACCOUNT']);
      if (failAccount) throw new Error('account unavailable');
      state.updates++;
      if (!mismatch) { state.balance = binds[0]; state.available = binds[1]; }
      return { count: 1 };
    }
  };
  const oracle = {
    commit: async () => {}, rollback: async () => {},
    execute: async (sql, binds) => {
      assert.equal(binds.customerId, 765432);
      assert.match(sql, /CUSTOMCRM\.CUSTOMER_KYC/);
      if (sql.startsWith('SELECT')) return { rows: [['765432', 'KYC-CUSTOM', state.status, state.risk]] };
      if (failKyc) throw new Error('KYC unavailable');
      assert.equal(binds.status, 'VERIFIED'); assert.equal(binds.risk, 'LOW');
      state.status = binds.status; state.risk = binds.risk; state.kycUpdates++;
      return { rowsAffected: 1 };
    }
  };
  const reset = createDemoReset({ db2Schema: 'CUSTOMCORE', oracleSchema: 'CUSTOMCRM', customerId: '765432', accountId: 'CUSTOM-ACCOUNT' });
  return { state, run: operation => reset.run({ withDb2: action => action(db2), withOracle: action => action(oracle) }, operation) };
}

test('reset uses configured IDs, restores and verifies both databases, and repeats without further updates', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.passed, true);
  assert.equal(result.customerId, '765432'); assert.equal(result.accountId, 'CUSTOM-ACCOUNT');
  assert.deepEqual(result.account, { passed: true, changed: true, balance: '40000.00', availableBalance: '40000.00' });
  assert.equal(result.kyc.status, 'VERIFIED'); assert.equal(result.kyc.riskRating, 'LOW');
  const second = await f.run();
  assert.equal(second.passed, true); assert.equal(second.kyc.changed, false); assert.equal(second.account.changed, false);
  assert.equal(f.state.updates, 1); assert.equal(f.state.kycUpdates, 1);
});

for (const options of [{ failAccount: true }, { failKyc: true }, { mismatch: true }]) {
  test(`reset reports partial failures and rolls back unverified account changes: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options); const result = await f.run();
    assert.equal(result.passed, false);
    assert.equal(result.kyc.passed, !options.failKyc);
    assert.equal(result.account.passed, !!options.failKyc);
    if (!options.failKyc) { assert.equal(f.state.rollbacks, 1); assert.equal(f.state.balance, '123.00'); }
  });
}

test('invalid schema or customer IDs are rejected before database access', () => {
  assert.throws(() => createDemoReset({ db2Schema: 'BAD;SQL' }), /schema/);
  assert.throws(() => createDemoReset({ customerId: 'bad' }), /digits/);
});

test('CLI cancellation does not execute reset; confirmed reset prints IDs and both results', async () => {
  const preview = async () => ({ account: { customerId: '765432', accountId: 'CUSTOM-ACCOUNT', balance: 1, availableBalance: 1 }, kyc: { customerId: '765432', status: 'REVIEW_REQUIRED', riskRating: 'HIGH' } });
  const lines = []; let executions = 0;
  const execute = async () => { executions++; return fixture().run(); };
  const ask = answers => async () => answers.shift();
  await runResetCommand({ preview, execute, ask: ask(['3', '']), log: line => lines.push(line) });
  assert.equal(executions, 0);
  await runResetCommand({ preview, execute, ask: ask(['3', 'y']), log: line => lines.push(line) });
  assert.equal(executions, 1);
  assert.match(lines.join('\n'), /Customer ID       : 765432/);
  assert.match(lines.join('\n'), /Account ID        : CUSTOM-ACCOUNT/);
  assert.match(lines.join('\n'), /KYC Reset         : SUCCESS/);
  assert.match(lines.join('\n'), /Available Balance : 40000.00/);
});

test('remote reset sends confirmation and idempotency key and accepts a partial failure report', async () => {
  const report = await fixture({ failAccount: true }).run();
  const client = createRemoteClient({ env: { DEMO_API_URL: 'https://demo.example.com', DEMO_API_TOKEN: 'test-token' },
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname, '/api/demo/reset');
      assert.equal(options.headers['idempotency-key'], 'reset-key');
      assert.deepEqual(JSON.parse(options.body), { previewId: 'reset-preview', confirmed: true });
      return { ok: true, status: 200, json: async () => ({ version: 1, result: report, exitCode: 1 }) };
    } });
  assert.deepEqual(await client.execute('reset', { previewId: 'reset-preview', confirmed: true, idempotencyKey: 'reset-key' }), report);
});

test('remote reset rejects false verification claims and retains the reconciliation key', async () => {
  const report = await fixture().run();
  report.account.availableBalance = '39999.00';
  const client = createRemoteClient({ env: { DEMO_API_URL: 'https://demo.example.com', DEMO_API_TOKEN: 'test-token' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: 1, result: report, exitCode: 0 }) }) });
  await assert.rejects(client.execute('reset', { previewId: 'preview', confirmed: true, idempotencyKey: 'reconcile-reset-key' }),
    /Demo reset outcome may be unknown.*reconcile-reset-key/);
});

test('CLI partial failure summary identifies each result and explains separate commits', async () => {
  const lines = [];
  const report = await fixture({ failKyc: true }).run();
  const result = await runResetCommand({ preview: async () => ({ account: { customerId: report.customerId, accountId: report.accountId, balance: '123.00', availableBalance: '100.00' }, kyc: {} }),
    execute: async () => report, ask: (() => { const answers = ['3', 'y']; return async () => answers.shift(); })(), log: line => lines.push(line) });
  assert.equal(result.passed, false);
  assert.match(lines.join('\n'), /KYC Reset         : FAILED/);
  assert.match(lines.join('\n'), /Balance           : 40000.00/);
  assert.match(lines.join('\n'), /failed or partially completed/);
});

for (const [choice, operation] of [['1', 'kyc'], ['2', 'account'], ['3', 'both']]) {
  test(`menu option ${choice} executes, verifies and summarizes only ${operation}`, async () => {
    const f = fixture(); const lines = []; const answers = [choice, 'y'];
    const result = await runResetCommand({ ask: async () => answers.shift(), log: line => lines.push(line),
      preview: async selected => { assert.equal(selected, operation); return { account: { customerId: '765432', accountId: 'CUSTOM-ACCOUNT', balance: '123.00', availableBalance: '100.00' }, kyc: { customerId: '765432' } }; },
      execute: async (_preview, selected) => f.run(selected) });
    assert.equal(result.passed, true);
    assert.equal(f.state.kycUpdates, operation === 'account' ? 0 : 1);
    assert.equal(f.state.updates, operation === 'kyc' ? 0 : 1);
    const summary = lines.join('\n').split('========== RESET SUMMARY ==========')[1];
    if (operation !== 'account') assert.match(summary, /KYC Reset         : SUCCESS/);
    else assert.doesNotMatch(summary, /KYC Reset/);
    if (operation !== 'kyc') assert.match(summary, /Available Balance : 40000.00/);
    else assert.doesNotMatch(summary, /Balance/);
    assert.equal((await f.run(operation)).passed, true);
    assert.equal(f.state.kycUpdates, operation === 'account' ? 0 : 1);
    assert.equal(f.state.updates, operation === 'kyc' ? 0 : 1);
  });
}

for (const responses of [['4'], ['1', ''], ['2', 'n'], ['3', 'invalid'], ['bad', '0', '4']]) {
  test(`cancel and invalid selections never execute: ${JSON.stringify(responses)}`, async () => {
    const answers = [...responses]; let previews = 0;
    await runResetCommand({ ask: async () => answers.shift(), log: () => {},
      preview: async () => { previews++; return { account: { balance: '123.00', availableBalance: '100.00' }, kyc: { customerId: '765432' } }; }, execute: async () => assert.fail('unexpected mutation') });
    assert.equal(previews, responses.at(-1) === '4' ? 0 : 1);
  });
}

test('invalid input reprompts and then accepts a valid selection', async () => {
  const answers = ['0', 'bad', '1', 'y']; const lines = []; const f = fixture();
  await runResetCommand({ ask: async () => answers.shift(), log: line => lines.push(line),
    preview: async () => ({ account: { balance: '123.00', availableBalance: '100.00' }, kyc: { customerId: '765432' } }), execute: (_preview, operation) => f.run(operation) });
  assert.equal(lines.filter(line => line.startsWith('Invalid selection')).length, 2);
});

for (const operation of ['kyc', 'account']) {
  test(`remote request sends ${operation} and validates only its result`, async () => {
    const report = await fixture().run(operation);
    const client = createRemoteClient({ env: { DEMO_API_URL: 'https://demo.example.com', DEMO_API_TOKEN: 'test-token' },
      fetchImpl: async (_url, options) => {
        assert.equal(JSON.parse(options.body).operation, operation);
        return { ok: true, status: 200, json: async () => ({ version: 1, result: report, exitCode: 0 }) };
      } });
    assert.deepEqual(await client.execute('reset', { operation, previewId: 'preview', confirmed: true, idempotencyKey: 'key' }), report);
  });
}

for (const kycBaseline of [false, true]) for (const accountBaseline of [false, true]) {
  test(`both resets independently skip existing baselines (KYC=${kycBaseline}, account=${accountBaseline})`, async () => {
    const f = fixture(); const lines = []; const answers = ['3', 'y'];
    if (kycBaseline) { f.state.status = 'VERIFIED'; f.state.risk = 'LOW'; }
    if (accountBaseline) { f.state.balance = '40000.0000'; f.state.available = '40000.00'; }
    const result = await runResetCommand({ log: line => lines.push(line), ask: async () => answers.shift(),
      preview: async () => ({ account: { customerId: '765432', accountId: 'CUSTOM-ACCOUNT', balance: f.state.balance,
        availableBalance: f.state.available }, kyc: { status: f.state.status, riskRating: f.state.risk } }),
      execute: (_preview, operation) => {
        assert.equal(operation, kycBaseline ? 'account' : accountBaseline ? 'kyc' : 'both');
        return f.run(operation);
      } });
    if (kycBaseline && accountBaseline) { assert.equal(result, undefined); assert.equal(answers.length, 1); assert.ok(lines.join(' ').includes('No reset required.')); return; }
    assert.equal(result.passed, true);
    assert.equal(f.state.kycUpdates, kycBaseline ? 0 : 1);
    assert.equal(f.state.updates, accountBaseline ? 0 : 1);
    const summary = lines.join('\n').split('========== RESET SUMMARY ==========')[1];
    assert.ok(summary.includes(`KYC Reset         : ${kycBaseline ? 'SKIPPED - no reset required' : 'SUCCESS'}`));
    assert.ok(summary.includes(`Account Reset     : ${accountBaseline ? 'SKIPPED - no reset required' : 'SUCCESS'}`));
    assert.match(summary, /KYC Status        : VERIFIED\nRisk Level        : LOW/);
    assert.match(summary, /Balance           : 40000.0+\nAvailable Balance : 40000.00/);
  });
}

test('source preview failure stops before confirmation or writes', async () => {
  const lines = [];
  await assert.rejects(runResetCommand({ preview: async () => { throw new Error('source unavailable'); },
    ask: async () => '3', execute: async () => assert.fail('unexpected write'),
    log: line => lines.push(line) }), /source unavailable/);
  assert.ok(!lines.join(' ').includes('Will reset:'));
});

for (const [choice, operation, message] of [
  ['1', 'kyc', 'KYC is already VERIFIED / LOW. No reset required.'],
  ['2', 'account', 'Account balances are already 40000. No reset required.'],
  ['3', 'both', 'KYC and account balances are already at their default values. No reset required.']
]) {
  test(`baseline option ${choice} reads after selection and never confirms or executes`, async () => {
    let selected = false; let reads = 0; const lines = [];
    await runResetCommand({ log: line => lines.push(line),
      ask: async question => { assert.equal(selected, false, 'must not ask for confirmation'); assert.match(question, /choice/); selected = true; return choice; },
      preview: async selectedOperation => {
        assert.equal(selected, true); assert.equal(selectedOperation, operation); reads++;
        return { account: { customerId: '765432', accountId: 'CUSTOM-ACCOUNT', balance: '40000.0000', availableBalance: 40000 },
          kyc: { customerId: '765432', status: 'VERIFIED', riskRating: 'LOW' } };
      }, execute: async () => assert.fail('must not execute a reset') });
    assert.equal(reads, 1); assert.ok(lines.includes(message));
    const display = lines.slice(2).join('\n');
    assert.match(display, /Customer ID       : 765432/);
    if (operation === 'kyc') assert.doesNotMatch(display, /Account ID|Balance/);
    if (operation === 'account') assert.doesNotMatch(display, /KYC Status|Risk Level/);
  });
}

test('invalid source balances fail before confirmation or mutation', async () => {
  let prompts = 0;
  await assert.rejects(runResetCommand({ log: () => {}, ask: async () => { prompts++; return '2'; },
    preview: async () => ({ account: { balance: 'invalid', availableBalance: 40000 } }),
    execute: async () => assert.fail('must not execute') }), /valid decimal/);
  assert.equal(prompts, 1);
});
