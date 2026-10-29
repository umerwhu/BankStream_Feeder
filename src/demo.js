require('dotenv').config();
const { getExecutionMode } = require('./execution-mode');
const { parseRealtimeArgs, helpText } = require('./cli');

async function main() {
  const mode = process.argv[2] || 'realtime';
  if (!['realtime', 'dry-run'].includes(mode)) throw new Error('Usage: npm run realtime -- [options]');
  if (mode === 'dry-run' && process.argv.length > 3) throw new Error('Usage: npm run dry-run');
  const realtimeOptions = mode === 'realtime' ? parseRealtimeArgs(process.argv.slice(3)) : null;
  if (realtimeOptions?.help) { console.log(helpText); return; }
  if (getExecutionMode() === 'remote') {
    if (mode === 'dry-run') {
      const result = await require('./remote-client').createRemoteClient().execute('dryRun');
      for (const line of result.output) (line.stream === 'stderr' ? console.error : console.log)(line.text);
      if (!result.passed) process.exitCode = 1;
      return;
    }
    const { help, ...options } = realtimeOptions;
    process.exitCode = await require('./remote-realtime').runRemoteRealtime({ client: require('./remote-client').createRemoteClient(), options });
    return;
  }
  const { config, validate: validateConfig } = require('./config');
  const { connect, connectDb2, connectOracle } = require('./db');
  const { createRealtimeService } = require('./realtime');
  validateConfig(mode);
  if (mode === 'dry-run') {
    await require('./dry-run').dryRun({ connectOracle: () => connectOracle(config), connectDb2: () => connectDb2(config) });
    return;
  }
  const {db2,oracle}=await connect(config);
  const controller = new AbortController();
  const stop=()=>controller.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    await createRealtimeService(config,{signal:controller.signal}).realtime(db2,oracle,realtimeOptions);
  } finally {
    process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop);
    try{await db2.close();}finally{await oracle.close();}
  }
}
main().catch(e=>{ console.error(`BankStream failed: ${e.message}`); process.exitCode=1; });
