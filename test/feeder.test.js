const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {dryRun}=require('../src/dry-run');
const {parseDuration,parseInterval,parseRealtimeArgs}=require('../src/cli');
const {runSchedule}=require('../src/scheduler');
const {db2ConnectionString}=require('../src/db');
const {resolveTransaction,addTransaction,updateOracle,loadWorkloadRecords}=require('../src/realtime');
const {createExecutionSummary,printExecutionSummary}=require('../src/execution-summary');
const crypto=require('node:crypto');
const {config}=require('../src/config');
const root=path.join(__dirname,'..');

test('JT400 JDBC driver resolves to the project-local jar',()=>{
  const driverPath=path.join(root,'db2i_driver','jt400-21.0.6.jar');
  assert.equal(config.db2.jdbcJar,driverPath);
  assert.equal(fs.existsSync(config.db2.jdbcJar),true);
  assert.doesNotMatch(config.db2.jdbcJar,/DBeaver/i);
});

test('runtime code contains no bulk loader and no DDL',()=>{
  const src=path.join(root,'src');
  for(const file of fs.readdirSync(src).filter(f=>/\.(js|java)$/.test(f))) {
    const text=fs.readFileSync(path.join(src,file),'utf8');
    assert.doesNotMatch(text,/\b(CREATE|ALTER|DROP|TRUNCATE)\s+(DATABASE|SCHEMA|TABLE|INDEX|SEQUENCE)\b/i,file);
    assert.doesNotMatch(text,/\bDELETE\s+FROM\b|\bTRUNCATE\b|DROP\s+TABLE/i,file);
    assert.doesNotMatch(text,/function\s+seed\b|INSERT\s+INTO\s+BANKCORE\.(CUSTOMER|BANK_ACCOUNT|LOAN_ACCOUNT)\b/i,file);
  }
  const packageJson=require('../package.json');
  assert.deepEqual(Object.keys(packageJson.scripts).filter(s=>['seed','all','validate'].includes(s)),[]);
});

test('runtime chooses live customer/account IDs and profile mapping from the databases',()=>{
  const text=fs.readFileSync(path.join(root,'src/realtime.js'),'utf8');
  assert.match(text,/JOIN \$\{db2Table\('ACCOUNT_CUSTOMER_RELATIONSHIP'\)\} R ON R\.CUSTOMER_ID=C\.CUSTOMER_ID JOIN \$\{db2Table\('BANK_ACCOUNT'\)\} A ON A\.ACCOUNT_ID=R\.ACCOUNT_ID/);
  assert.match(text,/SELECT CUSTOMER_ID,CUSTOMER_PROFILE_ID FROM \$\{config\.oracle\.schema\}\.CUSTOMER_PROFILE/);
  assert.match(text,/profileByCustomer\.get\(String\(row\.CUSTOMER_ID\)\.trim\(\)\)/);
  assert.match(text,/accountId:String\(row\.ACCOUNT_ID\)\.trim\(\)/);
  assert.match(text,/String\(row\[1\]\)\.trim\(\)/);
});

test('workload reads the new account relationship and preserves string primary keys',async()=>{
  let db2Sql='';
  const records=await loadWorkloadRecords({query:async sql=>{db2Sql=sql;return [
    {CUSTOMER_ID:100001,ACCOUNT_ID:'AC1000011',CURRENCY:'USD'},
    {CUSTOMER_ID:100002,ACCOUNT_ID:'AC1000022',CURRENCY:'GBP'}
  ];}}, {execute:async()=>({rows:[[100001,'CP100001'],[100002,'CP100002']]})});
  assert.match(db2Sql,/ACCOUNT_CUSTOMER_RELATIONSHIP/);
  assert.deepEqual(records,[
    {customer:100001,accountId:'AC1000011',currency:'USD',customerProfileId:'CP100001'},
    {customer:100002,accountId:'AC1000022',currency:'GBP',customerProfileId:'CP100002'}
  ]);
});

