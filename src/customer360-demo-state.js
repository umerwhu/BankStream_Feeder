const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const projectRoot = path.resolve(__dirname, '..');
const finite = value => typeof value === 'number' && Number.isFinite(value);

function validateTransactionRecord(record, expectedCustomerId) {
  if (!record || record.version !== 1 || String(record.customerId) !== String(expectedCustomerId) ||
      !/^\d+$/.test(String(record.customerId)) || !record.accountId || String(record.accountId).length > 30 ||
      !/^RT-[0-9a-f-]{36}$/i.test(String(record.transactionId)) || record.amount !== 200 || record.currency !== 'GBP' ||
      !finite(record.previousBalance) || !finite(record.newBalance) || !finite(record.previousAvailableBalance) ||
      !finite(record.newAvailableBalance) || Math.abs(record.previousBalance - record.newBalance - 200) > 0.0001 ||
      Math.abs(record.previousAvailableBalance - record.newAvailableBalance - 200) > 0.0001 ||
      typeof record.transactionTimestamp !== 'string' || !record.transactionTimestamp.trim() ||
      typeof record.completionTimestamp !== 'string' || !record.completionTimestamp.trim()) {
    throw new Error('The local demo transaction record is missing required fields or is inconsistent');
  }
  return record;
}

function validateKycBaseline(record, expectedCustomerId) {
  if (!record || record.version !== 1 || String(record.customerId) !== String(expectedCustomerId) ||
      !/^\d+$/.test(String(record.customerId)) || !record.kycRecordId ||
      typeof record.kycStatus !== 'string' || !record.kycStatus.trim() ||
      (record.riskRating !== null && typeof record.riskRating !== 'string') ||
      typeof record.capturedAt !== 'string' || !record.capturedAt.trim()) {
    throw new Error('The local KYC baseline is missing required fields or belongs to a different customer');
  }
  return record;
}

function createDemoStateStore({ runtimeDir = path.join(projectRoot, 'runtime') } = {}) {
  const transactionPath = path.join(runtimeDir, 'last-demo-transaction.json');
  const baselinePath = customerId => path.join(runtimeDir, `kyc-baseline-${String(customerId)}.json`);

  async function readJson(file, description) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new Error(`The ${description} file is invalid JSON: ${file}`);
      throw error;
    }
  }

  async function atomicReplace(file, contents) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async function saveTransaction(record) {
    validateTransactionRecord(record, record.customerId);
    await atomicReplace(transactionPath, record);
  }

  async function loadTransaction(customerId) {
    const record = await readJson(transactionPath, 'demo transaction record');
    return record === null ? null : validateTransactionRecord(record, customerId);
  }

  async function loadKycBaseline(customerId) {
    const file = baselinePath(customerId);
    const record = await readJson(file, 'KYC baseline');
    return record === null ? null : validateKycBaseline(record, customerId);
  }

  async function saveKycBaseline(record) {
    validateKycBaseline(record, record.customerId);
    const file = baselinePath(record.customerId);
    await fs.mkdir(runtimeDir, { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      try {
        // wx guarantees that a baseline from an earlier run is never replaced.
        // Persist it before Oracle is changed; a partial file on interruption is
        // rejected on the next run and therefore cannot silently lose the baseline.
        const handle = await fs.open(file, 'wx');
        try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        return record;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await readJson(file, 'KYC baseline');
        return validateKycBaseline(existing, record.customerId);
      }
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  return { transactionPath, baselinePath, saveTransaction, loadTransaction, loadKycBaseline, saveKycBaseline };
}

module.exports = { createDemoStateStore, validateTransactionRecord, validateKycBaseline };
