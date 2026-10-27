const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDemoService } = require('../src/customer360-demo');
const { createDemoStateStore } = require('../src/customer360-demo-state');
const { confirmAction } = require('../src/demo-confirmation');

function relationship(state) {
  return { CUSTOMER_ID: '100002', CUSTOMER_NAME: 'Demo Customer', CUSTOMER_STATUS: 'ACTIVE', OWNERSHIP_ROLE: 'PRIMARY',
    EFFECTIVE_FROM: '2020-01-01', EFFECTIVE_TO: null, ACCOUNT_ID: 'AC1000021', ACCOUNT_NUMBER: '••••0001', ACCOUNT_TYPE: 'CHECKING',
    CURRENCY: 'GBP', ACCOUNT_STATUS: 'ACTIVE', BALANCE: state.balance, AVAILABLE_BALANCE: state.available };
}

function db2Mock({ balance = 4381, available = balance } = {}) {
  const state = { balance, available, transactions: [], pending: null, snapshot: null, commits: 0, rollbacks: 0, queries: [] };
  return { state, close: async () => {},
    beginTransaction: async () => { state.snapshot = { balance: state.balance, available: state.available, length: state.transactions.length }; },
    commit: async () => { if (state.pending) state.transactions.push(state.pending); state.pending = null; state.snapshot = null; state.commits++; },
    rollback: async () => { if (state.snapshot) { state.balance = state.snapshot.balance; state.available = state.snapshot.available; state.transactions.length = state.snapshot.length; } state.pending = null; state.snapshot = null; state.rollbacks++; },
    query: async (sql, binds = []) => {
      state.queries.push(sql);
      if (sql.includes('JOIN BANKCORE.ACCOUNT_CUSTOMER_RELATIONSHIP')) return [relationship(state)];
      if (sql.includes('FROM BANKCORE.BANK_ACCOUNT WHERE ACCOUNT_ID=? FOR UPDATE')) return [{ ACCOUNT_ID: 'AC1000021', CURRENCY: 'GBP', ACCOUNT_STATUS: 'ACTIVE', BALANCE: state.balance, AVAILABLE_BALANCE: state.available }];
      if (sql.startsWith('INSERT INTO BANKCORE.ACCOUNT_TRANSACTION')) {
        state.pending = { TRANSACTION_ID: binds[0], ACCOUNT_ID: binds[1], TRANSACTION_TYPE: 'WITHDRAWAL', TRANSACTION_STAGE: 'POSTED', TRANSACTION_STATUS: 'COMPLETED', TRANSACTION_AMOUNT: binds[2], CURRENCY: binds[3], TRANSACTION_TIMESTAMP: '2026-10-27 12:00:00', COUNTERPARTY_REFERENCE: binds[4] };
        return { count: 1 };
      }
      if (sql.startsWith('UPDATE BANKCORE.BANK_ACCOUNT')) { state.balance -= binds[0]; state.available -= binds[1]; return { count: 1 }; }
      if (sql.startsWith('SELECT BALANCE,AVAILABLE_BALANCE FROM BANKCORE.BANK_ACCOUNT')) return [{ BALANCE: state.balance, AVAILABLE_BALANCE: state.available }];
      if (sql.startsWith('SELECT TRANSACTION_TIMESTAMP FROM BANKCORE.ACCOUNT_TRANSACTION')) return state.pending ? [{ TRANSACTION_TIMESTAMP: state.pending.TRANSACTION_TIMESTAMP }] : [];
      if (sql.startsWith('SELECT TRANSACTION_ID,TRANSACTION_TYPE')) return [];
      if (sql.startsWith('SELECT TRANSACTION_ID,ACCOUNT_ID')) return state.transactions.filter(row => row.TRANSACTION_ID === binds[0] && row.ACCOUNT_ID === binds[1]);
      if (sql.startsWith('SELECT BALANCE,AVAILABLE_BALANCE,CURRENCY FROM BANKCORE.BANK_ACCOUNT')) return [{ BALANCE: state.balance, AVAILABLE_BALANCE: state.available, CURRENCY: 'GBP' }];
      throw new Error(`Unexpected Db2 query: ${sql}`);
    }
  };
}

