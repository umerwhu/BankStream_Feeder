const odbc = require('odbc');
const oracledb = require('oracledb');
const fs = require('node:fs');
const { connectDb2Jdbc } = require('./db2-jdbc-bridge');
const odbcValue = value => `{${String(value).replace(/}/g, '}}')}}`;
function db2ConnectionString(config) {
  if (config.db2.host) {
    if (!config.db2.schema) throw new Error('DB2I_SCHEMA is required when DB2I_HOST is configured');
    return `DRIVER=${odbcValue(config.db2.driver)};SYSTEM=${odbcValue(config.db2.host)};DBQ=${odbcValue(config.db2.schema)};UID=${odbcValue(config.db2.user)};PWD=${odbcValue(config.db2.password)}`;
  }
  return `DSN=${odbcValue(config.db2.dsn)};UID=${odbcValue(config.db2.user)};PWD=${odbcValue(config.db2.password)}`;
}
async function connectDb2(config) {
  if (config.db2.jdbcJar) {
    if (!config.db2.host || !config.db2.schema) throw new Error('DB2I_HOST and DB2I_SCHEMA are required when DB2I_JT400_JAR is configured');
    if (!fs.existsSync(config.db2.jdbcJar)) throw new Error(`JT400 driver jar was not found: ${config.db2.jdbcJar}`);
    return connectDb2Jdbc({
      jdbcJar: config.db2.jdbcJar,
      jdbcUrl: config.db2.jdbcUrl || `jdbc:as400://${config.db2.host};libraries=${config.db2.schema};`,
      javaCommand: config.db2.javaCommand,
      user: config.db2.user,
      password: config.db2.password
    });
  }
  return odbc.connect(db2ConnectionString(config));
}
async function connectOracle(config) {
  return oracledb.getConnection({ user: config.oracle.user, password: config.oracle.password, connectString: config.oracle.connectString });
}
async function connect(config) {
  const db2 = await connectDb2(config);
  let oracle;
  try { oracle = await connectOracle(config); }
  catch (e) { await db2.close(); throw e; }
  return { db2, oracle };
}
module.exports = { connect, connectDb2, connectOracle, db2ConnectionString };
