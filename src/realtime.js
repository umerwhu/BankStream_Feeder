const crypto = require('node:crypto');
const { runSchedule } = require('./scheduler');
const { createExecutionSummary, printExecutionSummary } = require('./execution-summary');
function createRealtimeService(settings, { signal, log = console.log, progress = () => {}, coordinate = action => action(),
  stopOnError = false, formatError = error => error.message, onIntent = async () => {}, detailedEvents = false } = {}) {
const config = structuredClone(settings);
config.retryLimit ??= 5;
for (const schema of [config.db2.schema || 'BANKCORE', config.oracle.schema]) {
  if (typeof schema !== 'string' || !/^[A-Za-z][A-Za-z0-9_$#]*$/.test(schema)) throw new Error('Invalid realtime schema');
}
const stopping = () => Boolean(signal?.aborted);
const DB2_SCHEMA = (config.db2.schema || 'BANKCORE').toUpperCase();
const db2Table = name => `${DB2_SCHEMA}.${name}`;
const pick = values => values[crypto.randomInt(values.length)];
const money = () => Number((8 + Math.random() * 650).toFixed(2));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryable = error => /08S01|08001|HYT00|timeout|temporar|connection reset|ECONN/i.test(error.message);
const rowsAffected = result => {
  for (const property of ['rowsAffected', 'count', 'rowCount']) {
    if (Number.isFinite(result?.[property])) return result[property];
  }
  return 0;
};

function recordFailure(summary, error, { schema, table, operation }) {
  if (!summary || error.summaryFailureRecorded) return;
  summary.recordFailure({ schema, table, operation, error });
  error.summaryFailureRecorded = true;
}

async function oracleWrite(summary, table, operation, key, label, execute) {
  let result;
  try { result = await retry(label, execute); }
  catch (error) {
    recordFailure(summary, error, { schema: config.oracle.schema, table, operation });
    throw error;
  }
  summary?.recordSuccess({ schema: config.oracle.schema, table, operation, key, rows: rowsAffected(result) });
  return result;
}

async function retry(label, operation) {
  for(let attempt=0;;attempt++) {
    try { return await operation(); }
    catch(error) {
      if(attempt>=config.retryLimit || !retryable(error)) throw error;
      const delay=Math.min(1000*2**attempt,10000);
      log(`${label} failed; retry ${attempt+1}/${config.retryLimit} in ${delay}ms`);
      await pause(delay);
    }
  }
}

async function addTransaction(db2, event, summary) {
  try {
    const result = await retry(`transaction ${event.transactionId}`,async()=>{
      await db2.beginTransaction();
      try {
        const inserted = await db2.query(`INSERT INTO ${db2Table('ACCOUNT_TRANSACTION')} (TRANSACTION_ID,ACCOUNT_ID,TRANSACTION_TYPE,TRANSACTION_STAGE,TRANSACTION_STATUS,TRANSACTION_AMOUNT,CURRENCY,TRANSACTION_TIMESTAMP,CHANNEL,COUNTERPARTY_REFERENCE,LAST_UPDATED_TIMESTAMP) VALUES (?,?,?,'AUTHORIZATION','PENDING',?,?,CURRENT_TIMESTAMP,?,?,CURRENT_TIMESTAMP)`,
        [event.transactionId,event.accountId,event.type,event.amount,event.currency,event.channel,event.eventKey]);
        await db2.commit();
        return { inserted: true, count: rowsAffected(inserted) };
      } catch(error) {
        try { await db2.rollback(); } catch {}
        if(/SQL0803|23505|duplicate|unique/i.test(error.message)) {
          const existing = await db2.query(`SELECT TRANSACTION_ID FROM ${db2Table('ACCOUNT_TRANSACTION')} WHERE TRANSACTION_ID=? AND COUNTERPARTY_REFERENCE=?`,[event.transactionId,event.eventKey]);
          if (existing.length > 0) return { inserted: true, count: 1 };
        }
        throw error;
      }
    });
    if (result.inserted) summary?.recordSuccess({ schema:DB2_SCHEMA,table:'ACCOUNT_TRANSACTION',operation:'INSERT',key:event.eventKey,rows:result.count });
    return result.inserted;
  } catch(error) {
    recordFailure(summary,error,{schema:DB2_SCHEMA,table:'ACCOUNT_TRANSACTION',operation:'INSERT'});
    throw error;
  }
}

// Lock the pending transaction before changing status or balance. Competing feeder
// instances serialize on this row, so only the instance changing PENDING can post it.
async function resolveTransaction(db2,event,summary) {
  let stagedWrites=[];
  try {
    return await retry(`status ${event.transactionId}`,async()=>{
      stagedWrites=[];
      await db2.beginTransaction();
      try {
        let rows;
        try { rows=await db2.query(`SELECT TRANSACTION_STATUS,ACCOUNT_ID,TRANSACTION_TYPE,TRANSACTION_AMOUNT,CURRENCY FROM ${db2Table('ACCOUNT_TRANSACTION')} WHERE TRANSACTION_ID=? FOR UPDATE`,[event.transactionId]); }
        catch(error) { error.summaryOperation={schema:DB2_SCHEMA,table:'ACCOUNT_TRANSACTION',operation:'SELECT'}; throw error; }
        if(!rows.length || rows[0].TRANSACTION_STATUS!=='PENDING') { await db2.commit(); return 0; }
        const makeFailed=event.type!=='DEPOSIT' && pick([true,false]);
        if(makeFailed) {
          const write={schema:DB2_SCHEMA,table:'ACCOUNT_TRANSACTION',operation:'UPDATE',key:`${event.transactionId}:status:FAILED`,rows:0};
          stagedWrites.push(write);
          write.rows=rowsAffected(await db2.query(`UPDATE ${db2Table('ACCOUNT_TRANSACTION')} SET TRANSACTION_STATUS='REJECTED',LAST_UPDATED_TIMESTAMP=CURRENT_TIMESTAMP WHERE TRANSACTION_ID=? AND TRANSACTION_STATUS='PENDING'`,[event.transactionId]));
        } else {
          const delta=event.type==='DEPOSIT'?event.amount:-event.amount;
          let balanceRows;
          try { balanceRows=await db2.query(`SELECT BALANCE,AVAILABLE_BALANCE FROM ${db2Table('BANK_ACCOUNT')} WHERE ACCOUNT_ID=? FOR UPDATE`,[event.accountId]); }
          catch(error) { error.summaryOperation={schema:DB2_SCHEMA,table:'BANK_ACCOUNT',operation:'SELECT'}; throw error; }
          if(!balanceRows.length) throw new Error(`Account ${event.accountId} was not found`);
          if(delta<0 && !config.overdraft && (Number(balanceRows[0].BALANCE)<event.amount || Number(balanceRows[0].AVAILABLE_BALANCE)<event.amount)) {
            const write={schema:DB2_SCHEMA,table:'ACCOUNT_TRANSACTION',operation:'UPDATE',key:`${event.transactionId}:status:FAILED`,rows:0};
            stagedWrites.push(write);
            write.rows=rowsAffected(await db2.query(`UPDATE ${db2Table('ACCOUNT_TRANSACTION')} SET TRANSACTION_STATUS='REJECTED',LAST_UPDATED_TIMESTAMP=CURRENT_TIMESTAMP WHERE TRANSACTION_ID=? AND TRANSACTION_STATUS='PENDING'`,[event.transactionId]));
          } else {
            const accountWrite={schema:DB2_SCHEMA,table:'BANK_ACCOUNT',operation:'UPDATE',key:`${event.transactionId}:account:${event.accountId}`,rows:0};
            stagedWrites.push(accountWrite);
            accountWrite.rows=rowsAffected(await db2.query(`UPDATE ${db2Table('BANK_ACCOUNT')} SET BALANCE=BALANCE+?, AVAILABLE_BALANCE=AVAILABLE_BALANCE+?, LAST_UPDATED_TIMESTAMP=CURRENT_TIMESTAMP WHERE ACCOUNT_ID=?`,[delta,delta,event.accountId]));
            const statusWrite={schema:DB2_SCHEMA,table:'ACCOUNT_TRANSACTION',operation:'UPDATE',key:`${event.transactionId}:status:COMPLETED`,rows:0};
            stagedWrites.push(statusWrite);
            statusWrite.rows=rowsAffected(await db2.query(`UPDATE ${db2Table('ACCOUNT_TRANSACTION')} SET TRANSACTION_STATUS='COMPLETED',TRANSACTION_STAGE='POSTED',LAST_UPDATED_TIMESTAMP=CURRENT_TIMESTAMP WHERE TRANSACTION_ID=? AND TRANSACTION_STATUS='PENDING'`,[event.transactionId]));
          }
        }
        await db2.commit();
        for (const write of stagedWrites) summary?.recordSuccess(write);
        return stagedWrites.reduce((total,write)=>total+write.rows,0);
      } catch(error) { try{await db2.rollback();}catch{} throw error; }
    });
  } catch(error) {
    const writes=stagedWrites.length ? stagedWrites : [error.summaryOperation || {schema:DB2_SCHEMA,table:'ACCOUNT_TRANSACTION',operation:'BEGIN'}];
    if (summary && !error.summaryFailureRecorded) {
      for(const write of writes) summary.recordFailure({...write,error});
      error.summaryFailureRecorded=true;
    }
    throw error;
  }
}

async function updateOracle(oracle,customer,customerProfileId,eventKey,summary) {
  const channel=pick(['MOBILE','WEB','BRANCH','PHONE']);
  await oracleWrite(summary,'CUSTOMER_PROFILE','UPDATE',`${eventKey}:profile`,`Oracle profile ${customer}`,()=>oracle.execute(`UPDATE ${config.oracle.schema}.CUSTOMER_PROFILE SET PREFERRED_CHANNEL=:channel, LAST_UPDATED_TIMESTAMP=SYSTIMESTAMP WHERE CUSTOMER_ID=:customer`,
    {channel,customer},{autoCommit:true}));
  if(crypto.randomInt(4)===0) {
    const status=pick(['VERIFIED','PENDING','REVIEW_REQUIRED','REJECTED','EXPIRED']),risk=pick(['LOW','MEDIUM','HIGH']);
    await oracleWrite(summary,'CUSTOMER_KYC','UPDATE',`${eventKey}:kyc`,`Oracle KYC record ${customer}`,()=>oracle.execute(`UPDATE ${config.oracle.schema}.CUSTOMER_KYC SET KYC_STATUS=:status, RISK_RATING=:risk, LAST_UPDATED_TIMESTAMP=SYSTIMESTAMP WHERE CUSTOMER_ID=:customer`,
      {status,risk,customer},{autoCommit:true}));
  }
  if(crypto.randomInt(3)===0) {
    const interactionId=`RTI-${crypto.randomUUID()}`;
    const binds={interactionId,customerProfileId,type:pick(['CALL','EMAIL','CHAT','BRANCH_VISIT','MOBILE_APP','WEB']),channel:pick(['PHONE','EMAIL','BRANCH','MOBILE','WEB']),summary:`Real-time service event ${eventKey}`};
    await oracleWrite(summary,'CUSTOMER_INTERACTIONS','INSERT',eventKey,`Oracle interaction ${interactionId}`,async()=>{
      try { return await oracle.execute(`INSERT INTO ${config.oracle.schema}.CUSTOMER_INTERACTIONS (CUSTOMER_INTERACTION_ID,CUSTOMER_PROFILE_ID,INTERACTION_TIMESTAMP,INTERACTION_TYPE,CHANNEL,SUMMARY,LAST_UPDATED_TIMESTAMP) VALUES (:interactionId,:customerProfileId,SYSTIMESTAMP,:type,:channel,:summary,SYSTIMESTAMP)`,binds,{autoCommit:true}); }
      catch(error) {
        if(error.errorNum===1) {
          const existing=await oracle.execute(`SELECT CUSTOMER_INTERACTION_ID FROM ${config.oracle.schema}.CUSTOMER_INTERACTIONS WHERE CUSTOMER_INTERACTION_ID=:interactionId AND CUSTOMER_PROFILE_ID=:customerProfileId`,{interactionId,customerProfileId});
          if(existing.rows.length) return {rowsAffected:1};
        }
        throw error;
      }
    });
  }
  if(crypto.randomInt(3)===0) {
    const status=pick(['AVAILABLE','ACCEPTED','DECLINED','EXPIRED','WITHDRAWN']);
    await oracleWrite(summary,'CUSTOMER_OFFERS','UPDATE',`${eventKey}:offer`,`Oracle offer ${customer}`,()=>oracle.execute(`UPDATE ${config.oracle.schema}.CUSTOMER_OFFERS SET OFFER_STATUS=:status, LAST_UPDATED_TIMESTAMP=SYSTIMESTAMP WHERE CUSTOMER_PROFILE_ID=:customerProfileId AND PRODUCT_OFFER_ID=(SELECT MIN(PRODUCT_OFFER_ID) FROM ${config.oracle.schema}.CUSTOMER_OFFERS WHERE CUSTOMER_PROFILE_ID=:customerProfileId)`,
      {status,customerProfileId},{autoCommit:true}));
  }
}

async function recoverPending(db2,summary) {
  let rows;
  try { rows=await db2.query(`SELECT TRANSACTION_ID,ACCOUNT_ID,TRANSACTION_TYPE,TRANSACTION_AMOUNT,CURRENCY,COUNTERPARTY_REFERENCE FROM ${db2Table('ACCOUNT_TRANSACTION')} WHERE TRANSACTION_STATUS='PENDING' ORDER BY TRANSACTION_TIMESTAMP FETCH FIRST 1 ROW ONLY`); }
  catch(error) { recordFailure(summary,error,{schema:DB2_SCHEMA,table:'ACCOUNT_TRANSACTION',operation:'SELECT'}); throw error; }
  if(!rows.length) return 0;
  const row=rows[0];
  await onIntent({ kind:'recovery', transactionId:String(row.TRANSACTION_ID).trim(), accountId:String(row.ACCOUNT_ID).trim() });
  if (detailedEvents) log(`Recovering pending transaction ${String(row.TRANSACTION_ID).trim()}`);
  return resolveTransaction(db2,{transactionId:String(row.TRANSACTION_ID).trim(),eventKey:String(row.COUNTERPARTY_REFERENCE || '').trim(),accountId:String(row.ACCOUNT_ID).trim(),type:String(row.TRANSACTION_TYPE).trim(),amount:Number(row.TRANSACTION_AMOUNT),currency:String(row.CURRENCY).trim()},summary);
}

async function loadWorkloadRecords(db2,oracle,summary) {
  let dbRows;
  try { dbRows=await db2.query(`SELECT C.CUSTOMER_ID,A.ACCOUNT_ID,A.CURRENCY FROM ${db2Table('CUSTOMER')} C JOIN ${db2Table('ACCOUNT_CUSTOMER_RELATIONSHIP')} R ON R.CUSTOMER_ID=C.CUSTOMER_ID JOIN ${db2Table('BANK_ACCOUNT')} A ON A.ACCOUNT_ID=R.ACCOUNT_ID WHERE C.CUSTOMER_STATUS='ACTIVE' AND A.ACCOUNT_STATUS='ACTIVE'`); }
  catch(error) { recordFailure(summary,error,{schema:DB2_SCHEMA,table:'CUSTOMER/BANK_ACCOUNT',operation:'SELECT'}); throw error; }
  let oracleResult;
  try { oracleResult=await oracle.execute(`SELECT CUSTOMER_ID,CUSTOMER_PROFILE_ID FROM ${config.oracle.schema}.CUSTOMER_PROFILE`); }
  catch(error) { recordFailure(summary,error,{schema:config.oracle.schema,table:'CUSTOMER_PROFILE',operation:'SELECT'}); throw error; }
  const profileByCustomer=new Map(oracleResult.rows.map(row=>[String(row[0]).trim(),String(row[1]).trim()]));
  const records=dbRows.map(row=>({customer:Number(row.CUSTOMER_ID),accountId:String(row.ACCOUNT_ID).trim(),currency:String(row.CURRENCY).trim(),customerProfileId:profileByCustomer.get(String(row.CUSTOMER_ID).trim())})).filter(row=>row.customerProfileId!==undefined);
  if(!records.length) {
    const error=new Error('No active Db2 customer accounts with matching Oracle customer profiles were found');
    recordFailure(summary,error,{schema:'FEEDER',table:'CUSTOMER/BANK_ACCOUNT/CUSTOMER_PROFILE',operation:'VALIDATE'});
    throw error;
  }
  return records;
}

async function cycle(db2,oracle,records,summary) {
  await recoverPending(db2,summary);
  const selected=records[crypto.randomInt(records.length)];
  const {customer,accountId,currency,customerProfileId}=selected;
  const type=pick(['DEPOSIT','WITHDRAWAL','CARD_PURCHASE','BILL_PAYMENT']);
  const eventKey=`RT-${crypto.randomUUID()}`;
  const event={transactionId:eventKey,eventKey,customer,accountId,type,currency,amount:money(),channel:pick(['MOBILE','WEB','ATM','BRANCH'])};
  await onIntent({ kind:'generation', transactionId:event.transactionId, eventKey, accountId, customer, customerProfileId });
  if (detailedEvents) log(`Generated transaction ${event.transactionId} customer=${customer} account=${accountId}`);
  await addTransaction(db2,event,summary);
  await resolveTransaction(db2,event,summary);
  await updateOracle(oracle,customer,customerProfileId,event.eventKey,summary);
  log(`${new Date().toISOString()} event=${event.eventKey} transaction=${event.transactionId} customer=${customer} account=${accountId} ${type} ${event.amount} ${currency}`);
}

async function realtime(db2,oracle,options={}) {
  const summary=createExecutionSummary({db2Schema:DB2_SCHEMA,formatError,oracleSchema:config.oracle.schema,intervalMs:options.intervalMs ?? 15_000,
    onSuccess: row => { if (detailedEvents) log(`Source ${row.schema}.${row.table} ${row.operation} rows=${row.rows}`); progress(summary); } });
  try {
    progress(summary);
    const records=await loadWorkloadRecords(db2,oracle,summary);
    log('Real-time workload started. Ctrl+C to stop.');
    const deadline = Date.now() + (options.durationMs ?? Infinity);
    await runSchedule({
      durationMs:options.durationMs ?? Infinity,
      intervalMs:options.intervalMs ?? 15_000,
      eventsPerCycle:options.eventsPerCycle ?? 1,
      summary,
      runCycle:async()=> {
        try { return await coordinate(async () => {
          if (stopping() || Date.now() >= deadline) return false;
          await cycle(db2,oracle,records,summary);
          return true;
        }, summary); }
        finally { progress(summary); }
      },
      log, stopOnError, formatError, onProgress:progress,
      shouldStop:stopping,
      sleep:async ms=>{let remaining=ms; while(remaining>0&&!stopping()){const chunk=Math.min(remaining,250);await pause(chunk);remaining-=chunk;}}
    });
  } catch(error) {
    if (!error.summaryFailureRecorded) recordFailure(summary,error,{schema:'FEEDER',table:'WORKLOAD',operation:'START'});
    summary.status='Failed';
    throw error;
  } finally {
    summary.elapsedMs=Date.now()-summary.startedAt;
    progress(summary);
    printExecutionSummary(summary,log);
  }
  return summary;
}

return {realtime,cycle,resolveTransaction,addTransaction,updateOracle,loadWorkloadRecords};
}

// Backward-compatible local helpers; hosted callers use only the explicit factory.
const local = name => (...args) => createRealtimeService(require('./config').config)[name](...args);
module.exports={createRealtimeService, ...Object.fromEntries(['realtime','cycle','resolveTransaction','addTransaction','updateOracle','loadWorkloadRecords'].map(name=>[name,local(name)]))};
