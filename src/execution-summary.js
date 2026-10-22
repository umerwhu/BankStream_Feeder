const TABLES = [
  { database: 'IBM i (AS/400) - BANKCORE', schema: 'BANKCORE', table: 'CUSTOMER' },
  { database: 'IBM i (AS/400) - BANKCORE', schema: 'BANKCORE', table: 'BANK_ACCOUNT' },
  { database: 'IBM i (AS/400) - BANKCORE', schema: 'BANKCORE', table: 'ACCOUNT_TRANSACTION' },
  { database: 'IBM i (AS/400) - BANKCORE', schema: 'BANKCORE', table: 'LOAN_ACCOUNT' },
  { database: 'Oracle', schema: null, table: 'CUSTOMER_PROFILE' },
  { database: 'Oracle', schema: null, table: 'CUSTOMER_KYC' },
  { database: 'Oracle', schema: null, table: 'CUSTOMER_INTERACTIONS' },
  { database: 'Oracle', schema: null, table: 'CUSTOMER_OFFERS' }
];

function createExecutionSummary({ oracleSchema, intervalMs, startedAt = Date.now() }) {
  const tables = new Map(TABLES.map(item => {
    const schema = item.schema || oracleSchema;
    return [`${schema}.${item.table}`, { ...item, schema, inserts: 0, updates: 0 }];
  }));
  const successfulOperationKeys = new Set();
  return {
    tables,
    successfulOperationKeys,
    failures: [],
    intervalMs,
    oracleSchema,
    startedAt,
    elapsedMs: 0,
    cycles: 0,
    status: 'Running',
    recordSuccess({ schema, table, operation, key, rows = 1 }) {
      const id = `${schema}.${table}`;
      const stats = tables.get(id);
      if (!stats || !['INSERT', 'UPDATE'].includes(operation) || rows <= 0) return 0;
      const operationKey = key && `${id}:${operation}:${key}`;
      if (operationKey && successfulOperationKeys.has(operationKey)) return 0;
      if (operationKey) successfulOperationKeys.add(operationKey);
      stats[operation === 'INSERT' ? 'inserts' : 'updates'] += rows;
      return rows;
    },
    recordFailure({ schema, table, operation, error }) {
      this.failures.push({ schema, table, operation, message: error?.message || String(error) });
    }
  };
}

function formatDuration(milliseconds) {
  let seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  const parts = [];
  if (hours) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (seconds || parts.length === 0) parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
  return parts.join(', ');
}

function printExecutionSummary(summary, log = console.log) {
  const line = '='.repeat(64);
  const divider = '-'.repeat(64);
  const allTables = [...summary.tables.values()];
  const inserts = allTables.reduce((total, row) => total + row.inserts, 0);
  const updates = allTables.reduce((total, row) => total + row.updates, 0);
  const failures = summary.failures.length;
  const seconds = summary.intervalMs / 1000;
  const interval = Number.isInteger(seconds) ? `${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : `${seconds} seconds`;
  log(line);
  log('        BANKSTREAM FEEDER - EXECUTION SUMMARY');
  log(line);
  log(`Duration:              ${formatDuration(summary.elapsedMs)}`);
  log(`Interval:              ${interval}`);
  log(`Total Cycles:          ${summary.cycles}`);
  log(`Status:                ${summary.status}`);
  log('');
  for (const database of ['IBM i (AS/400) - BANKCORE', 'Oracle']) {
    const rows = allTables.filter(row => row.database === database);
    const title = database === 'Oracle' ? `Oracle - ${summary.oracleSchema}` : database;
    log(`DATABASE: ${title}`);
    log(divider);
    log(`${'Table'.padEnd(36)}${'Inserts'.padStart(12)}${'Updates'.padStart(12)}`);
    for (const row of rows) {
      log(`${`${row.schema}.${row.table}`.padEnd(36)}${String(row.inserts).padStart(12)}${String(row.updates).padStart(12)}`);
    }
    log('');
  }
  log(divider);
  log('TOTALS');
  log(divider);
  log(`Total Inserts:         ${inserts}`);
  log(`Total Updates:         ${updates}`);
  log(`Total Operations:      ${inserts + updates}`);
  log(`Failed Operations:     ${failures}`);
  if (failures) {
    log('Failed operation details:');
    for (const failure of summary.failures) {
      log(`  ${failure.schema}.${failure.table} ${failure.operation}: ${failure.message}`);
    }
  }
  log(line);
}

module.exports = { TABLES, createExecutionSummary, formatDuration, printExecutionSummary };
