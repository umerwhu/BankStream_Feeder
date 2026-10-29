'use strict';
async function readJson(response, maxBytes = 1048576) {
  if (Number(response.headers?.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Response too large'); }
  if (!response.body?.getReader) {
    const value = await response.json();
    if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new Error('Response too large');
    return value;
  }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}
module.exports = { readJson };
