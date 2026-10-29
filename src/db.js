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
      suppressDiagnostics: config.db2.suppressDiagnostics === true,
      user: config.db2.user,
      password: config.db2.password
    });
  }
  // The native ODBC binding is required only for DSN/ODBC connections. Keep
  // it out of the JDBC path so macOS users with JT400 do not need unixODBC.
  let odbc;
  try { odbc = require('odbc'); }
  catch { throw new Error('ODBC runtime unavailable. Install the optional odbc package and the platform IBM i ODBC/system-driver prerequisites; run npm run doctor.'); }
  return odbc.connect(db2ConnectionString(config));
}
async function connectOracle(config) {
  let oracledb;
  try { oracledb = require('oracledb'); }
  catch { throw new Error('Oracle runtime unavailable. Install the optional oracledb package (npm ci --include=optional); run npm run doctor.'); }
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
