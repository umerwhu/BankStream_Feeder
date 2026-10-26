const test = require('node:test');
const assert = require('node:assert/strict');
const { createDemoService } = require('../src/customer360-demo');

function relationship(state) {
  return { CUSTOMER_ID: '100002', CUSTOMER_NAME: 'Demo Customer', CUSTOMER_STATUS: 'ACTIVE', OWNERSHIP_ROLE: 'PRIMARY',
    EFFECTIVE_FROM: '2020-01-01', EFFECTIVE_TO: null, ACCOUNT_ID: 'AC1000021', ACCOUNT_NUMBER: '••••0001', ACCOUNT_TYPE: 'CHECKING',
    CURRENCY: 'GBP', ACCOUNT_STATUS: 'ACTIVE', BALANCE: state.balance, AVAILABLE_BALANCE: state.available };
}

function db2Mock({ balance = 4381, available = balance, failUpdate = false } = {}) {
  const state = { balance, available, inserts: [], committed: 0, rolledBack: 0, locked: false };
  return { state,
    beginTransaction: async () => { state.locked = true; },
    commit: async () => { state.committed++; state.locked = false; },
    rollback: async () => { state.rolledBack++; state.locked = false; },
    close: async () => {},
    query: async (sql, binds = []) => {
      if (sql.includes('JOIN BANKCORE.ACCOUNT_CUSTOMER_RELATIONSHIP')) return [relationship(state)];
      if (sql.includes('FROM BANKCORE.BANK_ACCOUNT WHERE ACCOUNT_ID=? FOR UPDATE')) return [{ ACCOUNT_ID: 'AC1000021', CURRENCY: 'GBP', ACCOUNT_STATUS: 'ACTIVE', BALANCE: state.balance, AVAILABLE_BALANCE: state.available }];
      if (sql.startsWith('INSERT INTO BANKCORE.ACCOUNT_TRANSACTION')) {
        assert.equal(state.locked, true);
        state.inserts.push({ transactionId: binds[0], amount: binds[2], currency: binds[3], reference: binds[4], sql });
        return { count: 1 };
      }
      if (sql.startsWith('UPDATE BANKCORE.BANK_ACCOUNT')) {
        if (failUpdate) return { count: 0 };
        state.balance -= binds[0]; state.available -= binds[1];
        return { count: 1 };
      }
      if (sql.startsWith('SELECT TRANSACTION_ID,TRANSACTION_TYPE')) return [];
      if (sql.startsWith('SELECT TRANSACTION_ID,ACCOUNT_ID')) return state.inserts.length ? [{
        TRANSACTION_ID: state.inserts.at(-1).transactionId, ACCOUNT_ID: 'AC1000021', TRANSACTION_TYPE: 'WITHDRAWAL',
        TRANSACTION_STAGE: 'POSTED', TRANSACTION_STATUS: 'COMPLETED', TRANSACTION_AMOUNT: '200', CURRENCY: 'GBP',
        TRANSACTION_TIMESTAMP: '2026-10-26 12:00:00', COUNTERPARTY_REFERENCE: state.inserts.at(-1).reference
      }] : [];
      throw new Error(`Unexpected Db2 query: ${sql}`);
    }
  };
}

function oracleMock({ status = 'VERIFIED', risk = 'LOW' } = {}) {
  const state = { status, risk, updated: 0, committed: 0, rolledBack: 0 };
  return { state, close: async () => {}, commit: async () => { state.committed++; }, rollback: async () => { state.rolledBack++; },
    execute: async (sql, binds) => {
      if (sql.startsWith('SELECT CUSTOMER_ID,KYC_RECORD_ID')) return { rows: [['100002', 'KYC-100002', state.status, state.risk, '2026-01-01']] };
      if (sql.startsWith('UPDATE BANKCRM.CUSTOMER_KYC')) { state.status = binds.status; state.risk = binds.risk; state.updated++; return { rowsAffected: 1 }; }
      throw new Error(`Unexpected Oracle SQL: ${sql}`);
    }
  };
}

