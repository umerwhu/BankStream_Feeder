const { config, validate: validateConfig } = require('./config');
const { connect, connectDb2, connectOracle } = require('./db');
const { realtime } = require('./realtime');
const { dryRun } = require('./dry-run');
const { parseRealtimeArgs, helpText } = require('./cli');

async function main() {
  const mode=process.argv[2]||'realtime';
  const realtimeOptions = mode === 'realtime' ? parseRealtimeArgs(process.argv.slice(3)) : null;
  if (realtimeOptions?.help) { console.log(helpText); return; }
  validateConfig(mode);
  if (mode === 'dry-run') {
    await dryRun({ connectOracle: () => connectOracle(config), connectDb2: () => connectDb2(config) });
    return;
  }
  const {db2,oracle}=await connect(config);
  global.stopping=false;
  const stop=()=>{global.stopping=true;};
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    if(mode==='realtime') await realtime(db2,oracle,realtimeOptions);
  } finally { try{await db2.close();}finally{await oracle.close();} }
}
main().catch(e=>{ console.error(`BankStream failed: ${e.message}`); process.exitCode=1; });
