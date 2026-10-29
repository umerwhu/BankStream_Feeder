'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const IMAGE = 'node:24-bookworm@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413';
async function validate(serviceRoot) {
  if (!serviceRoot) throw new Error('Usage: npm run portability:linux -- --service <explicit-service-checkout>');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bankstream-linux-validation-'));
  const name = 'bankstream-validation-' + randomUUID();
  const run = args => new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Linux container validation failed')));
  });
  try {
    const feeder = path.join(directory, 'feeder'), service = path.join(directory, 'service');
    fs.mkdirSync(feeder); fs.mkdirSync(service);
    // Export only reviewed source/test fixtures; never mount the user's environment, keys or node_modules.
    for (const item of ['src','scripts','test','ddl','bulk-data','db2i_driver','package.json','package-lock.json','README.md','.env.example']) fs.cpSync(path.join(root,item), path.join(feeder,item), { recursive: true });
    for (const item of ['src','scripts','test','package.json','package-lock.json','README.md','.env.example']) fs.cpSync(path.join(serviceRoot,item), path.join(service,item), { recursive: true });
    fs.mkdirSync(path.join(service, 'config'));
    for (const item of fs.readdirSync(path.join(serviceRoot, 'config')).filter(item => item.endsWith('.example.json'))) fs.copyFileSync(path.join(serviceRoot,'config',item), path.join(service,'config',item));
    await run(['run','--rm','--name',name,'--mount',`type=bind,source=${directory},target=/work`,'--workdir','/work/feeder',IMAGE,
      'sh','-c','npm ci --omit=optional --ignore-scripts --no-audit --no-fund && npm test && npm run portability:check -- --service /work/service']);
    const report = JSON.parse(fs.readFileSync(path.join(feeder,'runtime/phase6-portability.json'),'utf8'));
    report.containerImage = IMAGE;
    fs.mkdirSync(path.join(root,'runtime'), {recursive:true});
    fs.writeFileSync(path.join(root,'runtime/phase6-linux-portability.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  } finally {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir())+path.sep) || !path.basename(resolved).startsWith('bankstream-linux-validation-')) throw new Error('Unexpected cleanup target');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}
if (require.main === module) validate(process.argv[2] === '--service' ? path.resolve(process.argv[3] || '') : undefined).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports = { validate, IMAGE };
