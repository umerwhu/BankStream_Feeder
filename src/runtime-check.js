'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
function checkRuntime(config) {
  const checks = [];
  try { require('oracledb'); checks.push({ component: 'oracledb (Thin)', ok: true }); }
  catch { checks.push({ component: 'oracledb (Thin)', ok: false, action: 'Install oracledb@6.10.0; Oracle Client libraries are not used by this application.' }); }
  if (config.db2.jdbcJar) {
    checks.push({ component: 'JT400 JAR', ok: fs.existsSync(config.db2.jdbcJar), action: 'Set jdbcJar/DB2I_JT400_JAR to the installed JAR; npm run driver:jt400 installs a checksum-pinned JAR.' });
    const java = spawnSync(config.db2.javaCommand || 'java', ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const modules = spawnSync(config.db2.javaCommand || 'java', ['--list-modules'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    checks.push({ component: 'JDK 11+ source launcher', ok: java.status === 0 && /version "(?:1[1-9]|[2-9]\d)(?:[.\"])/.test(java.stderr + java.stdout) && modules.status === 0 && /jdk\.compiler@/.test(modules.stdout),
      action: 'Install a JDK 11+ (including jdk.compiler) on PATH, or explicitly configure javaCommand/JAVA_COMMAND. A compiler-free JRE is insufficient.' });
  } else {
    try { require('odbc'); checks.push({ component: 'Node ODBC module', ok: true, action: 'System IBM i ODBC driver/DSN must also be installed separately.' }); }
    catch { checks.push({ component: 'Node ODBC module', ok: false, action: 'Install odbc@2.6.0 plus IBM i Access and platform ODBC/native-build prerequisites.' }); }
  }
  return checks;
}
module.exports = { checkRuntime };
