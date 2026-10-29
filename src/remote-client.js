'use strict';

const { getRemoteConfig } = require('./execution-mode');
const { moneyToMinorUnits, formatMinorUnits, databaseMoneyToMinorUnits } = require('./demo-amount');
const { validateVerificationOptions } = require('./verification');
const { readJson } = require('./bounded-json');
const { validateHostedRealtimeOptions } = require('./cli');
const ENDPOINTS = Object.freeze({
  status: { method: 'GET', path: '/api/demo/status' },
  transactionPreview: { method: 'GET', path: '/api/demo/transaction/preview' },
  transaction: { method: 'POST', path: '/api/demo/transaction' },
  dryRun: { method: 'POST', path: '/api/demo/dry-run' },
  verify: { method: 'POST', path: '/api/demo/verify' },
  kycPreview: { method: 'GET', path: '/api/demo/kyc/preview' },
  kyc: { method: 'POST', path: '/api/demo/kyc' },
  kycReset: { method: 'POST', path: '/api/demo/kyc/reset' },
  realtimeStart: { method: 'POST', path: '/api/demo/realtime/start' },
  realtimeStatus: { method: 'GET', path: '/api/demo/realtime/status' },
  realtimeStop: { method: 'POST', path: '/api/demo/realtime/stop' }
});

const reference = value => typeof value === 'string' && /^[A-Za-z0-9._~-]{1,256}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0;
function validResult(operation, data) {
  if (operation.startsWith('realtime')) return reference(data?.jobId) &&
    ['Queued', 'Running', 'Stopping', 'Completed', 'Completed with errors', 'Failed'].includes(data.state) &&
    (operation === 'realtimeStart' || (Number.isSafeInteger(data.cursor) && data.cursor >= 0 && Array.isArray(data.events) && data.events.length <= 256 &&
      data.events.every(event => Number.isSafeInteger(event.seq) && event.seq > 0 && typeof event.text === 'string' && event.text.length <= 2048)));
  const kyc = value => value && text(value.status) && (value.riskRating === null || text(value.riskRating));
  if (operation === 'kycPreview') return reference(data?.previewId) && text(data?.kyc?.customerId) && text(data?.kyc?.kycRecordId) && kyc(data.kyc);
  if (operation === 'kyc') return typeof data?.changed === 'boolean' && kyc(data.previous) && kyc(data.current);
  if (operation === 'kycReset') return typeof data?.changed === 'boolean' && typeof data.passed === 'boolean' && kyc(data.final);
  if (operation === 'verify') return typeof data?.passed === 'boolean' && ['transaction', 'kyc', 'api'].some(key => data[key]) &&
    ['transaction', 'kyc', 'api'].every(key => !data[key] || typeof data[key].passed === 'boolean');
  if (operation === 'dryRun') return typeof data?.passed === 'boolean' && Array.isArray(data.output) && data.output.length <= 8 &&
    data.output.every(line => ['stdout', 'stderr'].includes(line.stream) && typeof line.text === 'string' && line.text.length < 1024);
  if (operation === 'status') return validStatus(data);
  if (operation === 'transactionPreview') {
    const account = data?.account;
    if (!reference(data?.previewId) || !account || !['customerId', 'customerName', 'accountId', 'currency', 'accountStatus'].every(key => text(account[key]))) return false;
    try {
      databaseMoneyToMinorUnits(account.balance, 'Balance');
      databaseMoneyToMinorUnits(account.availableBalance, 'Available balance');
      return true;
    } catch { return false; }
  }
  return data && ['transactionId', 'amount', 'currency', 'previousBalance', 'newBalance',
    'previousAvailableBalance', 'newAvailableBalance', 'transactionTimestamp', 'completionTimestamp'].every(key => text(data[key]));
}

function validStatus(data) {
  return data && typeof data === 'object' && data.customer && typeof data.customer === 'object' &&
    Array.isArray(data.transactions) && data.transactions.every(row => row && typeof row === 'object') &&
    Array.isArray(data.kyc) && data.kyc.length >= 4;
}

function createRemoteClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = getRemoteConfig(env);
  if (typeof fetchImpl !== 'function') throw new Error('Remote mode requires Node.js 18 or newer');

  async function execute(operation, input = {}) {
    if (!Object.hasOwn(ENDPOINTS, operation)) throw new Error('This command is not yet supported in remote mode');
    const endpoint = ENDPOINTS[operation];
    let body;
    const headers = { authorization: `Bearer ${config.token}`, accept: 'application/json' };
    const mutation = ['transaction', 'kyc', 'kycReset'].includes(operation);
    if (mutation) {
      if (!reference(input.previewId) || !reference(input.idempotencyKey) || input.confirmed !== true) {
        throw new Error('Mutation requires a preview reference, confirmation and idempotency key');
      }
      body = JSON.stringify({ ...(operation === 'transaction' ? { amount: formatMinorUnits(moneyToMinorUnits(input.amount, 'Withdrawal amount')) } : {}),
        previewId: input.previewId, confirmed: true });
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = input.idempotencyKey;
    }
    if (operation === 'dryRun') { body = '{}'; headers['content-type'] = 'application/json'; }
    if (operation === 'verify') {
      body = JSON.stringify(validateVerificationOptions(input));
      headers['content-type'] = 'application/json';
    }
    const url = new URL(endpoint.path, config.baseUrl);
    if (operation === 'realtimeStart') {
      if (!reference(input.idempotencyKey)) throw new Error('Realtime start requires an idempotency key');
      body = JSON.stringify(validateHostedRealtimeOptions(input.options));
      headers['content-type'] = 'application/json'; headers['idempotency-key'] = input.idempotencyKey;
    }
    if (operation === 'realtimeStatus' || operation === 'realtimeStop') {
      if (!reference(input.jobId)) throw new Error('Invalid realtime job ID');
      if (operation === 'realtimeStatus') {
        const cursor = input.cursor ?? 0;
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid realtime output cursor');
        url.searchParams.set('jobId', input.jobId); url.searchParams.set('cursor', String(cursor));
      } else { body = JSON.stringify({ jobId: input.jobId }); headers['content-type'] = 'application/json'; }
    }
    const controller = new AbortController();
    let timer;
    // Race the complete request, including response parsing, against a deadline.
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Remote request timed out'));
      }, operation === 'verify' && env.DEMO_API_TIMEOUT_MS === undefined ? 150000 : config.timeoutMs);
    });
    const request = async () => {
      let response;
      try {
        response = await fetchImpl(url, {
          method: endpoint.method,
          headers, ...(body === undefined ? {} : { body }),
          redirect: 'error', signal: controller.signal
        });
      } catch {
        throw new Error(controller.signal.aborted ? 'Remote request timed out' : 'Unable to reach Demo Control Service');
      }
      if (response.status === 401 || response.status === 403) throw new Error('Demo Control Service authentication failed; check your API token');
      if (!response.ok) throw new Error(`Demo Control Service returned HTTP ${response.status}`);
      let payload;
      try { payload = await readJson(response); }
      catch { throw new Error('Demo Control Service returned an invalid response'); }
      const exitCode = payload?.result?.passed === false ? 1 : 0;
      if (payload?.version !== 1 || payload.exitCode !== exitCode || !validResult(operation, payload.result)) {
        const label = operation.startsWith('realtime') ? 'realtime' : operation === 'status' ? 'status' : operation.startsWith('transaction') ? 'transaction' : operation === 'verify' ? 'verification' : 'KYC';
        throw new Error(`Demo Control Service returned an invalid ${label} response`);
      }
      return payload.result;
    };
    try { return await Promise.race([request(), deadline]); }
    catch (error) {
      if (operation === 'realtimeStart') throw new Error(`${error.message}. A job may have started; do not start another. Retain idempotency key ${input.idempotencyKey} for reconciliation.`);
      if (mutation) {
        throw new Error(`${error.message}. ${operation === 'transaction' ? 'Withdrawal' : 'KYC mutation'} outcome may be unknown; do not submit a new mutation. Retain idempotency key ${input.idempotencyKey} for reconciliation.`);
      }
      throw error;
    }
    finally { clearTimeout(timer); }
  }
  return { execute };
}

module.exports = { createRemoteClient };
