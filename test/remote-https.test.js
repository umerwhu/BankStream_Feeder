'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createRemoteClient } = require('../src/remote-client');
const modulePath = path.resolve(__dirname, '../src/remote-https.js');
const pem = fs.readFileSync(path.resolve(__dirname, '../public-key-certificate/bankstream-vip-2year.crt'), 'utf8');
const env = { DEMO_API_URL: 'https://113.98.206.139:8443', DEMO_API_TOKEN: 'tls-test-token' };

function loadTransport({ read = fs.readFileSync, failure, inspect = () => {} } = {}) {
  const module = { exports: {} };
  const mockHttps = { request(url, options, callback) {
    inspect(url, options);
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      if (failure) return request.emit('error', Object.assign(new Error('secret tls-test-token'), { code: failure }));
      const response = Readable.from([Buffer.from(JSON.stringify({ version: 1, exitCode: 0, result: { customer: {}, transactions: [], kyc: [1,2,3,4] } }))]);
      response.statusCode = 200; response.headers = { 'content-type': 'application/json' };
      callback(response);
    });
    return request;
  } };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), {
    module, __dirname: path.dirname(modulePath), Response,
    require: name => name === 'node:https' ? mockHttps : name === 'node:fs' ? { readFileSync: read } : require(name)
  });
  return module.exports;
}

test('bundled public CA is self-signed, currently valid, and matches configured IP SAN', () => {
  assert.doesNotMatch(pem, /PRIVATE KEY/);
  const certificate = new X509Certificate(pem);
  assert.equal(certificate.ca, true);
  assert.equal(certificate.verify(certificate.publicKey), true);
  assert.ok(Date.now() >= Date.parse(certificate.validFrom));
  assert.ok(Date.now() < Date.parse(certificate.validTo));
  assert.equal(certificate.checkIP('113.98.206.139'), '113.98.206.139');
  assert.equal(certificate.checkIP('127.0.0.1'), undefined);
  assert.equal(tls.checkServerIdentity('113.98.206.139', certificate.toLegacyObject()), undefined);
  assert.equal(tls.checkServerIdentity('wrong.example', certificate.toLegacyObject()).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
});

test('mock HTTPS connection succeeds with bundled trust, default CAs and strict verification', async () => {
  let calls = 0;
  const transport = loadTransport({ inspect(url, options) {
    calls++;
    assert.equal(url.hostname, '113.98.206.139');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.checkServerIdentity, tls.checkServerIdentity);
    assert.ok(options.ca.includes(pem));
    for (const ca of tls.getCACertificates('default')) assert.ok(options.ca.includes(ca));
    assert.doesNotThrow(() => tls.createSecureContext({ ca: options.ca }));
    assert.equal(options.headers.authorization, 'Bearer tls-test-token');
  } });
  const result = await createRemoteClient({ env, fetchImpl: transport.createHttpsFetch() }).execute('status');
  assert.deepEqual(result.customer, {});
  assert.equal(calls, 1);
});

for (const [code, reason] of [
  ['DEPTH_ZERO_SELF_SIGNED_CERT', /not trusted/],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /incomplete or untrusted/],
  ['CERT_HAS_EXPIRED', /expired/],
  ['ERR_TLS_CERT_ALTNAME_INVALID', /SAN does not match/]
]) {
  test(`mock TLS ${code} fails with actionable, token-free error`, async () => {
    const transport = loadTransport({ failure: code });
    await assert.rejects(createRemoteClient({ env, fetchImpl: transport.createHttpsFetch() }).execute('status'), error => {
      assert.match(error.message, reason);
      assert.match(error.message, /Check DEMO_API_URL/);
      assert.doesNotMatch(error.message, /secret|tls-test-token/);
      return true;
    });
  });
}

test('missing or malformed bundle fails clearly before any network request', () => {
  for (const read of [() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, () => 'invalid', () => 'PRIVATE KEY']) {
    assert.throws(() => loadTransport({ read }).createHttpsFetch(), /Cannot load bundled HTTPS certificate.*restore/);
  }
});

test('certificate path is independent of current working directory', () => {
  const child = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).createHttpsFetch();`], {
    cwd: require('node:os').tmpdir(), encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);
});

test('distribution includes bundled certificate directory', () => {
  assert.ok(require('../package.json').files.includes('public-key-certificate/'));
});
