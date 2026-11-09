'use strict';
const https = require('node:https');
const tls = require('node:tls');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { Readable } = require('node:stream');

function createHttpsFetch() {
  let certificate;
  try {
    certificate = readFileSync(path.join(__dirname, '../public-key-certificate/bankstream-vip-2year.crt'), 'utf8');
    if (/PRIVATE KEY/.test(certificate)) throw new Error('Private key');
    new X509Certificate(certificate);
  } catch {
    throw new Error('Cannot load bundled HTTPS certificate public-key-certificate/bankstream-vip-2year.crt; restore this file from the Feeder release.');
  }
  const ca = [...(tls.getCACertificates ? tls.getCACertificates('default') : tls.rootCertificates), certificate];
  // Trust is scoped to remote requests, never process-wide.
  return (url, { method, headers, body, signal }) => new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers, signal, ca, rejectUnauthorized: true,
      checkServerIdentity: tls.checkServerIdentity, agent: false }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        reject(new Error('Redirects are not allowed'));
        return;
      }
      try {
        const body = [204, 205].includes(response.statusCode) ? null : Readable.toWeb(response);
        if (body === null) response.resume();
        resolve(new Response(body, { status: response.statusCode, headers: response.headers }));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.on('error', reject);
    request.end(body);
  });
}

function tlsErrorMessage(error) {
  const code = error?.code || error?.cause?.code;
  const reasons = {
    CERT_HAS_EXPIRED: 'the server certificate has expired',
    CERT_NOT_YET_VALID: 'the server certificate is not yet valid',
    ERR_TLS_CERT_ALTNAME_INVALID: 'the server certificate SAN does not match the configured IP address or hostname',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'the server certificate is not trusted by the bundled certificate',
    SELF_SIGNED_CERT_IN_CHAIN: 'the server certificate chain is not trusted',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the server certificate chain is incomplete or untrusted',
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'the server certificate issuer is not trusted'
  };
  if (!reasons[code] && !/^(ERR_TLS_CERT_|CERT_|UNABLE_TO_.*CERT)/.test(code || '')) return null;
  return `Demo Control Service HTTPS verification failed: ${reasons[code] || 'the server certificate is invalid'}. Check DEMO_API_URL and the system clock; ask the operator to serve a valid certificate matching the URL and bundled trust chain.`;
}

module.exports = { createHttpsFetch, tlsErrorMessage };
