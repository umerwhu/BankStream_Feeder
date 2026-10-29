'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createRealtimeService } = require('../src/realtime');
const { runRemoteRealtime } = require('../src/remote-realtime');
const { parseRealtimeArgs, validateHostedRealtimeOptions } = require('../src/cli');
const { createRemoteClient } = require('../src/remote-client');

function source(schema, oracleSchema, { failOracle = false } = {}) {
  const calls = []; let oracleWrites = 0;
  const transactions = new Map();
  const db2 = { close: async () => {}, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    query: async (sql, binds = []) => {
      calls.push(sql); assert.ok(sql.includes(schema + '.'));
      if (sql.includes('JOIN')) return [{ CUSTOMER_ID: 100002, ACCOUNT_ID: 'AC1', CURRENCY: 'GBP' }];
      if (sql.includes("WHERE TRANSACTION_STATUS='PENDING' ORDER")) return [];
      if (sql.startsWith('INSERT')) { transactions.set(binds[0], 'PENDING'); return { count: 1 }; }
      if (sql.startsWith('SELECT TRANSACTION_STATUS')) return [{ TRANSACTION_STATUS: transactions.get(binds[0]) }];
      if (sql.startsWith('SELECT BALANCE')) return [{ BALANCE: 10000, AVAILABLE_BALANCE: 10000 }];
      if (sql.includes("SET TRANSACTION_STATUS='COMPLETED'")) transactions.set(binds[0], 'COMPLETED');
      return { count: 1 };
    }
  };
  const oracle = { close: async () => {}, execute: async sql => {
    calls.push(sql); assert.ok(sql.includes(oracleSchema + '.'));
    if (sql.startsWith('SELECT CUSTOMER_ID,CUSTOMER_PROFILE_ID')) return { rows: [[100002, 'CP1']] };
    oracleWrites++;
    if (failOracle) throw Error('password=private Oracle timeout');
    return { rowsAffected: 1 };
  } };
  return { db2, oracle, calls, writes: () => oracleWrites };
}

test('execution-scoped generator isolates schemas, counts, output and cancellation concurrently', async () => {
  const random = crypto.randomInt; crypto.randomInt = () => 0;
  try {
    const run = async (db2Schema, oracleSchema, cycles) => {
      const db = source(db2Schema, oracleSchema); const controller = new AbortController(); const output = []; const intents = [];
      const generator = createRealtimeService({ db2: { schema: db2Schema }, oracle: { schema: oracleSchema }, retryLimit: 0 }, {
        signal: controller.signal, log: text => output.push(text), detailedEvents: true, onIntent: async item => intents.push(item),
        progress: summary => { if (summary.cycles >= cycles) controller.abort(); }
      });
      const summary = await generator.realtime(db.db2, db.oracle, { durationMs: 100, intervalMs: 1, eventsPerCycle: 1 });
      return { summary, output, db, intents };
    };
    const [neo, kep] = await Promise.all([run('NEOCORE', 'NEO_CRM', 1), run('KEPCORE', 'KEP_CRM', 2)]);
    assert.equal(neo.summary.cycles, 1); assert.equal(kep.summary.cycles, 2);
    assert.equal(neo.summary.tables.get('NEOCORE.ACCOUNT_TRANSACTION').inserts, 1);
    assert.equal(kep.summary.tables.get('KEPCORE.ACCOUNT_TRANSACTION').inserts, 2);
    assert.equal(neo.summary.tables.get('NEO_CRM.CUSTOMER_PROFILE').updates, 1);
    assert.equal(kep.summary.tables.get('KEP_CRM.CUSTOMER_PROFILE').updates, 2);
    assert.doesNotMatch(neo.output.join('\n'), /KEPCORE|KEP_CRM|BANKCORE/);
    assert.doesNotMatch(kep.output.join('\n'), /NEOCORE|NEO_CRM|BANKCORE/);
    assert.ok(neo.output.some(line => line.includes('EXECUTION SUMMARY')));
    assert.equal(neo.intents.length, 1); assert.equal(kep.intents.length, 2);
    assert.match(neo.intents[0].transactionId, /^RT-/);
  } finally { crypto.randomInt = random; }
});