function oracleMock({ status = 'VERIFIED', risk = 'LOW', rowsAffected = 1 } = {}) {
  const state = { customerId: '100002', kycRecordId: 'KYC-100002', status, risk, updates: 0, commits: 0, rollbacks: 0 };
  return { state, close: async () => {}, commit: async () => { state.commits++; }, rollback: async () => { state.rollbacks++; },
    execute: async (sql, binds) => {
      if (sql.startsWith('SELECT CUSTOMER_ID,KYC_RECORD_ID')) return { rows: [[state.customerId, state.kycRecordId, state.status, state.risk, '2026-01-01']] };
      if (sql.startsWith('UPDATE BANKCRM.CUSTOMER_KYC')) {
        state.updates++;
        if (rowsAffected === 1) { state.status = binds.status; state.risk = binds.risk; }
        return { rowsAffected };
      }
      throw new Error(`Unexpected Oracle SQL: ${sql}`);
    }
  };
}

function memoryStore({ failTransactionSave = false } = {}) {
  const state = { transaction: null, baseline: null, baselineWrites: 0 };
  return { state,
    saveTransaction: async value => { if (failTransactionSave) throw new Error('disk full'); state.transaction = value; },
    loadTransaction: async customerId => state.transaction && String(state.transaction.customerId) === String(customerId) ? state.transaction : null,
    saveKycBaseline: async value => { if (!state.baseline) { state.baseline = value; state.baselineWrites++; } return state.baseline; },
    loadKycBaseline: async customerId => { if (!state.baseline) return null; if (String(state.baseline.customerId) !== String(customerId)) throw new Error('baseline customer mismatch'); return state.baseline; }
  };
}

function demo(overrides = {}) {
  let n = 0;
  return createDemoService({ db2Schema: 'BANKCORE', oracleSchema: 'BANKCRM', customerId: '100002', accountId: 'AC1000021', amount: 200, currency: 'GBP',
    makeId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, ...overrides });
}

test('demo status reads linked account, recent transactions, and Oracle KYC without writes', async () => {
  const db2 = db2Mock(); const oracle = oracleMock();
  const result = await demo().status(db2, oracle);
  assert.equal(result.customer.CUSTOMER_ID, '100002');
  assert.equal(result.customer.ACCOUNT_ID, 'AC1000021');
  assert.deepEqual(result.transactions, []);
  assert.equal(result.kyc[2], 'VERIFIED');
  assert.equal(db2.state.commits, 0);
  assert.equal(oracle.state.updates, 0);
});

test('each intentional transaction is committed, assigned a unique ID, and recorded with confirmed balances and timestamp', async () => {
  const db2 = db2Mock(); const store = memoryStore(); const service = demo({ stateStore: store });
  const first = await service.transaction(db2);
  const second = await service.transaction(db2);
  assert.notEqual(first.transactionId, second.transactionId);
  assert.match(db2.state.transactions[0].TRANSACTION_TYPE, /^WITHDRAWAL$/);
  assert.deepEqual([first.previousBalance, first.newBalance, second.previousBalance, second.newBalance], [4381, 4181, 4181, 3981]);
  assert.equal(store.state.transaction.transactionId, second.transactionId);
  assert.equal(store.state.transaction.transactionTimestamp, '2026-10-27 12:00:00');
  assert.ok(store.state.transaction.completionTimestamp);
  assert.deepEqual([store.state.transaction.previousAvailableBalance, store.state.transaction.newAvailableBalance], [4181, 3981]);
  assert.equal(db2.state.commits, 2);
});

test('a local transaction-record failure after commit reports committed ID and does not roll back the withdrawal', async () => {
  const db2 = db2Mock(); const service = demo({ stateStore: memoryStore({ failTransactionSave: true }) });
  await assert.rejects(service.transaction(db2), error => /Withdrawal was committed/.test(error.message) && Boolean(error.committedTransaction?.transactionId));
  assert.equal(db2.state.commits, 1);
  assert.equal(db2.state.rollbacks, 0);
  assert.equal(db2.state.transactions.length, 1);
});

