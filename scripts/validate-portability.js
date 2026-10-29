'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const tls = require('node:tls');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');

async function validate(serviceRoot) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !serviceRoot) throw new Error('Usage: npm run portability:check -- --service <explicit-control-service-checkout>');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bankstream-portability-'));
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (/^(FEEDER_|DEMO_|DB2I_|ORACLE_|TAPDATA_|CONTROL_|NODE_PATH$|NODE_OPTIONS$|NODE_TLS_REJECT_UNAUTHORIZED$|NPM_CONFIG_|NPM_TOKEN$|NODE_AUTH_TOKEN$)/i.test(key)) delete clean[key];
  for (const [kind, key] of [['user', 'npm_config_userconfig'], ['global', 'npm_config_globalconfig']]) {
    clean[key] = path.join(directory, `${kind}.npmrc`); fs.writeFileSync(clean[key], '');
  }
  clean.NODE_ENV = 'development';
  const run = (command, args, cwd, env = clean) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true }); let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill(), 180000);
    child.once('error', reject); child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Portability step failed: ${path.basename(command)} ${args[0] || ''}\n${(stderr || stdout).slice(-3000)}`));
      else resolve(stdout);
    });
  });
  const npm = (args, cwd, env) => run(process.execPath, [npmCli, ...args], cwd, env);
  let server;
  try {
    const report = { platform: process.platform, architecture: process.arch, node: process.versions.node, productionReleasePinned: false };
    report.npm = (await npm(['--version'], root)).trim();
    const artifacts = path.join(directory, 'artifacts'); fs.mkdirSync(artifacts);
    const packed = JSON.parse(await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', artifacts], root))[0];
    if (packed.files.some(file => file.path === '.env' || /\.(pem|key|jar)$/.test(file.path) || /(?:^|\/)\.phase\d/.test(file.path))) throw new Error('Package contains a secret, binary driver or staging artifact');
    report.packageWhitelistVerified = true;
    const remote = path.join(directory, 'remote-cli'); fs.mkdirSync(remote);
    fs.copyFileSync(path.join(root, 'package.json'), path.join(remote, 'package.json'));
    fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(remote, 'package-lock.json'));
    for (const name of ['src', 'scripts']) fs.cpSync(path.join(root, name), path.join(remote, name), { recursive: true });
    await npm(['ci', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], remote);
    for (const name of ['odbc', 'oracledb']) if (fs.existsSync(path.join(remote, 'node_modules', name))) throw new Error('Remote profile installed a database driver');
    const remoteEnv = { ...clean, FEEDER_MODE: 'remote', DEMO_API_URL: 'https://example.invalid', DEMO_API_TOKEN: 'fixture-token', PATH: path.dirname(process.execPath) };
    await run(process.execPath, ['scripts/doctor.js'], remote, remoteEnv);
    report.remoteCleanCi = true; report.remoteNativeDriversAbsent = true; report.remoteDoctorWithoutJava = true;
    const cert = path.join(directory, 'local.pem'), key = path.join(directory, 'local.key');
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], directory);
    const bytes = fs.readFileSync(path.join(artifacts, packed.filename));
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      if (req.url !== '/' + packed.filename) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }); res.end(bytes);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const artifactUrl = `https://127.0.0.1:${server.address().port}/${packed.filename}`;
    const bundle = path.join(directory, 'ca-bundle.pem'); fs.writeFileSync(bundle, tls.rootCertificates.join('\n') + '\n' + fs.readFileSync(cert, 'utf8'));
    const installEnv = { ...clean, NODE_EXTRA_CA_CERTS: cert, npm_config_cafile: bundle };
    const service = path.join(directory, 'control'); fs.mkdirSync(service);
    for (const name of ['src', 'scripts', 'test', 'config']) fs.cpSync(path.join(serviceRoot, name), path.join(service, name), {
      recursive: true, filter: source => !source.startsWith(path.join(serviceRoot, 'config') + path.sep) || fs.statSync(source).isDirectory() || source.endsWith('.example.json')
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(serviceRoot, 'package.json'), 'utf8'));
    pkg.dependencies ||= {}; pkg.dependencies['banking-customer360-demo'] = artifactUrl;
    fs.writeFileSync(path.join(service, 'package.json'), JSON.stringify(pkg, null, 2));
    await npm(['install', '--package-lock-only', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], service, installEnv);
    await npm(['ci', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], service, installEnv);
    await run(process.execPath, ['scripts/check-release.js'], service, installEnv);
    if (fs.existsSync(path.join(directory, 'bankstream-feeder'))) throw new Error('Unexpected sibling checkout');
    for (const name of ['odbc','oracledb']) if (fs.existsSync(path.join(service, 'node_modules', name))) throw new Error('Optional driver unexpectedly installed');
    const testOutput = await npm(['test'], service, installEnv);
    report.serviceCleanCi = true; report.feederInstalledByHttpsPackageDependency = true;
    report.siblingCheckoutAbsent = true; report.serviceTests = Number(/tests (\d+)/.exec(testOutput)?.[1]);
    report.actualRemoteCommandsOverTlsWithMockedSources = /existing CLI completes all hosted commands/.test(testOutput);
    const data = path.join(service, 'runtime-check'); fs.mkdirSync(data);
    const probe = require('node:net').createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const bootPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const bootEnv = { ...installEnv, PORT: String(bootPort), CONTROL_PARTNERS_FILE: path.join(data, 'partners.json'),
      CONTROL_SECRETS_FILE: path.join(data, 'secrets.json'), CONTROL_DATA_DIR: path.join(data, 'data'), CONTROL_CHECK_DRIVERS: 'false' };
    await run(process.execPath, ['scripts/admin.js', 'init'], service, bootEnv);
    const boot = spawn(process.execPath, [path.join(service, 'src/server.js')], { cwd: directory, env: bootEnv, windowsHide: true });
    let bootError = ''; boot.stderr.on('data', data => { bootError += data; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { boot.kill(); reject(new Error('Portable service boot timed out')); }, 10000);
      boot.stdout.on('data', data => { if (String(data).includes('listening')) { clearTimeout(timer); resolve(); } });
      boot.once('exit', () => { clearTimeout(timer); reject(new Error('Portable service boot failed: ' + bootError.slice(-1500))); });
      boot.once('error', reject);
    });
    boot.kill(); await once(boot, 'exit');
    report.serviceBootFromUnrelatedCwd = true;
    report.releaseSource = 'Ephemeral HTTPS npm artifact; validation only, not a published release';
    report.linuxExecuted = process.platform === 'linux'; report.macosExecuted = process.platform === 'darwin';
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runtime/phase6-portability.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('bankstream-portability-')) throw new Error('Unexpected cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
if (require.main === module) validate(process.argv[2] === '--service' ? path.resolve(process.argv[3] || '') : undefined).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validate };