test('database definitions and references use descriptive identifiers consistently',()=>{
  const files=[];
  for(const folder of ['ddl','bulk-data','src']) {
    for(const name of fs.readdirSync(path.join(root,folder))) {
      if(/\.(sql|js)$/.test(name)) files.push(path.join(root,folder,name));
    }
  }
  files.push(path.join(root,'README.md'));
  const legacyNames=[['CUS','MST'],['ACCT','MST'],['TXN','HIST'],['LOAN','MST'],['CUST','_ID'],['ACCT','_ID'],['TXN','_ID'],['TXN','_AMT'],['CUST','_NAME'],['CRM','_CUSTOMER_ID'],['CORE','_CUST_ID'],['UPDATED','_AT']].map(parts=>parts.join(''));
  const legacyPattern=new RegExp(`\\b(?:${legacyNames.map(name=>name.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&')).join('|')})\\b`,'i');
  for(const file of files) assert.doesNotMatch(fs.readFileSync(file,'utf8'),legacyPattern,path.relative(root,file));
});

test('Oracle KYC table, columns, foreign key, and references use the CUSTOMER_KYC names',()=>{
  const ddl=fs.readFileSync(path.join(root,'ddl/02_oracle_schema.sql'),'utf8');
  const bulk=fs.readFileSync(path.join(root,'bulk-data/02_oracle_sample_data.sql'),'utf8');
  const runtime=fs.readFileSync(path.join(root,'src/realtime.js'),'utf8');
  const readme=fs.readFileSync(path.join(root,'README.md'),'utf8');
  assert.match(ddl,/CREATE TABLE C##BANKCRM\.CUSTOMER_KYC\s*\([\s\S]*?KYC_RECORD_ID[\s\S]*?CUSTOMER_ID[\s\S]*?KYC_STATUS[\s\S]*?RISK_RATING[\s\S]*?LAST_REVIEW_DATE[\s\S]*?NEXT_REVIEW_DATE[\s\S]*?CUSTOMER_COUNTRY[\s\S]*?LAST_UPDATED_TIMESTAMP[\s\S]*?FOREIGN KEY \(CUSTOMER_ID\) REFERENCES C##BANKCRM\.CUSTOMER_PROFILE\(CUSTOMER_ID\)/);
  assert.match(bulk,/INSERT INTO C##BANKCRM\.CUSTOMER_KYC \(KYC_RECORD_ID, CUSTOMER_ID, KYC_STATUS, RISK_RATING, LAST_REVIEW_DATE, NEXT_REVIEW_DATE, CUSTOMER_COUNTRY\)/);
  assert.match(runtime,/UPDATE \$\{config\.oracle\.schema\}\.CUSTOMER_KYC SET KYC_STATUS=:status, RISK_RATING=:risk/);
  assert.match(readme,/CUSTOMER_KYC/);
  const oldNames=['CUSTOMER_KNOW'+'_YOUR_CUSTOMER','KNOW_YOUR_'+'CUSTOMER_RECORD_ID','KNOW_YOUR_'+'CUSTOMER_STATUS'];
  const checkedFiles=[path.join(root,'ddl/02_oracle_schema.sql'),path.join(root,'bulk-data/02_oracle_sample_data.sql'),path.join(root,'src/realtime.js'),path.join(root,'README.md')];
  for(const file of checkedFiles) {
    const contents=fs.readFileSync(file,'utf8');
    for(const oldName of oldNames) assert.equal(contents.includes(oldName),false,`${path.relative(root,file)} contains legacy name ${oldName}`);
  }
});

test('manual DDL and bulk SQL are separated from Node runtime',()=>{
  for(const file of ['ddl/01_db2i_schema.sql','ddl/02_oracle_schema.sql','bulk-data/01_db2i_sample_data.sql','bulk-data/02_oracle_sample_data.sql']) {
    assert.ok(fs.existsSync(path.join(root,file)),`${file} exists`);
    const text=fs.readFileSync(path.join(root,file),'utf8');
    assert.doesNotMatch(text,/\bDELETE\s+FROM\b|\bTRUNCATE\b|DROP\s+TABLE/i,file);
  }
  for(const file of ['bulk-data/01_db2i_sample_data.sql','bulk-data/02_oracle_sample_data.sql']) {
    const text=fs.readFileSync(path.join(root,file),'utf8');
    assert.doesNotMatch(text,/\b(CREATE|ALTER|DROP|TRUNCATE)\s+(DATABASE|SCHEMA|TABLE|INDEX|SEQUENCE)\b/i,file);
  }
});

test('provided seed customer mappings use the shared customer IDs across both sources',()=>{
  const db2=fs.readFileSync(path.join(root,'bulk-data/01_db2i_sample_data.sql'),'utf8');
  const oracle=fs.readFileSync(path.join(root,'bulk-data/02_oracle_sample_data.sql'),'utf8');
  const db2Ids=[...db2.matchAll(/INSERT INTO BANKCORE\.CUSTOMER \(CUSTOMER_ID,[^\n]*?VALUES \((\d+),/g)].map(m=>m[1]);
  const oracleIds=[...oracle.matchAll(/INSERT INTO C##BANKCRM\.CUSTOMER_PROFILE \([^\n]*?VALUES \('[^']+', (\d+),/g)].map(m=>m[1]);
  assert.ok(db2Ids.length>0,'Db2 seed contains customer records');
  assert.ok(oracleIds.length>0,'Oracle seed contains customer records');
  assert.deepEqual([...new Set(db2Ids)].sort(),[...new Set(oracleIds)].sort());
});

test('dry-run checks both databases with SELECT only',async()=>{
  const statements=[];
  await dryRun({
    connectOracle:async()=>({execute:async sql=>statements.push(sql),close:async()=>{}}),
    connectDb2:async()=>({query:async sql=>statements.push(sql),close:async()=>{}})
  });
  assert.deepEqual(statements,['SELECT 1 FROM DUAL','SELECT 1 FROM SYSIBM.SYSDUMMY1']);
  assert.ok(statements.every(sql=>/^SELECT\b/i.test(sql)));
});

test('Db2 ODBC connection supports either a configured DSN or IBM i host settings',()=>{
  const hostConnection=db2ConnectionString({db2:{host:'192.168.1.195',schema:'BANKCORE',driver:'IBM i Access ODBC Driver',user:'dbadmin',password:'secret'}});
  assert.match(hostConnection,/DRIVER=\{IBM i Access ODBC Driver\};SYSTEM=\{192\.168\.1\.195\};DBQ=\{BANKCORE\}/);
  assert.match(hostConnection,/UID=\{dbadmin\};PWD=\{secret\}/);
  const dsnConnection=db2ConnectionString({db2:{dsn:'BANKCORE_DSN',user:'demo',password:'secret'}});
  assert.match(dsnConnection,/DSN=\{BANKCORE_DSN\};UID=\{demo\};PWD=\{secret\}/);
});

test('runtime arguments parse supported durations and validate invalid limits',()=>{
  assert.equal(parseDuration('1h'),3_600_000);
  assert.equal(parseDuration('5m'),300_000);
  assert.equal(parseDuration('unlimited'),Infinity);
  assert.equal(parseInterval('15s'),15_000);
  assert.deepEqual(parseRealtimeArgs(['--duration','30m','--interval','30s','--events-per-cycle','10']),{
    durationMs:1_800_000,intervalMs:30_000,eventsPerCycle:10,help:false
  });
  for(const value of ['0m','2d','soon']) assert.throws(()=>parseDuration(value),/Invalid duration/);
  assert.throws(()=>parseRealtimeArgs(['--interval','0s']),/Invalid interval/);
  assert.throws(()=>parseRealtimeArgs(['--events-per-cycle','0']),/positive safe integer/);
  assert.throws(()=>parseRealtimeArgs(['--strange']),/Unknown option/);
});

test('scheduler enforces duration and waits between non-overlapping cycles',async()=>{
  let time=0, active=false, overlap=false, runs=0;
  const logs=[];
  const summary=createExecutionSummary({oracleSchema:'C##BANKCRM',intervalMs:100});
  const totals=await runSchedule({durationMs:250,intervalMs:100,eventsPerCycle:1,summary,now:()=>time,log:line=>logs.push(line),
    sleep:async ms=>{time+=ms;},runCycle:async()=>{if(active) overlap=true;active=true;runs++;active=false;summary.recordSuccess({schema:'BANKCORE',table:'ACCOUNT_TRANSACTION',operation:'INSERT',key:`event-${runs}`});summary.recordSuccess({schema:'BANKCORE',table:'BANK_ACCOUNT',operation:'UPDATE',key:`event-${runs}`});}});
  assert.equal(runs,3);
  assert.equal(overlap,false);
  assert.equal(time,250);
  assert.equal(totals.cycles,3);
  assert.equal(totals.tables.get('BANKCORE.ACCOUNT_TRANSACTION').inserts,3);
  assert.equal(totals.tables.get('BANKCORE.BANK_ACCOUNT').updates,3);
  assert.equal(totals.status,'Completed');
  assert.match(logs.at(-1),/Feeder stopped elapsed=0s cycles=3 errors=0/);
});

test('scheduler stops after the current in-flight event when shutdown is requested',async()=>{
  let stop=false,runs=0;
  const summary=createExecutionSummary({oracleSchema:'C##BANKCRM',intervalMs:100});
  const totals=await runSchedule({durationMs:Infinity,intervalMs:100,eventsPerCycle:5,summary,shouldStop:()=>stop,log:()=>{},
    runCycle:async()=>{runs++;summary.recordSuccess({schema:'C##BANKCRM',table:'CUSTOMER_PROFILE',operation:'UPDATE',key:'stop-event'});stop=true;},sleep:async()=>{}});
  assert.equal(runs,1);
  assert.equal(totals.status,'Stopped by user');
  assert.equal(totals.tables.get('C##BANKCRM.CUSTOMER_PROFILE').updates,1);
  const output=[];
  printExecutionSummary(totals,line=>output.push(line));
  assert.ok(output.some(line=>line.includes('Status:                Stopped by user')));
  assert.ok(output.some(line=>line.includes('C##BANKCRM.CUSTOMER_PROFILE')));
  assert.ok(output.some(line=>line.includes('BANKCORE.CUSTOMER') && line.includes('0')));
});

test('scheduler records event errors and continues with later events',async()=>{
  let time=0,attempt=0;
  const logs=[];
  const summary=createExecutionSummary({oracleSchema:'C##BANKCRM',intervalMs:100});
  const totals=await runSchedule({durationMs:100,intervalMs:100,eventsPerCycle:3,summary,now:()=>time,log:line=>logs.push(line),
    sleep:async ms=>{time+=ms;},runCycle:async()=>{attempt++;if(attempt===1)throw new Error('temporary failure');summary.recordSuccess({schema:'BANKCORE',table:'ACCOUNT_TRANSACTION',operation:'INSERT',key:`attempt-${attempt}`});}});
  assert.equal(totals.tables.get('BANKCORE.ACCOUNT_TRANSACTION').inserts,2);
  assert.equal(totals.failures.length,1);
  assert.equal(totals.status,'Completed with errors');
  assert.ok(logs.some(line=>line.includes('temporary failure')));
});

test('duration expiry prints every table with zero counts when no writes occur',async()=>{
  let time=0;
  const summary=createExecutionSummary({oracleSchema:'C##BANKCRM',intervalMs:100});
  await runSchedule({durationMs:100,intervalMs:100,eventsPerCycle:1,summary,now:()=>time,log:()=>{},sleep:async ms=>{time+=ms;},runCycle:async()=>{}});
  const output=[];
  printExecutionSummary(summary,line=>output.push(line));
  assert.equal(summary.status,'Completed');
  assert.equal(summary.cycles,1);
  assert.equal([...summary.tables.values()].reduce((total,row)=>total+row.inserts+row.updates,0),0);
  assert.ok(output.some(line=>line.includes('BANKCORE.LOAN_ACCOUNT')&&line.trim().endsWith('0')));
  assert.ok(output.some(line=>line.includes('C##BANKCRM.CUSTOMER_OFFERS')&&line.trim().endsWith('0')));
  assert.ok(output.some(line=>line.includes('Total Operations:      0')));
});

test('insert summaries count only committed transactions and deduplicate an idempotent retry',async()=>{
  const summary=createExecutionSummary({oracleSchema:'C##BANKCRM',intervalMs:1000});
  const state={committed:false,pending:false,sql:'',binds:null};
  const db={
    beginTransaction:async()=>{state.pending=false;},
    query:async(sql,binds)=>{
      if(sql.startsWith('INSERT')) {
        if(state.committed) throw new Error('SQL0803 duplicate key');
        state.sql=sql;state.binds=binds;
        state.pending=true;
        return {count:1};
      }
      if(sql.startsWith('SELECT TRANSACTION_ID')) return state.committed?[{TRANSACTION_ID:'RT-stable-event'}]:[];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    commit:async()=>{state.committed=state.pending;state.pending=false;},
    rollback:async()=>{state.pending=false;}
  };
  const event={transactionId:'RT-stable-event',eventKey:'RT-stable-event',accountId:'AC1000011',type:'DEPOSIT',amount:10,currency:'USD',channel:'MOBILE'};
  await addTransaction(db,event,summary);
  await addTransaction(db,event,summary);
  assert.match(state.sql,/TRANSACTION_STAGE,TRANSACTION_STATUS,TRANSACTION_AMOUNT/);
  assert.deepEqual(state.binds.slice(0,3),['RT-stable-event','AC1000011','DEPOSIT']);
  assert.equal(event.transactionId.length<=40,true);
  assert.equal(summary.tables.get('BANKCORE.ACCOUNT_TRANSACTION').inserts,1);
  assert.equal(summary.failures.length,0);
});

test('failed transaction inserts are reported and not counted as successful',async()=>{
  const summary=createExecutionSummary({oracleSchema:'C##BANKCRM',intervalMs:1000});
  const db={beginTransaction:async()=>{},query:async()=>{throw new Error('permission denied');},commit:async()=>{},rollback:async()=>{}};
  await assert.rejects(addTransaction(db,{transactionId:'RT-failed',eventKey:'RT-failed',accountId:'AC1000011',type:'DEPOSIT',amount:10,currency:'USD'},summary),/permission denied/);
  const table=summary.tables.get('BANKCORE.ACCOUNT_TRANSACTION');
  assert.equal(table.inserts,0);
  assert.equal(summary.failures.length,1);
  assert.deepEqual({table:summary.failures[0].table,operation:summary.failures[0].operation,message:summary.failures[0].message},{table:'ACCOUNT_TRANSACTION',operation:'INSERT',message:'permission denied'});
});

test('an insert whose transaction does not commit is not counted as successful',async()=>{
  const summary=createExecutionSummary({oracleSchema:'C##BANKCRM',intervalMs:1000});
  const db={beginTransaction:async()=>{},query:async()=>({count:1}),commit:async()=>{throw new Error('commit rejected');},rollback:async()=>{}};
  await assert.rejects(addTransaction(db,{transactionId:'RT-uncommitted',eventKey:'RT-uncommitted',accountId:'AC1000011',type:'DEPOSIT',amount:10,currency:'USD'},summary),/commit rejected/);
  assert.equal(summary.tables.get('BANKCORE.ACCOUNT_TRANSACTION').inserts,0);
  assert.equal(summary.failures.length,1);
  assert.equal(summary.failures[0].operation,'INSERT');
});

test('Oracle table writes are counted from successful DML results',async()=>{
  const summary=createExecutionSummary({oracleSchema:'C##BANKCRM',intervalMs:1000});
  const originalRandomInt=crypto.randomInt;
  crypto.randomInt=()=>0;
  try {
    const oracle={execute:async sql=>{
      if(sql.includes('CUSTOMER_INTERACTION_ID_SEQUENCE')) return {rows:[[12345]]};
      if(/^\s*(UPDATE|INSERT)/i.test(sql)) return {rowsAffected:1};
      throw new Error(`Unexpected Oracle SQL: ${sql}`);
    }};
    await updateOracle(oracle,11,411,'RT-summary-event',summary);
  } finally { crypto.randomInt=originalRandomInt; }
  assert.equal(summary.tables.get('C##BANKCRM.CUSTOMER_PROFILE').updates,1);
  assert.equal(summary.tables.get('C##BANKCRM.CUSTOMER_KYC').updates,1);
  assert.equal(summary.tables.get('C##BANKCRM.CUSTOMER_INTERACTIONS').inserts,1);
  assert.equal(summary.tables.get('C##BANKCRM.CUSTOMER_OFFERS').updates,1);
  assert.equal([...summary.tables.values()].reduce((n,row)=>n+row.inserts+row.updates,0),4);
});

test('Oracle failures retain table, operation, and error without counting the write',async()=>{
  const summary=createExecutionSummary({oracleSchema:'C##BANKCRM',intervalMs:1000});
  const originalRandomInt=crypto.randomInt;
  crypto.randomInt=()=>1;
  try {
    await assert.rejects(updateOracle({execute:async()=>{throw new Error('ORA-01031: insufficient privileges');}},11,411,'RT-forbidden',summary),/ORA-01031/);
  } finally { crypto.randomInt=originalRandomInt; }
  assert.equal(summary.tables.get('C##BANKCRM.CUSTOMER_PROFILE').updates,0);
  assert.deepEqual({schema:summary.failures[0].schema,table:summary.failures[0].table,operation:summary.failures[0].operation,message:summary.failures[0].message},
    {schema:'C##BANKCRM',table:'CUSTOMER_PROFILE',operation:'UPDATE',message:'ORA-01031: insufficient privileges'});
});

test('an Oracle retry that ultimately succeeds is counted once and not as a failure',async()=>{
  const summary=createExecutionSummary({oracleSchema:'C##BANKCRM',intervalMs:1000});
  const originalRandomInt=crypto.randomInt;
  const originalRetryLimit=config.retryLimit;
  let calls=0;
  crypto.randomInt=()=>2;
  config.retryLimit=1;
  try {
    await updateOracle({execute:async()=>{
      calls++;
      if(calls===1) throw new Error('temporary timeout');
      return {rowsAffected:1};
    }},11,411,'RT-retried-profile',summary);
  } finally {
    crypto.randomInt=originalRandomInt;
    config.retryLimit=originalRetryLimit;
  }
  assert.equal(calls,2);
  assert.equal(summary.tables.get('C##BANKCRM.CUSTOMER_PROFILE').updates,1);
  assert.equal(summary.failures.length,0);
});

test('retrying a completed deposit status event does not apply its balance twice',async()=>{
  const state={status:'PENDING',balance:100,available:100};
  const summary=createExecutionSummary({oracleSchema:'C##BANKCRM',intervalMs:1000});
  const db={
    beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},
    query:async(sql,binds=[])=>{
      if(sql.startsWith('SELECT TRANSACTION_STATUS')) return [{TRANSACTION_STATUS:state.status,ACCOUNT_ID:9,TRANSACTION_TYPE:'DEPOSIT',TRANSACTION_AMOUNT:20,CURRENCY:'USD'}];
      if(sql.startsWith('SELECT BALANCE')) return [{BALANCE:state.balance,AVAILABLE_BALANCE:state.available}];
      if(sql.startsWith('UPDATE BANKCORE.BANK_ACCOUNT')) { state.balance+=binds[0]; state.available+=binds[1]; return {count:1}; }
      if(sql.includes("SET TRANSACTION_STATUS='COMPLETED'")) { if(state.status==='PENDING') state.status='COMPLETED'; return {count:1}; }
      if(sql.includes("SET TRANSACTION_STATUS='FAILED'")) { state.status='FAILED'; return {count:1}; }
      throw new Error(`Unexpected SQL in mock: ${sql}`);
    }
  };
  const event={transactionId:99,accountId:9,type:'DEPOSIT',amount:20,currency:'USD'};
  await resolveTransaction(db,event,summary);
  await resolveTransaction(db,event,summary);
  assert.equal(state.status,'COMPLETED');
  assert.equal(state.balance,120);
  assert.equal(state.available,120);
  assert.equal(summary.tables.get('BANKCORE.BANK_ACCOUNT').updates,1);
  assert.equal(summary.tables.get('BANKCORE.ACCOUNT_TRANSACTION').updates,1);
});
