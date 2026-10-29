'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const VERSION = '21.0.6';
const SHA256 = '0b3fbdc17486b57038c6f64aa38a3d488b576986e8bd5d7f85bbcdac24b264b7';
async function install(target = path.resolve(__dirname, `../runtime/drivers/jt400-${VERSION}.jar`)) {
  const matches = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex') === SHA256;
  if (fs.existsSync(target)) {
    if (!matches(target)) throw new Error('Existing JAR has a different checksum; refusing to overwrite it.');
    return target;
  }
  const response = await fetch(`https://repo.maven.apache.org/maven2/net/sf/jt400/jt400/${VERSION}/jt400-${VERSION}.jar`, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  if (!response.ok) throw new Error('Official JT400 download failed');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 25000000) throw new Error('JAR download too large'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== SHA256) throw new Error('JT400 checksum mismatch');
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  return target;
}
if (require.main === module) install(process.argv[2] ? path.resolve(process.argv[2]) : undefined).then(() => {
  console.log(`JT400 ${VERSION} installed and checksum verified. Configure DB2I_JT400_JAR/jdbcJar with its path.`);
  console.log('Upstream license and distribution information: https://github.com/IBM/JTOpen');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { install, VERSION, SHA256 };
