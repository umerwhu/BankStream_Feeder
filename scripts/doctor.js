'use strict';
require('dotenv').config();
try {
  const mode = require('../src/execution-mode').getExecutionMode();
  console.log(`Node ${process.versions.node}; mode=${mode}`);
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20+ required; use a supported LTS release.');
  if (mode === 'remote') {
    require('../src/execution-mode').getRemoteConfig();
    console.log('Remote configuration valid. No Java, database driver or database connection check is required.');
  } else {
    const { config, validate } = require('../src/config'); validate('realtime');
    const checks = require('../src/runtime-check').checkRuntime(config);
    for (const check of checks) console.log(`${check.component}: ${check.ok ? 'OK' : 'MISSING'}${check.action ? ` — ${check.action}` : ''}`);
    if (checks.some(check => !check.ok)) process.exitCode = 1;
    console.log('No database connections were opened.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