test('hosted fail-fast preserves partial committed counts, sanitizes errors and does not retry writes', async () => {
  const random = crypto.randomInt; crypto.randomInt = () => 0;
  try {
    const db = source('NEOCORE', 'NEO_CRM', { failOracle: true }); const output = []; let last;
    const generator = createRealtimeService({ db2: { schema: 'NEOCORE' }, oracle: { schema: 'NEO_CRM' }, retryLimit: 0 }, {
      stopOnError: true, formatError: () => 'Source operation failed', log: line => output.push(line), progress: summary => { last = summary; }
    });
    await assert.rejects(generator.realtime(db.db2, db.oracle, { durationMs: 100, intervalMs: 1 }), /Oracle timeout/);
    assert.equal(db.writes(), 1);
    assert.equal(last.tables.get('NEOCORE.ACCOUNT_TRANSACTION').inserts, 1);
    assert.equal(last.tables.get('NEOCORE.BANK_ACCOUNT').updates, 1);
    assert.equal(last.tables.get('NEO_CRM.CUSTOMER_PROFILE').updates, 0);
    assert.equal(last.status, 'Failed'); assert.doesNotMatch(output.join('\n'), /private|password/);
  } finally { crypto.randomInt = random; }
});

test('remote options preserve parsing but enforce hosted resource limits', () => {
  const { help, ...options } = parseRealtimeArgs(['--duration', '5m', '--interval', '15s', '--events-per-cycle', '2']);
  assert.deepEqual(validateHostedRealtimeOptions(options), { durationMs: 300000, intervalMs: 15000, eventsPerCycle: 2 });
  assert.equal(parseRealtimeArgs(['--duration', 'unlimited']).durationMs, Infinity);
  for (const change of [{ durationMs: Infinity }, { durationMs: 3600001 }, { intervalMs: 0 }, { eventsPerCycle: 11 }, { schema: 'OTHER' }]) assert.throws(() => validateHostedRealtimeOptions({ ...options, ...change }));
});

const job = (state, events = [], extra = {}) => ({ jobId: 'job-1', state, cursor: events.at(-1)?.seq || 0, events, cancellationRequested: false, ...extra });
test('five-minute remote command submits parsed duration and interval to the hosted runner', async () => {
  const { help, ...options } = parseRealtimeArgs(['--duration', '5m', '--interval', '15s']);
  const calls = [];
  assert.equal(await runRemoteRealtime({ options, log: () => {}, client: { execute: async (operation, input) => {
    calls.push({ operation, input });
    return job(operation === 'realtimeStart' ? 'Queued' : 'Completed');
  } } }), 0);
  assert.deepEqual(calls[0].input.options, { durationMs: 300000, intervalMs: 15000, eventsPerCycle: 1 });
  assert.ok(calls[0].input.idempotencyKey);
  assert.equal(calls[1].operation, 'realtimeStatus');
});

