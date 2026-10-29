async function dryRun({ connectOracle, connectDb2, log = console.log, errorLog = console.error, formatError = error => error.message }) {
  let failed = false;
  for (const [label, connect, check] of [
    ['Oracle', connectOracle, connection => connection.execute('SELECT 1 FROM DUAL')],
    ['Db2 for i', connectDb2, connection => connection.query('SELECT 1 FROM SYSIBM.SYSDUMMY1')]
  ]) {
    let connection;
    try {
      connection = await connect();
      await check(connection);
      log(`${label} connection: OK`);
    } catch (error) {
      failed = true;
      errorLog(`${label} connection: FAILED (${formatError(error)})`);
    } finally {
      if (connection) {
        try { await connection.close(); } catch (error) {
          failed = true;
          errorLog(`${label} close: FAILED (${formatError(error)})`);
        }
      }
    }
  }
  if (failed) throw new Error('One or more database connectivity checks failed');
  log('Dry run complete; no data was changed.');
}

module.exports = { dryRun };
