'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('copied example selects remote mode with only URL/token and no local runtime requirements', t => {
  const fs = require('node:fs');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'feeder-example-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.copyFileSync(path.resolve(__dirname, '../.env.example'), path.join(directory, '.env'));
  const example = require('dotenv').parse(fs.readFileSync(path.join(directory, '.env')));
  assert.deepEqual(Object.keys(example).sort(), ['DEMO_API_TOKEN', 'DEMO_API_URL', 'FEEDER_MODE']);
  assert.equal(require('../src/execution-mode').getExecutionMode(example), 'remote');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(FEEDER_|DEMO_|DB2I_|ORACLE_|TAPDATA_)/.test(key)) delete env[key];
  const entry = path.resolve(__dirname, '../scripts/doctor.js');
  const script = `
    const Module = require('node:module'); const load = Module._load;
    Module._load = function(name) {
      if (['../src/config', '../src/runtime-check', 'odbc', 'oracledb'].includes(name)) throw Error('Unexpected local runtime import');
      return load.apply(this, arguments);
    };
    require(${JSON.stringify(entry)});
  `;
  const child = spawnSync(process.execPath, ['-e', script], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /mode=remote/);
  assert.match(child.stdout, /Remote configuration valid/);
});

test('remote dry-run preserves output and exit status without importing database code', () => {
  for (const passed of [true, false]) {
    const script = `
      const Module = require('node:module'); const load = Module._load;
      Module._load = function(name) {
        if (name === 'dotenv') return { config() {} };
        if (['./db', './config', 'odbc', 'oracledb'].includes(name)) throw Error('FORBIDDEN SOURCE IMPORT');
        return load.apply(this, arguments);
      };
      globalThis.fetch = async (url, options) => {
        if (url.pathname !== '/api/demo/dry-run' || options.method !== 'POST' || options.body !== '{}') throw Error('wrong request');
        return { ok: true, status: 200, json: async () => ({ version: 1, exitCode: ${passed ? 0 : 1}, result: {
          passed: ${passed}, output: [{ stream: 'stdout', text: 'connectivity result' }]
        } }) };
      };
      process.argv = [process.execPath, 'demo.js', 'dry-run']; require('./src/demo');
    `;
    const child = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: {
      ...process.env, FEEDER_MODE: 'remote', DEMO_API_URL: 'https://control.test', DEMO_API_TOKEN: 'fixture-token'
    } });
    assert.equal(child.status, passed ? 0 : 1, child.stderr);
    assert.match(child.stdout, /connectivity result/);
    assert.doesNotMatch(child.stderr, /FORBIDDEN/);
  }
});

test('partner script surface has six demo operations plus dry-run and unknown commands fail before source imports', () => {
  const scripts = require('../package.json').scripts;
  assert.deepEqual(Object.keys(scripts).filter(name => name.startsWith('demo:') || ['dry-run', 'realtime'].includes(name)).sort(),
    ['demo:kyc', 'demo:kyc:reset', 'demo:status', 'demo:transaction', 'demo:verify', 'dry-run', 'realtime']);
  for (const mode of ['local', 'remote']) {
    const script = `
      const Module = require('node:module'); const load = Module._load;
      Module._load = function(name) {
        if (name === 'dotenv') return { config() {} };
        if (['./db', './config', 'odbc', 'oracledb'].includes(name)) throw Error('FORBIDDEN SOURCE IMPORT');
        return load.apply(this, arguments);
      };
      process.argv = [process.execPath, 'demo.js', 'unknown-command'];
      require('./src/demo');
    `;
    const child = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, FEEDER_MODE: mode }, encoding: 'utf8' });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /Usage: npm run realtime/);
    assert.doesNotMatch(child.stderr, /FORBIDDEN/);
  }
});
test('database imports are lazy and missing optional packages give credential-free actionable errors', () => {
  const script = `
    const Module = require('node:module'); const load = Module._load; let attempts = 0;
    Module._load = function(name) {
      if (['oracledb','odbc'].includes(name)) { attempts++; throw Error('native runtime missing'); }
      return load.apply(this, arguments);
    };
    const db = require('./src/db'); if (attempts) throw Error('driver initialized on import');
    (async () => {
      for (const [name, connect] of [['Oracle',db.connectOracle],['ODBC',db.connectDb2]]) {
        try { await connect({db2:{dsn:'fixture',user:'fixture',password:'private'},oracle:{user:'fixture',password:'private'}}); throw Error('expected failure'); }
        catch(error) { if (!error.message.includes(name+' runtime unavailable') || error.message.includes('private')) throw error; }
      }
    })().catch(error=>{ console.error(error.message);process.exitCode=1; });
  `;
  const child = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
test('remote doctor does not initialize drivers or invoke Java', () => {
  const script = `
    const Module = require('node:module'); const load = Module._load;
    Module._load = function(name) {
      if (name==='dotenv') return {config(){}};
      if (['oracledb','odbc','node:child_process','../src/config'].includes(name)) throw Error('Unexpected runtime requirement');
      return load.apply(this, arguments);
    };
    require('./scripts/doctor');
  `;
  const env = { ...process.env, FEEDER_MODE: 'remote', DEMO_API_URL: 'https://example.invalid', DEMO_API_TOKEN: 'fixture-token' };
  const child = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /No Java, database driver/);
});
