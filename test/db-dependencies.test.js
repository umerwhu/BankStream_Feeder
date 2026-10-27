const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const dbPath = require.resolve('../src/db');
const driverJar = path.resolve(__dirname, '..', 'db2i_driver', 'jt400-21.0.6.jar');

function loadDb({ odbcModule, jdbcConnect }) {
  delete require.cache[dbPath];
  const originalLoad = Module._load;
  let odbcLoads = 0;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === dbPath && request === 'odbc') {
      odbcLoads++;
      if (odbcModule instanceof Error) throw odbcModule;
      return odbcModule;
    }
    if (parent?.filename === dbPath && request === './db2-jdbc-bridge') return { connectDb2Jdbc: jdbcConnect };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return { db: require(dbPath), getOdbcLoads: () => odbcLoads, restore: () => { Module._load = originalLoad; delete require.cache[dbPath]; } }; }
  catch (error) { Module._load = originalLoad; throw error; }
}

test('JDBC/JT400 connects when loading the native ODBC package would fail', async () => {
  let jdbcConfig;
  const loaded = loadDb({ odbcModule: new Error('simulated missing unixODBC native library'), jdbcConnect: async cfg => { jdbcConfig = cfg; return { jdbc: true }; } });
  try {
    const result = await loaded.db.connectDb2({ db2: { jdbcJar: driverJar, host: 'ibmi.example', schema: 'BANKCORE', user: 'demo', password: 'dummy' } });
    assert.deepEqual(result, { jdbc: true });
    assert.equal(loaded.getOdbcLoads(), 0);
    assert.equal(jdbcConfig.jdbcJar, driverJar);
  } finally { loaded.restore(); }
});

test('ODBC connection path still lazily loads and calls the ODBC package', async () => {
  let connectionString;
  const loaded = loadDb({ odbcModule: { connect: async value => { connectionString = value; return { odbc: true }; } }, jdbcConnect: async () => { throw new Error('JDBC should not be selected'); } });
  try {
    const result = await loaded.db.connectDb2({ db2: { dsn: 'BANKCORE_DSN', user: 'demo', password: 'dummy' } });
    assert.deepEqual(result, { odbc: true });
    assert.equal(loaded.getOdbcLoads(), 1);
    assert.match(connectionString, /DSN=\{BANKCORE_DSN\}/);
  } finally { loaded.restore(); }
});
