const test = require('node:test');
const assert = require('node:assert/strict');
const { createDemoService } = require('../src/customer360-demo');

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
        if (sql.includes('ORDER BY TRANSACTION_TIMESTAMP DESC,TRANSACTION_ID DESC')) return state.transactions.filter(row => row.TRANSACTION_TYPE === 'WITHDRAWAL' && row.TRANSACTION_STAGE === 'POSTED' && row.TRANSACTION_STATUS === 'COMPLETED').sort((a, b) => String(b.TRANSACTION_TIMESTAMP).localeCompare(String(a.TRANSACTION_TIMESTAMP)) || String(b.TRANSACTION_ID).localeCompare(String(a.TRANSACTION_ID))).slice(0, 1);
      if (sql.startsWith('SELECT TRANSACTION_ID,TRANSACTION_TYPE')) return [...state.transactions].sort((a, b) => String(b.TRANSACTION_TIMESTAMP).localeCompare(String(a.TRANSACTION_TIMESTAMP))).slice(0, 10);
      if (sql.startsWith('SELECT TRANSACTION_ID,ACCOUNT_ID')) return state.transactions.filter(row => row.TRANSACTION_ID === binds[0] && row.ACCOUNT_ID === binds[1]);
      if (sql.startsWith('SELECT BALANCE,AVAILABLE_BALANCE,CURRENCY FROM BANKCORE.BANK_ACCOUNT')) return [{ BALANCE: state.balance, AVAILABLE_BALANCE: state.available, CURRENCY: 'GBP' }];
      throw new Error(`Unexpected Db2 query: ${sql}`);
    }
  };
}

function concurrentDb2Mock(balance = '100.00') {
  const toCents = value => { const [whole, fraction = ''] = String(value).split('.'); return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)); };
  const money = value => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  const state = { balance: toCents(balance), available: toCents(balance), transactions: [], commits: 0 };
  let lockTail = Promise.resolve();
  function connection() {
    let releaseLock; let before; let pending;
    return { close: async () => {}, beginTransaction: async () => {},
      commit: async () => { if (pending) state.transactions.push(pending); state.commits++; pending = null; releaseLock?.(); releaseLock = null; },
      rollback: async () => { if (before) { state.balance = before.balance; state.available = before.available; } pending = null; releaseLock?.(); releaseLock = null; },
      query: async (sql, binds = []) => {
        if (sql.includes('JOIN BANKCORE.ACCOUNT_CUSTOMER_RELATIONSHIP')) return [{ CUSTOMER_ID: '100002', CUSTOMER_NAME: 'Demo Customer', CUSTOMER_STATUS: 'ACTIVE', ACCOUNT_ID: 'AC1000021', CURRENCY: 'GBP', ACCOUNT_STATUS: 'ACTIVE', BALANCE: money(state.balance), AVAILABLE_BALANCE: money(state.available) }];
        if (sql.includes('FROM BANKCORE.BANK_ACCOUNT WHERE ACCOUNT_ID=? FOR UPDATE')) {
          const previous = lockTail; let unlock;
          lockTail = new Promise(resolve => { unlock = resolve; });
          await previous;
          releaseLock = unlock;
          before = { balance: state.balance, available: state.available };
          return [{ ACCOUNT_ID: 'AC1000021', CURRENCY: 'GBP', ACCOUNT_STATUS: 'ACTIVE', BALANCE: money(state.balance), AVAILABLE_BALANCE: money(state.available) }];
        }
        if (sql.startsWith('INSERT INTO BANKCORE.ACCOUNT_TRANSACTION')) {
          pending = { TRANSACTION_ID: binds[0], ACCOUNT_ID: binds[1], TRANSACTION_AMOUNT: binds[2], CURRENCY: binds[3],
            TRANSACTION_TYPE: 'WITHDRAWAL', TRANSACTION_STAGE: 'POSTED', TRANSACTION_STATUS: 'COMPLETED', TRANSACTION_TIMESTAMP: '2026-10-27 12:00:00' };
          return { count: 1 };
        }
        if (sql.startsWith('UPDATE BANKCORE.BANK_ACCOUNT')) {
          const cents = toCents(binds[0]);
          if (state.balance < cents || state.available < cents) return { count: 0 };
          state.balance -= cents; state.available -= cents;
          return { count: 1 };
        }
        if (sql.startsWith('SELECT BALANCE,AVAILABLE_BALANCE FROM BANKCORE.BANK_ACCOUNT')) return [{ BALANCE: money(state.balance), AVAILABLE_BALANCE: money(state.available) }];
        if (sql.startsWith('SELECT TRANSACTION_TIMESTAMP FROM BANKCORE.ACCOUNT_TRANSACTION')) return [{ TRANSACTION_TIMESTAMP: '2026-10-27 12:00:00' }];
        throw new Error(`Unexpected concurrent Db2 query: ${sql}`);
      }
    };
  }
  return { state, connection };
}

