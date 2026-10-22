async function runSchedule({ durationMs, intervalMs, eventsPerCycle, runCycle, summary, shouldStop = () => false, log = console.log,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const startedAt = now();
  const deadline = durationMs === Infinity ? Infinity : startedAt + durationMs;

  while (!shouldStop() && now() < deadline) {
    const cycleStartedAt = now();
    summary.cycles++;
    for (let index = 0; index < eventsPerCycle && !shouldStop() && now() < deadline; index++) {
      try {
        await runCycle();
      } catch (error) {
        if (!error.summaryFailureRecorded) {
          summary.recordFailure({ schema: 'FEEDER', table: 'WORKLOAD_CYCLE', operation: 'PROCESS', error });
          error.summaryFailureRecorded = true;
        }
        log(`Event failed: ${error.message}`);
      }
    }
    if (shouldStop() || now() >= deadline) break;
    const nextCycleAt = Math.min(Math.max(cycleStartedAt + intervalMs, now()), deadline);
    const elapsedMs = now() - startedAt;
    const values = [...summary.tables.values()];
    const inserts = values.reduce((total, row) => total + row.inserts, 0);
    const updates = values.reduce((total, row) => total + row.updates, 0);
    log(`Progress elapsed=${Math.floor(elapsedMs / 1000)}s inserts=${inserts} updates=${updates} errors=${summary.failures.length}; next cycle in ${Math.ceil((nextCycleAt - now()) / 1000)}s`);
    if (nextCycleAt > now()) await sleep(nextCycleAt - now());
  }

  const elapsedMs = now() - startedAt;
  summary.elapsedMs = elapsedMs;
  summary.status = shouldStop() ? 'Stopped by user' : summary.failures.length ? 'Completed with errors' : 'Completed';
  log(`Feeder stopped elapsed=${Math.floor(elapsedMs / 1000)}s cycles=${summary.cycles} errors=${summary.failures.length}`);
  return summary;
}

module.exports = { runSchedule };