test('cancellation respects server polling limit and retrieves unseen final output', async () => {
  const signals = new EventEmitter(); const output = []; let stoppedAt, polls = 0, stops = 0;
  const result = await runRemoteRealtime({ options: { durationMs: 1000 }, signals, pollMs: 0, log: line => output.push(line), client: {
    execute: async (operation, input) => {
      if (operation === 'realtimeStart') return job('Queued');
      if (operation === 'realtimeStop') {
        stops++; stoppedAt = Date.now(); signals.emit('SIGINT');
        return job('Stopping', [], { cursor: 2, pollIntervalMs: 1000, cancellationRequested: true });
      }
      if (++polls === 1) {
        signals.emit('SIGINT');
        return job('Running', [{ seq: 1, text: 'first event' }]);
      }
      assert.ok(Date.now() - stoppedAt >= 950, 'stop must not trigger a rate-limited status poll');
      assert.equal(input.cursor, 1, 'stop acknowledgement must not skip unseen output');
      return job('Completed', [{ seq: 2, text: 'final event' }], { cancellationRequested: true });
    }
  } });
  assert.equal(result, 130); assert.equal(stops, 1);
  assert.ok(output.includes('final event'));
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('remote polling respects the server partner polling interval', async () => {
  let polls = 0, previous;
  const result = await runRemoteRealtime({ options: { durationMs: 1000 }, pollMs: 0, log: () => {}, client: {
    execute: async operation => {
      if (operation === 'realtimeStart') return job('Queued');
      if (++polls === 1) { previous = Date.now(); return job('Running', [], { pollIntervalMs: 1000 }); }
      assert.ok(Date.now() - previous >= 950, 'client polled before the assigned interval');
      return job('Completed');
    }
  } });
  assert.equal(result, 0);
});
test('polling prints ordered output once and exits according to terminal state', async () => {
  const output = []; let count = 0;
  const result = await runRemoteRealtime({ options: { durationMs: 1000 }, pollMs: 0, log: line => output.push(line), client: {
    execute: async operation => operation === 'realtimeStart' ? job('Queued') :
      job(++count > 1 ? 'Completed' : 'Running', [{ seq: 1, text: 'event one' }, ...(count > 1 ? [{ seq: 2, text: 'summary' }] : [])])
  } });
  assert.equal(result, 0); assert.equal(output.filter(text => text === 'event one').length, 1);
  for (const state of ['Failed', 'Completed with errors']) {
    assert.equal(await runRemoteRealtime({ options: { durationMs: 1000 }, log: () => {}, client: { execute: async operation => job(operation === 'realtimeStart' ? 'Queued' : state) } }), 1);
  }
});

test('Ctrl+C during start stops only the returned job; repeated signals send one stop', async () => {
  const signals = new EventEmitter(); const calls = []; let stopped = false;
  const result = await runRemoteRealtime({ options: { durationMs: 1000 }, signals, pollMs: 0, log: () => {}, client: {
    execute: async (operation, input) => {
      calls.push({ operation, input });
      if (operation === 'realtimeStart') { signals.emit('SIGINT'); signals.emit('SIGINT'); return job('Queued'); }
      if (operation === 'realtimeStop') { stopped = true; assert.equal(input.jobId, 'job-1'); return job('Stopping'); }
      return job(stopped ? 'Completed' : 'Running', [], { cancellationRequested: stopped });
    }
  } });
  assert.equal(result, 130); assert.equal(calls.filter(call => call.operation === 'realtimeStop').length, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('failed stop reports job ID and does not claim rollback', async () => {
  const signals = new EventEmitter();
  await assert.rejects(runRemoteRealtime({ options: { durationMs: 1000 }, signals, log: () => {}, client: { execute: async operation => {
    if (operation === 'realtimeStart') { signals.emit('SIGINT'); return job('Queued'); }
    throw Error('network unavailable');
  } } }), /job job-1 may still be running/);
});

test('client maps authenticated start/status/stop without schema or credential fields', async () => {
  const calls = [];
  const client = createRemoteClient({ env: { DEMO_API_URL: 'https://control.test', DEMO_API_TOKEN: 'test-token' }, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    const result = url.pathname.endsWith('/start') ? { jobId: 'job-1', state: 'Queued' } : job('Completed');
    return { ok: true, status: options.method === 'POST' && url.pathname.endsWith('/start') ? 202 : 200, json: async () => ({ version: 1, result, exitCode: 0 }) };
  } });
  await client.execute('realtimeStart', { options: { durationMs: 1000 }, idempotencyKey: 'key-1' });
  await client.execute('realtimeStatus', { jobId: 'job-1', cursor: 2 });
  await client.execute('realtimeStop', { jobId: 'job-1' });
  assert.equal(calls[0].headers['idempotency-key'], 'key-1');
  assert.deepEqual(JSON.parse(calls[0].body), { durationMs: 1000, intervalMs: 15000, eventsPerCycle: 1 });
  assert.equal(calls[1].url.search, '?jobId=job-1&cursor=2');
  assert.deepEqual(JSON.parse(calls[2].body), { jobId: 'job-1' });
  assert.ok(calls.every(call => call.headers.authorization === 'Bearer test-token'));
});

test('actual remote realtime CLI handles argument routing, output and exit without local drivers', () => {
  const script = `
    const Module = require('node:module'); const load = Module._load;
    Module._load = function(name) {
      if (name === 'dotenv') return { config() {} };
      if (['./config', './db', './realtime', 'odbc', 'oracledb'].includes(name)) throw Error('FORBIDDEN DRIVER');
      return load.apply(this, arguments);
    };
    globalThis.fetch = async (url, options) => {
      const start = url.pathname.endsWith('/start');
      if (start && JSON.parse(options.body).eventsPerCycle !== 2) throw Error('wrong events');
      const result = start ? { jobId: 'job-1', state: 'Queued' } : { jobId: 'job-1', state: 'Completed', cursor: 1,
        events: [{ seq: 1, text: 'BANKSTREAM FEEDER - EXECUTION SUMMARY' }], cancellationRequested: false };
      return { ok: true, status: start ? 202 : 200, json: async () => ({ version: 1, result, exitCode: 0 }) };
    };
    process.argv = [process.execPath, 'demo.js', 'realtime', '--duration', '1s', '--interval', '1s', '--events-per-cycle', '2'];
    require(${JSON.stringify(path.resolve(__dirname, '../src/demo.js'))});
  `;
  const env = { ...process.env }; for (const key of Object.keys(env)) if (/^(FEEDER_|DEMO_|DB2I_|ORACLE_)/.test(key)) delete env[key];
  Object.assign(env, { FEEDER_MODE: 'remote', DEMO_API_URL: 'https://control.test', DEMO_API_TOKEN: 'test-token' });
  const child = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /EXECUTION SUMMARY/);
});