test('transaction-only verification checks the recorded exact transaction and deductions, tolerating later balance activity', async () => {
  const db2 = db2Mock(); const store = memoryStore(); const service = demo({ stateStore: store });
  const committed = await service.transaction(db2);
  db2.state.balance -= 25; db2.state.available -= 25;
  const result = await service.verify(db2, null, 'transaction', store.state.transaction);
  assert.equal(result.passed, true);
  assert.equal(result.transaction.record.transactionId, committed.transactionId);
  assert.equal(result.transaction.recordedDeductionValid, true);
  assert.equal(result.transaction.currentMatchesRecordedAfter, false);
  assert.ok(db2.state.queries.some(sql => /WHERE TRANSACTION_ID=\? AND ACCOUNT_ID=\?/.test(sql)));
});

test('API verification source snapshot reads the exact recorded withdrawal, linked account, and Oracle KYC without writes', async () => {
  const db2 = db2Mock(); const oracle = oracleMock(); const store = memoryStore(); const service = demo({ stateStore: store });
  const committed = await service.transaction(db2);
  const db2Commits = db2.state.commits; const oracleUpdates = oracle.state.updates;
  const snapshot = await service.readApiVerificationSources(db2, oracle, store.state.transaction);
  assert.equal(snapshot.customerId, '100002');
  assert.equal(snapshot.accountId, 'AC1000021');
  assert.equal(snapshot.balance, 4181);
  assert.equal(snapshot.transaction.id, committed.transactionId);
  assert.equal(snapshot.transaction.amount, 200);
  assert.deepEqual(snapshot.kyc, { customerId: '100002', status: 'VERIFIED', riskRating: 'LOW' });
  assert.equal(db2.state.commits, db2Commits);
  assert.equal(oracle.state.updates, oracleUpdates);
  assert.ok(db2.state.queries.some(sql => /WHERE TRANSACTION_ID=\? AND ACCOUNT_ID=\?/.test(sql)));
});

test('KYC-only and combined verification select only the requested stages', async () => {
  const db2 = db2Mock(); const store = memoryStore(); const service = demo({ stateStore: store });
  const oracle = oracleMock({ status: 'REVIEW_REQUIRED', risk: 'HIGH' });
  const kyc = await service.verify(null, oracle, 'kyc');
  assert.equal(kyc.passed, true);
  assert.equal('transaction' in kyc, false);
  const withdrawal = await service.transaction(db2);
  const all = await service.verify(db2, oracle, 'all', store.state.transaction);
  assert.equal(all.passed, true);
  assert.equal(all.transaction.record.transactionId, withdrawal.transactionId);
  assert.equal(all.kyc.passed, true);
});

test('missing and inconsistent local transaction records fail safely', async () => {
  const db2 = db2Mock();
  const missing = await demo().verifyTransaction(db2, null);
  assert.equal(missing.passed, false);
  const invalid = await demo().verifyTransaction(db2, { customerId: '100002', transactionId: 'RT-bad' });
  assert.equal(invalid.passed, false);
});

test('KYC baseline is captured from Oracle once, preserved across updates, and reset restores that baseline', async () => {
  const store = memoryStore(); const service = demo({ stateStore: store }); const oracle = oracleMock({ status: 'PENDING', risk: 'MEDIUM' });
  const first = await service.setKyc(oracle);
  await service.setKyc(oracle);
  assert.deepEqual([store.state.baseline.kycStatus, store.state.baseline.riskRating], ['PENDING', 'MEDIUM']);
  assert.equal(store.state.baselineWrites, 1);
  assert.deepEqual([first.current.status, first.current.riskRating], ['REVIEW_REQUIRED', 'HIGH']);
  const preview = await service.currentKyc(oracle);
  const reset = await service.resetKyc(oracle, preview);
  assert.equal(reset.changed, true);
  assert.deepEqual([oracle.state.status, oracle.state.risk], ['PENDING', 'MEDIUM']);
  const repeated = await service.resetKyc(oracle, await service.currentKyc(oracle));
  assert.equal(repeated.changed, false);
});

test('KYC update does not proceed when saving the original baseline fails', async () => {
  const oracle = oracleMock();
  const store = { loadKycBaseline: async () => null, saveKycBaseline: async () => { throw new Error('disk full'); } };
  await assert.rejects(demo({ stateStore: store }).setKyc(oracle), /disk full/);
  assert.equal(oracle.state.updates, 0);
});

