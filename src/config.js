require('dotenv').config();
const path = require('node:path');
const projectRoot = path.resolve(__dirname, '..');

function createConfig(env = process.env) {
const number = (name, fallback, min = 0) => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
};

return {
  db2: { dsn: env.DB2I_DSN?.trim(), host: env.DB2I_HOST?.trim(), driver: env.DB2I_DRIVER || 'IBM i Access ODBC Driver', schema: env.DB2I_SCHEMA?.trim(), jdbcJar: env.DB2I_JT400_JAR?.trim() ? path.resolve(projectRoot, env.DB2I_JT400_JAR.trim()) : undefined, jdbcUrl: env.DB2I_JDBC_URL?.trim(), javaCommand: env.JAVA_COMMAND, user: env.DB2I_USER, password: env.DB2I_PASSWORD },
  oracle: { user: env.ORACLE_USER, password: env.ORACLE_PASSWORD, connectString: env.ORACLE_CONNECT_STRING, schema: (env.ORACLE_SCHEMA || 'BANKCRM').trim() },
  retryLimit: number('RETRY_LIMIT', 5, 0), overdraft: env.ALLOW_OVERDRAFT === 'true', logLevel: env.LOG_LEVEL || 'info'
};

}
const config = createConfig();

function validate(mode) {
  if (!['realtime', 'dry-run'].includes(mode)) throw new Error('Usage: npm run realtime -- [options]');
  if (!config.db2.dsn && !config.db2.host) throw new Error('Missing required configuration: DB2I_DSN or DB2I_HOST');
  if (config.db2.schema && !/^[A-Za-z][A-Za-z0-9_$#]*$/.test(config.db2.schema)) throw new Error('DB2I_SCHEMA must be a valid Db2 schema identifier');
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(config.oracle.schema)) throw new Error('ORACLE_SCHEMA must be a valid Oracle schema identifier');
  for (const [label, value] of Object.entries({ DB2I_USER: config.db2.user, DB2I_PASSWORD: config.db2.password,
    ORACLE_USER: config.oracle.user, ORACLE_PASSWORD: config.oracle.password, ORACLE_CONNECT_STRING: config.oracle.connectString })) {
    if (!value) throw new Error(`Missing required configuration: ${label}`);
  }
}
module.exports = { config, validate, createConfig };
