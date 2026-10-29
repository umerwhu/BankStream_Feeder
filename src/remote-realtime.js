'use strict';
const { randomUUID } = require('node:crypto');
const { validateHostedRealtimeOptions } = require('./cli');
const { printExecutionSummary } = require('./execution-summary');
const TERMINAL = new Set(['Completed', 'Completed with errors', 'Failed']);
const pollingInterval = (status, minimum) => Math.max(minimum,
  Number.isSafeInteger(status.pollIntervalMs) && status.pollIntervalMs >= 1000 && status.pollIntervalMs <= 60000 ? status.pollIntervalMs : 0);

async function runRemoteRealtime({ client, options, signals = process, log = console.log, pollMs = 2000 }) {
  const settings = validateHostedRealtimeOptions(options);
  const idempotencyKey = randomUUID();
  let jobId, cursor = 0, stopping = false, stopSent = false, wake;
  const stop = () => { stopping = true; wake?.(); };
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  try {
    const started = await client.execute('realtimeStart', { options: settings, idempotencyKey });
    jobId = started.jobId;
    log(`Hosted realtime job: ${jobId}`);
    while (true) {
      if (stopping && !stopSent) {
        stopSent = true;
        try {
          const stopped = await client.execute('realtimeStop', { jobId });
          // Ctrl+C wakes the normal polling delay. Honor the server limit before
          // polling again, retaining the cursor so final output is not skipped.
          await new Promise(resolve => setTimeout(resolve, pollingInterval(stopped, pollMs)));
        }
        catch { throw new Error(`Stop request failed; job ${jobId} may still be running`); }
      }
      let status;
      try { status = await client.execute('realtimeStatus', { jobId, cursor }); }
      catch { throw new Error(`Unable to poll job ${jobId}; it may still be running`); }
      if (status.truncated) log('Some older realtime output expired from the server buffer.');
      for (const event of status.events) {
        if (event.seq > cursor) { log(event.text); cursor = event.seq; }
      }
      cursor = Math.max(cursor, status.cursor);
      if (TERMINAL.has(status.state)) {
        if (status.lastError && !status.events.some(event => event.text === status.lastError)) log(status.lastError);
        if (status.truncated && status.summary?.tables?.length && !status.events.some(event => event.text.includes('EXECUTION SUMMARY'))) {
          printExecutionSummary({ ...status.summary, status: status.state, intervalMs: status.intervalMs,
            errorCount: status.summary.errors, failures: [],
            tables: new Map(status.summary.tables.map(row => [`${row.schema}.${row.table}`, row])) }, log);
        }
        log(`Job ${jobId}: ${status.state}${status.cancellationRequested ? ' (cancelled at a safe boundary)' : ''}`);
        return status.state === 'Failed' || status.state === 'Completed with errors' ? 1 : status.cancellationRequested ? 130 : 0;
      }
      await new Promise(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, pollingInterval(status, pollMs));
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        if (stopping && !stopSent) wake();
      });
    }
  } finally {
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
  }
}
module.exports = { runRemoteRealtime };