const service = overrides => createDemoService({ db2Schema: 'BANKCORE', oracleSchema: 'BANKCRM', customerId: '100002', accountId: 'AC1000021', amount: 200, currency: 'GBP', makeId: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })(), ...overrides });

test('demo status reads linked account, recent transactions, and Oracle KYC without writes', async () => {
  const db2 = db2Mock(); const oracle = oracleMock();
  const result = await service().status(db2, oracle);
  assert.equal(result.customer.CUSTOMER_ID, '100002');
  assert.equal(result.customer.ACCOUNT_ID, 'AC1000021');
  assert.deepEqual(result.transactions, []);
  assert.equal(result.kyc[2], 'VERIFIED');
  assert.equal(db2.state.committed, 0);
  assert.equal(db2.state.rolledBack, 0);
  assert.equal(oracle.state.updated, 0);
});

test('each intentional demo transaction creates a unique posted withdrawal and debits latest balances atomically', async () => {
  const db2 = db2Mock(); const demo = service();
  const first = await demo.transaction(db2);
  const second = await demo.transaction(db2);
  assert.notEqual(first.transactionId, second.transactionId);
  assert.equal(db2.state.inserts.length, 2);
  assert.match(db2.state.inserts[0].sql, /'WITHDRAWAL','POSTED','COMPLETED'/);
  assert.deepEqual([db2.state.inserts[0].amount, db2.state.inserts[0].currency], [200, 'GBP']);
  assert.deepEqual([first.previousBalance, first.newBalance, second.previousBalance, second.newBalance], [4381, 4181, 4181, 3981]);
  assert.deepEqual([db2.state.balance, db2.state.available, db2.state.committed], [3981, 3981, 2]);
});

test('withdrawal rolls back completely when the guarded account update affects no row', async () => {
  const db2 = db2Mock({ failUpdate: true });
  await assert.rejects(service().transaction(db2), /changed before the withdrawal/);
  assert.equal(db2.state.committed, 0);
  assert.equal(db2.state.rolledBack, 1);
});

test('withdrawal checks status, currency, and funds before inserting', async () => {
  const db2 = db2Mock({ balance: 199, available: 199 });
  await assert.rejects(service().transaction(db2), /Insufficient available balance/);
  assert.equal(db2.state.inserts.length, 0);
  assert.equal(db2.state.rolledBack, 1);
});

test('KYC update is repeatable, updates one existing record, and skips an already-complete state', async () => {
  const oracle = oracleMock(); const demo = service();
  const first = await demo.setKyc(oracle);
  const second = await demo.setKyc(oracle);
  assert.equal(first.changed, true);
  assert.deepEqual(first.previous, { status: 'VERIFIED', riskRating: 'LOW' });
  assert.deepEqual(first.current, { status: 'REVIEW_REQUIRED', riskRating: 'HIGH' });
  assert.equal(second.changed, false);
  assert.equal(oracle.state.updated, 1);
  assert.equal(oracle.state.committed, 1);
});

test('verify checks the latest demo withdrawal values and current account/KYC records', async () => {
  const db2 = db2Mock(); await service().transaction(db2);
  const oracle = oracleMock({ status: 'REVIEW_REQUIRED', risk: 'HIGH' });
  const result = await service().verify(db2, oracle);
  assert.equal(result.withdrawal.TRANSACTION_ID, db2.state.inserts[0].transactionId);
  assert.equal(result.transactionValid, true);
  assert.equal(result.account.BALANCE, 4181);
  assert.equal(result.kyc.valid, true);
});

test('demo rejects a configured withdrawal that would not be the required GBP 200', () => {
  assert.throws(() => service({ amount: 50 }), /fixed at GBP 200/);
  assert.throws(() => service({ currency: 'USD' }), /fixed at GBP 200/);
});
