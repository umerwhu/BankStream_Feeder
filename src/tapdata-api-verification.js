'use strict';

const DEFAULTS = Object.freeze({ pageSize: 200, scanLimit: 1000, requestTimeoutMs: 15000, retryIntervalMs: 2000, retryTimeoutMs: 30000 });

function rowsFrom(payload, label) {
  if (!payload || !Array.isArray(payload.data)) throw new Error(`${label} API response must contain a data array`);
  return payload.data;
}

function decimalUnits(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] || '';
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  let digits;
  try { digits = BigInt(`${match[2]}${fraction}`); } catch { return null; }
  const power = 4 + exponent - fraction.length;
  if (power >= 0) return sign * digits * (10n ** BigInt(power));
  const divisor = 10n ** BigInt(-power);
  if (digits % divisor !== 0n) return null;
  return sign * (digits / divisor);
}

function text(value) { return value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim(); }
function pick(object, keys) {
  for (const key of keys) if (object && Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  return undefined;
}
function equalText(a, b) { const left = text(a); const right = text(b); return left !== null && right !== null && left.toUpperCase() === right.toUpperCase(); }

function accountFromCustomer(customers, source) {
  const customer = customers.find(row => equalText(pick(row, ['CUSTOMER_ID', 'customerId', 'customer_id']), source.customerId));
  if (!customer) return null;
  const relationships = pick(customer, ['ACCOUNT_CUSTOMER_RELATIONSHIP', 'accountCustomerRelationship', 'account_customer_relationship']);
  if (!Array.isArray(relationships)) return { customer, relationship: null, account: null };
  const relationship = relationships.find(row => equalText(pick(row, ['ACCOUNT_ID', 'accountId', 'account_id']), source.accountId));
  const account = relationship && pick(relationship, ['ACCOUNT', 'account']);
  return { customer, relationship: relationship || null, account: account && typeof account === 'object' ? account : null };
}

function compare(source, api) {
  const core = api.core;
  const acct = core?.account;
  const txns = acct && pick(acct, ['ACCOUNT_TRANSACTION', 'accountTransaction', 'account_transaction']);
  const txn = Array.isArray(txns) ? txns.find(row => equalText(pick(row, ['TRANSACTION_ID', 'transactionId', 'transaction_id']), source.transaction.id)) : null;
  const kyc = api.kyc.find(row => equalText(pick(row, ['CUSTOMER_ID', 'customerId', 'customer_id']), source.customerId)) || null;
  const fields = [
    ['Account', 'Customer ID', source.customerId, core && pick(core.customer, ['CUSTOMER_ID', 'customerId', 'customer_id']), 'text'],
    ['Account', 'Account ID', source.accountId, core?.relationship && pick(core.relationship, ['ACCOUNT_ID', 'accountId', 'account_id']), 'text'],
    ['Account', 'Balance', source.balance, acct && pick(acct, ['BALANCE', 'balance']), 'number'],
    ['Account', 'Available Balance', source.availableBalance, acct && pick(acct, ['AVAILABLE_BALANCE', 'availableBalance', 'available_balance']), 'number'],
    ['Account', 'Currency', source.currency, acct && pick(acct, ['CURRENCY', 'currency']), 'text'],
    ['Transaction', 'Transaction ID', source.transaction.id, txn && pick(txn, ['TRANSACTION_ID', 'transactionId', 'transaction_id']), 'text'],
    ['Transaction', 'Amount', source.transaction.amount, txn && pick(txn, ['TRANSACTION_AMOUNT', 'transactionAmount', 'transaction_amount']), 'number'],
    ['Transaction', 'Currency', source.transaction.currency, txn && pick(txn, ['CURRENCY', 'currency']), 'text'],
    ['Transaction', 'Type', source.transaction.type, txn && pick(txn, ['TRANSACTION_TYPE', 'transactionType', 'transaction_type']), 'text'],
    ['Transaction', 'Stage', source.transaction.stage, txn && pick(txn, ['TRANSACTION_STAGE', 'transactionStage', 'transaction_stage']), 'text'],
    ['Transaction', 'Status', source.transaction.status, txn && pick(txn, ['TRANSACTION_STATUS', 'transactionStatus', 'transaction_status']), 'text'],
    ['KYC', 'KYC Status', source.kyc.status, kyc && pick(kyc, ['KYC_STATUS', 'kycStatus', 'kyc_status']), 'text'],
    ['KYC', 'Risk Rating', source.kyc.riskRating, kyc && pick(kyc, ['RISK_RATING', 'riskRating', 'risk_rating']), 'text']
  ];
  return fields.map(([group, field, sourceValue, apiValue, kind]) => {
    const sourceMissing = sourceValue === null || sourceValue === undefined || String(sourceValue).trim() === '';
    const apiMissing = apiValue === null || apiValue === undefined || String(apiValue).trim() === '';
    const matches = !sourceMissing && !apiMissing && (kind === 'number'
      ? decimalUnits(sourceValue) !== null && decimalUnits(sourceValue) === decimalUnits(apiValue)
      : equalText(sourceValue, apiValue));
    return { group, field, source: sourceMissing ? 'MISSING SOURCE VALUE' : String(sourceValue), api: apiMissing ? 'MISSING API FIELD/RECORD' : String(apiValue), passed: matches };
  });
}

function endpoint(baseUrl, template, collection) {
  const path = template.replaceAll('{collection}', encodeURIComponent(collection));
  return new URL(path.startsWith('/') ? path : `/${path}`, `${baseUrl.replace(/\/+$/, '')}/`);
}

function makeFilter(env, limit, skip) {
  let base = {};
  if (env.TAPDATA_FIND_FILTER) {
    try { base = JSON.parse(env.TAPDATA_FIND_FILTER); }
    catch { throw new Error('TAPDATA_FIND_FILTER must contain valid JSON'); }
    if (!base || Array.isArray(base) || typeof base !== 'object') throw new Error('TAPDATA_FIND_FILTER must be a JSON object');
  }
  return { ...base, limit, skip };
}

function createTapDataVerifier({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch; use Node.js 18 or newer');

  async function bearerToken() {
    if (env.TAPDATA_ACCESS_TOKEN) return env.TAPDATA_ACCESS_TOKEN.trim();
    if (!env.TAPDATA_TOKEN_URL) return null;
    if (!env.TAPDATA_CLIENT_ID || !env.TAPDATA_CLIENT_SECRET) throw new Error('TapData OAuth requires TAPDATA_CLIENT_ID and TAPDATA_CLIENT_SECRET, or configure TAPDATA_ACCESS_TOKEN');
    const authUrl = new URL(env.TAPDATA_TOKEN_URL);
    const method = (env.TAPDATA_TOKEN_AUTH_METHOD || 'client_secret_post').toLowerCase();
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (method === 'client_secret_basic') headers.authorization = `Basic ${Buffer.from(`${env.TAPDATA_CLIENT_ID}:${env.TAPDATA_CLIENT_SECRET}`).toString('base64')}`;
    else if (method === 'client_secret_post') { body.set('client_id', env.TAPDATA_CLIENT_ID); body.set('client_secret', env.TAPDATA_CLIENT_SECRET); }
    else throw new Error('TAPDATA_TOKEN_AUTH_METHOD must be client_secret_post or client_secret_basic');
    const response = await fetchImpl(authUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(Number(env.TAPDATA_REQUEST_TIMEOUT_MS || DEFAULTS.requestTimeoutMs)) });
    if (!response.ok) throw new Error(`TapData authentication failed with HTTP ${response.status}`);
    let payload;
    try { payload = await response.json(); } catch { throw new Error('TapData authentication response was not valid JSON'); }
    if (!payload?.access_token) throw new Error('TapData authentication response did not include access_token');
    return payload.access_token;
  }

  async function fetchRows(collection, token) {
    const baseUrl = env.TAPDATA_API_BASE_URL || env.BANKING_API_BASE_URL;
    if (!baseUrl) throw new Error('Missing TAPDATA_API_BASE_URL (or BANKING_API_BASE_URL)');
    const template = env.TAPDATA_FIND_PATH_TEMPLATE || '/api/v1/{collection}';
    const pageSize = Math.max(1, Number(env.TAPDATA_PAGE_SIZE || DEFAULTS.pageSize));
    const scanLimit = Math.max(1, Number(env.TAPDATA_SCAN_LIMIT || DEFAULTS.scanLimit));
    if (!Number.isSafeInteger(pageSize) || !Number.isSafeInteger(scanLimit)) throw new Error('TAPDATA_PAGE_SIZE and TAPDATA_SCAN_LIMIT must be positive integers');
    const output = [];
    for (let skip = 0; skip < scanLimit; skip += pageSize) {
      const limit = Math.min(pageSize, scanLimit - skip);
      const url = endpoint(baseUrl, template, collection);
      const style = (env.TAPDATA_FIND_REQUEST_STYLE || 'query').toLowerCase();
      const filter = makeFilter(env, limit, skip);
      const headers = { accept: 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      let request;
      if ((env.TAPDATA_FIND_METHOD || 'GET').toUpperCase() === 'POST') {
        headers['content-type'] = 'application/json';
        request = { method: 'POST', headers, body: JSON.stringify(style === 'filter' ? { filter } : filter) };
      } else if (style === 'query') {
        url.searchParams.set('filter', JSON.stringify(filter));
        request = { method: 'GET', headers };
      } else {
        throw new Error('TAPDATA_FIND_REQUEST_STYLE must be query when TAPDATA_FIND_METHOD is GET');
      }
      request.signal = AbortSignal.timeout(Number(env.TAPDATA_REQUEST_TIMEOUT_MS || DEFAULTS.requestTimeoutMs));
      let response;
      try { response = await fetchImpl(url, request); }
      catch (error) { throw new Error(`TapData request failed: ${error.name === 'TimeoutError' || error.name === 'AbortError' ? 'request timed out' : error.message}`); }
      if (response.status === 401 || response.status === 403) throw new Error(`TapData API authorization failed with HTTP ${response.status}`);
      if (!response.ok) {
        const error = new Error(`TapData ${collection} API returned HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      let payload;
      try { payload = await response.json(); } catch { throw new Error(`TapData ${collection} API response was not valid JSON`); }
      const page = rowsFrom(payload, `TapData ${collection}`);
      output.push(...page);
      if (page.length < limit || output.length >= Number(payload.count ?? Infinity) || output.length >= scanLimit) break;
    }
    return output;
  }

  async function fetchSnapshot(source, token) {
    const map = env.TAPDATA_COLLECTION_MAP ? JSON.parse(env.TAPDATA_COLLECTION_MAP) : { CUSTOMER: 'MDM_CUSTOMER360' };
    if (!map || !map.CUSTOMER) throw new Error('TAPDATA_COLLECTION_MAP must map CUSTOMER to the published Customer 360 collection');
    const [customers, kyc] = await Promise.all([
      fetchRows(String(map.CUSTOMER), token), fetchRows(env.TAPDATA_KYC_COLLECTION || 'CUSTOMER_KYC', token)
    ]);
    return { core: accountFromCustomer(customers, source), kyc };
  }

  async function verify(source) {
    const interval = Number(env.DEMO_API_CDC_RETRY_INTERVAL_MS || DEFAULTS.retryIntervalMs);
    const timeout = Number(env.DEMO_API_CDC_TIMEOUT_MS || DEFAULTS.retryTimeoutMs);
    if (!Number.isSafeInteger(interval) || interval < 0 || !Number.isSafeInteger(timeout) || timeout < 0) throw new Error('DEMO_API_CDC_RETRY_INTERVAL_MS and DEMO_API_CDC_TIMEOUT_MS must be nonnegative integers');
    const started = now();
    const token = await bearerToken();
    let attempts = 0;
    let comparisons = [];
    let lastError;
    while (true) {
      attempts++;
      try {
        const api = await fetchSnapshot(source, token);
        comparisons = compare(source, api);
        if (comparisons.every(item => item.passed)) return { passed: true, comparisons, attempts, timedOut: false };
        lastError = undefined;
      } catch (error) {
        lastError = error;
        if (!error.retryable && !/^TapData request failed:/.test(error.message)) throw error;
      }
      const elapsed = now() - started;
      if (elapsed >= timeout) return { passed: false, comparisons, attempts, timedOut: true, error: lastError?.message };
      await sleep(Math.min(interval, timeout - elapsed));
    }
  }

  return { verify };
}

function printReport(result, source) {
  console.log('========== TAPDATA API VERIFICATION ==========');
  console.log(`\nCustomer ID: ${source.customerId}`);
  console.log(`Account ID : ${source.accountId}`);
  const groups = [...new Set(result.comparisons.map(row => row.group))];
  for (const group of groups) {
    console.log(`\n${group.toUpperCase()} COMPARISON`);
    console.log('FIELD                         SOURCE DB                       TAPDATA API                    RESULT');
    console.log('--------------------------------------------------------------------------------------------------');
    for (const row of result.comparisons.filter(item => item.group === group)) {
      console.log(`${row.field.padEnd(29)} ${row.source.padEnd(30)} ${row.api.padEnd(29)} ${row.passed ? 'PASS' : 'FAIL'}`);
    }
  }
  if (result.error) console.log(`\nAPI detail: ${result.error}`);
  if (result.timedOut) console.log(`CDC comparison timed out after ${result.attempts} attempt(s).`);
  console.log('\n---------------------------------------------------------');
  console.log(`Overall Result: ${result.passed ? 'PASS' : 'FAIL'}`);
}

module.exports = { createTapDataVerifier, compare, rowsFrom, decimalUnits, printReport, DEFAULTS };
