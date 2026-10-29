'use strict';

function getExecutionMode(env = process.env) {
  const mode = env.FEEDER_MODE === undefined ? 'local' : env.FEEDER_MODE.trim();
  if (!['local', 'remote'].includes(mode)) throw new Error('FEEDER_MODE must be local or remote');
  return mode;
}

function getRemoteConfig(env = process.env) {
  let url;
  try { url = new URL(env.DEMO_API_URL); }
  catch { throw new Error('DEMO_API_URL must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('DEMO_API_URL must use HTTPS without credentials, query parameters, or fragments');
  }
  const token = env.DEMO_API_TOKEN?.trim();
  if (!token || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) throw new Error('DEMO_API_TOKEN must be a valid bearer token');
  const timeoutMs = Number(env.DEMO_API_TIMEOUT_MS ?? 30000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new Error('DEMO_API_TIMEOUT_MS must be an integer between 1 and 300000');
  }
  return { baseUrl: url.href, token, timeoutMs };
}

module.exports = { getExecutionMode, getRemoteConfig };
