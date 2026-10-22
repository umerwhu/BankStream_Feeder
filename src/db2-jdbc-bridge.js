const { spawn } = require('node:child_process');
const path = require('node:path');
const { once } = require('node:events');

const encode = value => Buffer.from(String(value), 'utf8').toString('base64url');

function parameter(value) {
  if (value === null || value === undefined) return `N${encode('')}`;
  if (value instanceof Date) return `T${encode(value.toISOString())}`;
  if (typeof value === 'number') return `${Number.isSafeInteger(value) ? 'I' : 'F'}${encode(value)}`;
  return `S${encode(value)}`;
}

class Db2JdbcBridge {
  constructor(config) {
    this.config = config;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
  }

  async open() {
    const bridgeFile = path.join(__dirname, 'Db2JdbcBridge.java');
    this.child = spawn(this.config.javaCommand || 'java', ['--class-path', this.config.jdbcJar, bridgeFile], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.stderr.on('data', chunk => process.stderr.write(`[Db2 JDBC] ${chunk}`));
    this.child.on('error', error => this.rejectPending(error));
    this.child.on('exit', code => {
      if (this.pending.size) this.rejectPending(new Error(`Db2 JDBC bridge exited with code ${code}`));
    });
    await this.request('CONNECT', [this.config.jdbcUrl, this.config.user, this.config.password].map(encode));
    return this;
  }

  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      const [id, status, payload] = line.split('\t');
      const pending = this.pending.get(Number(id));
      if (!pending) continue;
      this.pending.delete(Number(id));
      const decoded = Buffer.from(payload || '', 'base64url').toString('utf8');
      if (status === 'OK') pending.resolve(JSON.parse(decoded));
      else pending.reject(new Error(decoded));
    }
  }

  rejectPending(error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  request(action, fields = []) {
    if (!this.child || this.child.stdin.destroyed) return Promise.reject(new Error('Db2 JDBC bridge is not available'));
    const id = this.nextId++;
    const line = [String(id), action, ...fields].join('\t') + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(line, error => {
        if (error && this.pending.delete(id)) reject(error);
      });
    });
  }

  query(sql, params = []) {
    return this.request('QUERY', [encode(sql), String(params.length), ...params.map(parameter)]);
  }

  beginTransaction() { return this.request('BEGIN'); }
  commit() { return this.request('COMMIT'); }
  rollback() { return this.request('ROLLBACK'); }

  async close() {
    if (!this.child || this.child.exitCode !== null) return;
    const exited = once(this.child, 'exit');
    await this.request('CLOSE').catch(() => {});
    this.child.stdin.end();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (this.child.exitCode === null) this.child.kill();
  }
}

async function connectDb2Jdbc(config) {
  const client = new Db2JdbcBridge(config);
  try { return await client.open(); }
  catch (error) { await client.close(); throw error; }
}

module.exports = { connectDb2Jdbc, parameter };