test('KYC baseline mismatch and reset conflict are rejected without overwriting original values', async () => {
  const store = memoryStore(); const service = demo({ stateStore: store }); const oracle = oracleMock();
  await service.setKyc(oracle);
  const preview = await service.currentKyc(oracle);
  oracle.state.status = 'PENDING'; oracle.state.risk = 'LOW';
  await assert.rejects(service.resetKyc(oracle, preview), /changed after confirmation preview/);
  await assert.rejects(service.resetKyc(oracle, await service.currentKyc(oracle)), /no longer matches the demo values/);
  assert.equal(oracle.state.updates, 1);
  assert.deepEqual([store.state.baseline.kycStatus, store.state.baseline.riskRating], ['VERIFIED', 'LOW']);
});

test('KYC reset requires an explicit matching confirmation', async () => {
  let invoked = false;
  await assert.rejects(confirmAction({ expected: 'RESET KYC 100002', action: 'reset KYC', ask: async () => 'no' }), /Confirmation did not match/);
  await assert.rejects(confirmAction({ expected: 'RESET KYC 100002', action: 'reset KYC', ask: async () => { invoked = true; return 'RESET KYC 100002'; }, interactive: false }), /Interactive confirmation is required/);
  assert.equal(invoked, false);
  await confirmAction({ expected: 'RESET KYC 100002', action: 'reset KYC', ask: async () => 'RESET KYC 100002' });
});

test('local state files are created, preserve a KYC baseline, and reject corrupt or invalid records', async t => {
  const runtimeDir = path.join(__dirname, '..', 'runtime', `test-${randomUUID()}`);
  await fs.mkdir(runtimeDir, { recursive: true });
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const store = createDemoStateStore({ runtimeDir });
  const baseline = { version: 1, customerId: '100002', kycRecordId: 'KYC-100002', kycStatus: 'VERIFIED', riskRating: 'LOW', capturedAt: '2026-10-27T00:00:00.000Z' };
  await store.saveKycBaseline(baseline);
  const preserved = await store.saveKycBaseline({ ...baseline, kycStatus: 'REVIEW_REQUIRED', riskRating: 'HIGH' });
  assert.equal(preserved.kycStatus, 'VERIFIED');
  assert.equal((await store.loadKycBaseline('100002')).riskRating, 'LOW');
  await fs.writeFile(store.baselinePath('100002'), JSON.stringify({ ...baseline, customerId: '100003' }));
  await assert.rejects(store.loadKycBaseline('100002'), /different customer/);
  const transactionRecord = { version: 1, customerId: '100002', accountId: 'AC1000021', transactionId: 'RT-00000000-0000-4000-8000-000000000001', amount: 200, currency: 'GBP', previousBalance: 1000, newBalance: 800, previousAvailableBalance: 1000, newAvailableBalance: 800, transactionTimestamp: '2026-10-27 12:00:00', completionTimestamp: '2026-10-27T12:00:01.000Z' };
  await store.saveTransaction(transactionRecord);
  assert.deepEqual(await store.loadTransaction('100002'), transactionRecord);
  await fs.writeFile(store.transactionPath, '{bad json');
  await assert.rejects(store.loadTransaction('100002'), /invalid JSON/);
  await fs.writeFile(store.transactionPath, JSON.stringify({ version: 1, customerId: '100002', accountId: 'AC1000021', transactionId: 'RT-bad', amount: 200, currency: 'GBP' }));
  await assert.rejects(store.loadTransaction('100002'), /missing required fields or is inconsistent/);
});

test('KYC reset refuses to guess when no reliable baseline exists', async () => {
  const store = memoryStore();
  await assert.rejects(demo({ stateStore: store }).resetKyc(oracleMock()), /No reliable KYC baseline/);
});

test('the demo withdrawal remains fixed at GBP 200', () => {
  assert.throws(() => demo({ amount: 50 }), /fixed at GBP 200/);
  assert.throws(() => demo({ currency: 'USD' }), /fixed at GBP 200/);
});