function oracleMock({ status = 'VERIFIED', risk = 'LOW', rowsAffected = 1, beforeUpdate } = {}) {
  const state = { customerId: '100002', kycRecordId: 'KYC-100002', status, risk, updates: 0, commits: 0, rollbacks: 0, readCustomerIds: [] };
  return { state, close: async () => {}, commit: async () => { state.commits++; }, rollback: async () => { state.rollbacks++; },
    execute: async (sql, binds) => {
      if (sql.startsWith('SELECT CUSTOMER_ID,KYC_RECORD_ID')) { state.readCustomerIds.push(binds.customerId); return { rows: [[state.customerId, state.kycRecordId, state.status, state.risk, '2026-01-01']] }; }
      if (sql.startsWith('UPDATE BANKCRM.CUSTOMER_KYC')) {
        state.updates++;
        beforeUpdate?.(state, binds);
        if (state.status !== binds.previousStatus || state.risk !== binds.previousRisk) return { rowsAffected: 0 };
        if (rowsAffected === 1) { state.status = binds.status; state.risk = binds.risk; }
        return { rowsAffected };
      }
      throw new Error(`Unexpected Oracle SQL: ${sql}`);
    }
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

test('withdrawal account reader is exposed and resolves the configured customer-account relationship', async () => {
  const db2 = db2Mock();
  const result = await demo().readWithdrawalAccount(db2);
  assert.deepEqual(result, {
    customerId: '100002', accountId: 'AC1000021', customerName: 'Demo Customer', accountStatus: 'ACTIVE',
    currency: 'GBP', balance: 4381, availableBalance: 4381
  });
  assert.match(db2.state.queries[0], /JOIN BANKCORE\.ACCOUNT_CUSTOMER_RELATIONSHIP/);
});

test('each intentional transaction is committed with unique IDs and actual before/after balances, without local transaction state', async () => {
  const db2 = db2Mock(); const service = demo();
  const first = await service.transaction(db2);
  const second = await service.transaction(db2);
  assert.notEqual(first.transactionId, second.transactionId);
  assert.match(db2.state.transactions[0].TRANSACTION_TYPE, /^WITHDRAWAL$/);
  assert.deepEqual([first.previousBalance, first.newBalance, second.previousBalance, second.newBalance], ['4381.00', '4181.00', '4181.00', '3981.00']);
  assert.equal(second.transactionId, db2.state.transactions[1].TRANSACTION_ID);
  assert.equal(second.transactionTimestamp, '2026-10-27 12:00:00');
  assert.deepEqual([second.previousAvailableBalance, second.newAvailableBalance], ['4181.00', '3981.00']);
  assert.equal(db2.state.commits, 2);
});

test('withdrawal accepts a two-decimal amount and verification checks the recorded amount dynamically', async () => {
  const db2 = db2Mock(); const service = demo();
  const result = await service.transaction(db2, '123.45');
  assert.equal(result.amount, '123.45');
  assert.equal(result.previousBalance, '4381.00');
  assert.equal(result.newBalance, '4257.55');
  assert.equal(db2.state.transactions[0].TRANSACTION_AMOUNT, '123.45');
  const verified = await service.verifyTransaction(db2, result.transactionId);
  assert.equal(verified.passed, true);
  assert.equal(verified.transactionValid, true);
  assert.equal(verified.account.BALANCE, 4257.55);
});

test('withdrawal above available balance rolls back without inserting a transaction', async () => {
  const db2 = db2Mock({ balance: 500, available: 99.99 });
  await assert.rejects(demo().transaction(db2, '100.00'), /exceeds available balance/);
  assert.equal(db2.state.transactions.length, 0);
  assert.equal(db2.state.rollbacks, 1);
});

test('concurrent withdrawals serialize on the account lock and each reports the committed balances it actually used', async () => {
  const shared = concurrentDb2Mock('100.00'); const service = demo();
  const [first, second] = await Promise.all([
    service.transaction(shared.connection(), '40.10'),
    service.transaction(shared.connection(), '40.10')
  ]);
  const ranges = [[first.previousBalance, first.newBalance], [second.previousBalance, second.newBalance]];
  assert.deepEqual(ranges.sort((a, b) => Number(b[0]) - Number(a[0])), [['100.00', '59.90'], ['59.90', '19.80']]);
  assert.equal(shared.state.balance, 1980n);
  assert.equal(shared.state.available, 1980n);
  assert.equal(shared.state.transactions.length, 2);
});

test('concurrent withdrawals cannot overspend available funds', async () => {
  const shared = concurrentDb2Mock('100.00'); const service = demo();
  const outcomes = await Promise.allSettled([
    service.transaction(shared.connection(), '60.00'),
    service.transaction(shared.connection(), '60.00')
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  assert.equal(shared.state.balance, 4000n);
  assert.equal(shared.state.available, 4000n);
  assert.equal(shared.state.transactions.length, 1);
});

test('transaction execution and exact verification do not require a local transaction JSON record', async () => {
  const db2 = db2Mock(); const service = demo();
  const result = await service.transaction(db2, '19.87');
  const verification = await service.verifyTransaction(db2, result.transactionId);
  assert.equal(db2.state.commits, 1);
  assert.equal(db2.state.rollbacks, 0);
  assert.equal(db2.state.transactions.length, 1);
  assert.equal(verification.passed, true);
  assert.equal(verification.transaction.TRANSACTION_AMOUNT, '19.87');
});

test('transaction-only verification checks the recorded exact transaction and deductions, tolerating later balance activity', async () => {
  const db2 = db2Mock(); const service = demo();
  const committed = await service.transaction(db2);
  db2.state.balance -= 25; db2.state.available -= 25;
  const result = await service.verifyTransaction(db2, committed.transactionId);
  assert.equal(result.passed, true);
  assert.equal(result.transaction.TRANSACTION_ID, committed.transactionId);
  assert.equal(result.account.BALANCE, 4156);
  assert.ok(db2.state.queries.some(sql => /WHERE TRANSACTION_ID=\? AND ACCOUNT_ID=\?/.test(sql)));
});

test('API verification source snapshot reads the exact recorded withdrawal, linked account, and Oracle KYC without writes', async () => {
  const db2 = db2Mock(); const oracle = oracleMock(); const service = demo();
  const committed = await service.transaction(db2);
  const db2Commits = db2.state.commits; const oracleUpdates = oracle.state.updates;
  const snapshot = await service.readApiVerificationSources(db2, oracle, committed.transactionId);
  assert.equal(snapshot.customerId, '100002');
  assert.equal(snapshot.accountId, 'AC1000021');
  assert.equal(snapshot.balance, 4181);
  assert.equal(snapshot.transaction.id, committed.transactionId);
  assert.equal(snapshot.transaction.amount, '200.00');
  assert.deepEqual(snapshot.kyc, { customerId: '100002', status: 'VERIFIED', riskRating: 'LOW' });
  assert.equal(db2.state.commits, db2Commits);
  assert.equal(oracle.state.updates, oracleUpdates);
  assert.ok(db2.state.queries.some(sql => /WHERE TRANSACTION_ID=\? AND ACCOUNT_ID=\?/.test(sql)));
});

test('API verification source reads current Oracle KYC after update and reset rather than using its baseline', async () => {
  const db2 = db2Mock(); const oracle = oracleMock(); const service = demo();
  const tx = await service.transaction(db2, '15.00');
  await service.setKyc(oracle);
  const updated = await service.readApiVerificationSources(db2, oracle, tx.transactionId);
  assert.deepEqual(updated.kyc, { customerId: '100002', status: 'REVIEW_REQUIRED', riskRating: 'HIGH' });
  const reset = await service.resetKyc(oracle, await service.currentKyc(oracle));
  assert.equal(reset.changed, true);
  const restored = await service.readApiVerificationSources(db2, oracle, tx.transactionId);
  assert.deepEqual(restored.kyc, { customerId: '100002', status: 'VERIFIED', riskRating: 'LOW' });
});

test('KYC-only and combined verification select only the requested stages', async () => {
  const db2 = db2Mock(); const service = demo();
  const oracle = oracleMock({ status: 'REVIEW_REQUIRED', risk: 'HIGH' });
  const kyc = await service.verify(null, oracle, 'kyc');
  assert.equal(kyc.passed, true);
  assert.equal('transaction' in kyc, false);
  const withdrawal = await service.transaction(db2);
  const all = await service.verify(db2, oracle, 'all', withdrawal.transactionId);
  assert.equal(all.passed, true);
  assert.equal(all.transaction.transaction.TRANSACTION_ID, withdrawal.transactionId);
  assert.equal(all.kyc.passed, true);
});

test('KYC verification distinguishes live retrieval from a recognized demo state', async () => {
  const service = demo();
  const expectedBaseline = await service.verifyKyc(oracleMock({ status: 'VERIFIED', risk: 'LOW' }));
  assert.equal(expectedBaseline.retrieved, true);
  assert.equal(expectedBaseline.expectedState, 'fixed demo baseline');
  assert.equal(expectedBaseline.passed, true);
  const unexpected = await service.verifyKyc(oracleMock({ status: 'VERIFIED', risk: 'MEDIUM' }));
  assert.equal(unexpected.retrieved, true);
  assert.equal(unexpected.expectedState, 'unexpected state');
  assert.equal(unexpected.passed, false);
});

test('KYC reads remain targeted at customer 100002 even when the transaction demo uses another customer', async () => {
  const service = demo({ customerId: '100011', kycCustomerId: '100002' });
  const oracle = oracleMock();
  const current = await service.currentKyc(oracle);
  assert.equal(current.customerId, '100002');
  assert.deepEqual(oracle.state.readCustomerIds, [100002]);
  assert.equal(oracle.state.customerId, '100002');
});

test('transaction verification selects latest posted withdrawal or an explicitly requested transaction ID', async () => {
  const db2 = db2Mock();
  const service = demo();
  const first = await service.transaction(db2, '12.10');
  const second = await service.transaction(db2, '8.20');
  const latest = await service.verifyTransaction(db2);
  const exact = await service.verifyTransaction(db2, first.transactionId);
  assert.equal(latest.transaction.TRANSACTION_ID, second.transactionId);
  assert.equal(latest.passed, true);
  assert.equal(exact.transaction.TRANSACTION_ID, first.transactionId);
  assert.equal(exact.passed, true);
});

test('KYC update and reset use only live Oracle state and do not need local JSON', async () => {
  const service = demo(); const oracle = oracleMock();
  const preview = await service.currentKyc(oracle);
  const first = await service.setKyc(oracle, preview);
  assert.deepEqual([first.previous.status, first.previous.riskRating], ['VERIFIED', 'LOW']);
  assert.deepEqual([first.current.status, first.current.riskRating], ['REVIEW_REQUIRED', 'HIGH']);
  assert.deepEqual([oracle.state.status, oracle.state.risk], ['REVIEW_REQUIRED', 'HIGH']);
  assert.equal(first.changed, true);
  assert.equal(oracle.state.commits, 1);
  assert.equal('baseline' in first, false);
  const alreadyUpdated = await service.setKyc(oracle, await service.currentKyc(oracle));
  assert.equal(alreadyUpdated.changed, false);
  assert.equal(oracle.state.updates, 1);
  const resetPreview = await service.currentKyc(oracle);
  const reset = await service.resetKyc(oracle, resetPreview);
  assert.equal(reset.changed, true);
  assert.deepEqual([reset.current.status, reset.current.riskRating], ['VERIFIED', 'LOW']);
  assert.deepEqual([oracle.state.status, oracle.state.risk], ['VERIFIED', 'LOW']);
  assert.equal(oracle.state.commits, 2);
  assert.equal((await service.resetKyc(oracle, await service.currentKyc(oracle))).changed, false);
  assert.equal(oracle.state.updates, 2);
});

test('KYC update accepts arbitrary live states and reset returns them to the confirmed fixed demo baseline without local JSON', async () => {
  const service = demo(); const oracle = oracleMock({ status: 'EXPIRED', risk: 'MEDIUM' });
  const preview = await service.currentKyc(oracle);
  const update = await service.setKyc(oracle, preview);
  assert.deepEqual([update.previous.status, update.previous.riskRating], ['EXPIRED', 'MEDIUM']);
  assert.deepEqual([update.current.status, update.current.riskRating], ['REVIEW_REQUIRED', 'HIGH']);
  const resetPreview = await service.currentKyc(oracle);
  const reset = await service.resetKyc(oracle, resetPreview);
  assert.deepEqual([reset.current.status, reset.current.riskRating], ['VERIFIED', 'LOW']);
  assert.equal(oracle.state.updates, 2);
  assert.equal(oracle.state.commits, 2);
});

test('KYC optimistic guard rejects a concurrent change between read and update', async () => {
  const service = demo();
  const oracle = oracleMock({ beforeUpdate: state => { state.status = 'PENDING'; state.risk = 'MEDIUM'; } });
  const preview = await service.currentKyc(oracle);
  await assert.rejects(service.setKyc(oracle, preview), /changed since it was read/);
  assert.deepEqual([oracle.state.status, oracle.state.risk], ['PENDING', 'MEDIUM']);
  assert.equal(oracle.state.commits, 0);
  assert.equal(oracle.state.rollbacks, 1);
});

test('KYC command guards against state changing after the confirmation preview', async () => {
  const service = demo(); const oracle = oracleMock();
  const preview = await service.currentKyc(oracle);
  oracle.state.status = 'PENDING'; oracle.state.risk = 'MEDIUM';
  await assert.rejects(service.setKyc(oracle, preview), /changed after confirmation preview/);
  assert.equal(oracle.state.updates, 0);
});

test('configured withdrawal amount accepts a positive GBP value with two decimal precision', () => {
  assert.doesNotThrow(() => demo({ amount: '17.25' }));
  assert.throws(() => demo({ amount: '0' }), /greater than zero/);
  assert.throws(() => demo({ currency: 'USD' }), /currency must be GBP/);
});
