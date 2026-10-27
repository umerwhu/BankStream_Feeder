const { randomUUID } = require('node:crypto');

const DEMO_REFERENCE_PREFIX = 'C360-DEMO:';
const DEFAULTS = Object.freeze({ customerId: '100002', accountId: 'AC1000021', amount: 200, currency: 'GBP' });

function schemaName(value, fallback, label) {
  const name = String(value || fallback).trim();
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(name)) throw new Error(`${label} must be a valid schema identifier`);
  return name.toUpperCase();
}

function createDemoService({ db2Schema = 'BANKCORE', oracleSchema = 'BANKCRM', customerId = DEFAULTS.customerId,
  accountId = DEFAULTS.accountId, amount = DEFAULTS.amount, currency = DEFAULTS.currency, makeId = randomUUID,
  stateStore } = {}) {
  const db2 = schemaName(db2Schema, 'BANKCORE', 'DB2I_SCHEMA');
  const oracle = schemaName(oracleSchema, 'BANKCRM', 'ORACLE_SCHEMA');
  const db2Table = name => `${db2}.${name}`;
  const oracleTable = name => `${oracle}.${name}`;
  const id = String(customerId).trim();
  const account = String(accountId).trim();
  const withdrawalAmount = Number(amount);
  const transactionCurrency = String(currency).trim().toUpperCase();
  if (!/^\d+$/.test(id)) throw new Error('DEMO_CUSTOMER_ID must contain digits only');
  if (!account || account.length > 30) throw new Error('DEMO_ACCOUNT_ID must contain 1 to 30 characters');
  if (withdrawalAmount !== 200 || transactionCurrency !== 'GBP') {
    throw new Error('The Customer 360 demo withdrawal is fixed at GBP 200; set DEMO_WITHDRAWAL_AMOUNT=200 and DEMO_CURRENCY=GBP');
  }

  async function customerAccount(dbConnection) {
    const rows = await dbConnection.query(
      `SELECT C.CUSTOMER_ID,C.CUSTOMER_NAME,C.CUSTOMER_STATUS,R.OWNERSHIP_ROLE,R.EFFECTIVE_FROM,R.EFFECTIVE_TO,A.ACCOUNT_ID,A.ACCOUNT_NUMBER,A.ACCOUNT_TYPE,A.CURRENCY,A.ACCOUNT_STATUS,A.BALANCE,A.AVAILABLE_BALANCE FROM ${db2Table('CUSTOMER')} C JOIN ${db2Table('ACCOUNT_CUSTOMER_RELATIONSHIP')} R ON R.CUSTOMER_ID=C.CUSTOMER_ID JOIN ${db2Table('BANK_ACCOUNT')} A ON A.ACCOUNT_ID=R.ACCOUNT_ID WHERE C.CUSTOMER_ID=? AND A.ACCOUNT_ID=? AND R.EFFECTIVE_FROM<=CURRENT_DATE AND (R.EFFECTIVE_TO IS NULL OR R.EFFECTIVE_TO>=CURRENT_DATE)`,
      [id, account]);
    if (!rows.length) throw new Error(`Customer ${id} has no active relationship to account ${account}`);
    if (rows.length > 1) throw new Error(`Customer/account relationship for ${id}/${account} is ambiguous`);
    return rows[0];
  }

  async function kycRecord(oracleConnection) {
    const result = await oracleConnection.execute(
      `SELECT CUSTOMER_ID,KYC_RECORD_ID,KYC_STATUS,RISK_RATING,LAST_UPDATED_TIMESTAMP FROM ${oracleTable('CUSTOMER_KYC')} WHERE CUSTOMER_ID=:customerId`,
      { customerId: Number(id) });
    const rows = result.rows || [];
    if (!rows.length) throw new Error(`Oracle KYC record for customer ${id} was not found`);
    if (rows.length > 1) throw new Error(`Oracle returned duplicate KYC records for customer ${id}; refusing an ambiguous update`);
    return rows[0];
  }

  async function status(dbConnection, oracleConnection) {
    const customer = await customerAccount(dbConnection);
    const transactions = await dbConnection.query(
      `SELECT TRANSACTION_ID,TRANSACTION_TYPE,TRANSACTION_STAGE,TRANSACTION_STATUS,TRANSACTION_AMOUNT,CURRENCY,TRANSACTION_TIMESTAMP FROM ${db2Table('ACCOUNT_TRANSACTION')} WHERE ACCOUNT_ID=? ORDER BY TRANSACTION_TIMESTAMP DESC FETCH FIRST 10 ROWS ONLY`,
      [account]);
    const kyc = await kycRecord(oracleConnection);
    return { customer, transactions, kyc };
  }

  async function transaction(dbConnection) {
    const relation = await customerAccount(dbConnection);
    if (String(relation.CUSTOMER_STATUS).trim().toUpperCase() !== 'ACTIVE') throw new Error(`Customer ${id} is not active`);

    await dbConnection.beginTransaction();
    let committed = false;
    let result;
    try {
      const lockedRows = await dbConnection.query(
        `SELECT ACCOUNT_ID,CURRENCY,ACCOUNT_STATUS,BALANCE,AVAILABLE_BALANCE FROM ${db2Table('BANK_ACCOUNT')} WHERE ACCOUNT_ID=? FOR UPDATE`,
        [account]);
      if (!lockedRows.length) throw new Error(`Account ${account} was not found`);
      const locked = lockedRows[0];
      const balance = Number(locked.BALANCE);
      const available = Number(locked.AVAILABLE_BALANCE);
      if (String(locked.ACCOUNT_STATUS).trim().toUpperCase() !== 'ACTIVE') throw new Error(`Account ${account} is not active`);
      if (String(locked.CURRENCY).trim().toUpperCase() !== transactionCurrency) throw new Error(`Account ${account} currency is not ${transactionCurrency}`);
      if (!Number.isFinite(balance) || !Number.isFinite(available)) throw new Error(`Account ${account} has an invalid balance`);
      if (available < withdrawalAmount || balance < withdrawalAmount) throw new Error(`Insufficient available balance in ${account}; available balance is ${available.toFixed(2)} ${transactionCurrency}`);

      const transactionId = `RT-${makeId()}`;
      const reference = `${DEMO_REFERENCE_PREFIX}${makeId()}`;
      await dbConnection.query(
        `INSERT INTO ${db2Table('ACCOUNT_TRANSACTION')} (TRANSACTION_ID,ACCOUNT_ID,TRANSACTION_TYPE,TRANSACTION_STAGE,TRANSACTION_STATUS,TRANSACTION_AMOUNT,CURRENCY,TRANSACTION_TIMESTAMP,CHANNEL,COUNTERPARTY_REFERENCE,LAST_UPDATED_TIMESTAMP) VALUES (?,?, 'WITHDRAWAL','POSTED','COMPLETED',?,?,CURRENT_TIMESTAMP,'BRANCH',?,CURRENT_TIMESTAMP)`,
        [transactionId, account, withdrawalAmount, transactionCurrency, reference]);
      const updated = await dbConnection.query(
        `UPDATE ${db2Table('BANK_ACCOUNT')} SET BALANCE=BALANCE-?,AVAILABLE_BALANCE=AVAILABLE_BALANCE-?,LAST_UPDATED_TIMESTAMP=CURRENT_TIMESTAMP WHERE ACCOUNT_ID=? AND ACCOUNT_STATUS='ACTIVE' AND CURRENCY=? AND BALANCE>=? AND AVAILABLE_BALANCE>=?`,
        [withdrawalAmount, withdrawalAmount, account, transactionCurrency, withdrawalAmount, withdrawalAmount]);
      if (Number.isFinite(updated?.count) && updated.count !== 1) throw new Error(`Account ${account} changed before the withdrawal could be applied`);
      const afterRows = await dbConnection.query(
        `SELECT BALANCE,AVAILABLE_BALANCE FROM ${db2Table('BANK_ACCOUNT')} WHERE ACCOUNT_ID=?`, [account]);
      const transactionRows = await dbConnection.query(
        `SELECT TRANSACTION_TIMESTAMP FROM ${db2Table('ACCOUNT_TRANSACTION')} WHERE TRANSACTION_ID=? AND ACCOUNT_ID=?`,
        [transactionId, account]);
      if (!afterRows.length || !transactionRows.length) throw new Error('Could not confirm the inserted transaction and updated account before commit');
      await dbConnection.commit();
      committed = true;
      result = { customerId: id, accountId: account, transactionId, reference, amount: withdrawalAmount, currency: transactionCurrency,
        previousBalance: balance, newBalance: Number(afterRows[0].BALANCE),
        previousAvailableBalance: available, newAvailableBalance: Number(afterRows[0].AVAILABLE_BALANCE),
        transactionTimestamp: String(transactionRows[0].TRANSACTION_TIMESTAMP).trim(), completionTimestamp: new Date().toISOString() };
    } catch (error) {
      if (!committed) try { await dbConnection.rollback(); } catch {}
      throw error;
    }
    if (stateStore) {
      try {
        await stateStore.saveTransaction({ version: 1, customerId: result.customerId, accountId: result.accountId,
          transactionId: result.transactionId, amount: result.amount, currency: result.currency,
          previousBalance: result.previousBalance, newBalance: result.newBalance,
          previousAvailableBalance: result.previousAvailableBalance, newAvailableBalance: result.newAvailableBalance,
          transactionTimestamp: result.transactionTimestamp, completionTimestamp: result.completionTimestamp });
      } catch (error) {
        const persistenceError = new Error(`Withdrawal was committed, but its local verification record could not be saved. Transaction ID: ${result.transactionId}. ${error.message}`);
        persistenceError.committedTransaction = result;
        persistenceError.cause = error;
        throw persistenceError;
      }
    }
    return result;
  }

  async function currentKyc(oracleConnection) {
    const record = await kycRecord(oracleConnection);
    return { customerId: String(record[0]).trim(), kycRecordId: String(record[1]).trim(), status: record[2], riskRating: record[3] ?? null };
  }

  async function setKyc(oracleConnection) {
    const current = await currentKyc(oracleConnection);
    let baseline = stateStore ? await stateStore.loadKycBaseline(id) : null;
    if (stateStore && !baseline) {
      baseline = await stateStore.saveKycBaseline({ version: 1, customerId: id, kycRecordId: current.kycRecordId,
        kycStatus: current.status, riskRating: current.riskRating, capturedAt: new Date().toISOString() });
    }
    if (baseline && baseline.kycRecordId !== current.kycRecordId) throw new Error(`Saved KYC baseline does not match the Oracle KYC record for customer ${id}`);
    const previous = { status: current.status, riskRating: current.riskRating };
    if (String(current.status).trim().toUpperCase() === 'REVIEW_REQUIRED' && String(current.riskRating).trim().toUpperCase() === 'HIGH') {
      return { changed: false, previous, current: { status: current.status, riskRating: current.riskRating }, baseline };
    }
    try {
      const update = await oracleConnection.execute(
        `UPDATE ${oracleTable('CUSTOMER_KYC')} SET KYC_STATUS=:status,RISK_RATING=:risk,LAST_UPDATED_TIMESTAMP=SYSTIMESTAMP WHERE CUSTOMER_ID=:customerId AND KYC_STATUS=:previousStatus AND ((RISK_RATING=:previousRisk) OR (RISK_RATING IS NULL AND :previousRisk IS NULL))`,
        { status: 'REVIEW_REQUIRED', risk: 'HIGH', customerId: Number(id), previousStatus: current.status, previousRisk: current.riskRating });
      if (Number.isFinite(update?.rowsAffected) && update.rowsAffected !== 1) throw new Error('Oracle KYC changed since it was read; update was not applied');
      await oracleConnection.commit();
    } catch (error) {
      try { await oracleConnection.rollback(); } catch {}
      throw error;
    }
    return { changed: true, previous, current: { status: 'REVIEW_REQUIRED', riskRating: 'HIGH' }, baseline };
  }

  async function resetKyc(oracleConnection, expectedCurrent) {
    if (!stateStore) throw new Error('KYC reset requires a local saved baseline');
    const baseline = await stateStore.loadKycBaseline(id);
    if (!baseline) throw new Error(`No reliable KYC baseline exists for customer ${id}; refusing to guess original values`);
    const current = await currentKyc(oracleConnection);
    if (baseline.kycRecordId !== current.kycRecordId) throw new Error(`Saved KYC baseline does not match the Oracle KYC record for customer ${id}`);
    if (expectedCurrent && (current.status !== expectedCurrent.status || current.riskRating !== expectedCurrent.riskRating)) {
      throw new Error('KYC changed after confirmation preview; no reset was applied');
    }
    if (current.status === baseline.kycStatus && current.riskRating === baseline.riskRating) {
      return { changed: false, current, baseline };
    }
    if (String(current.status).trim().toUpperCase() !== 'REVIEW_REQUIRED' || String(current.riskRating).trim().toUpperCase() !== 'HIGH') {
      throw new Error('Current KYC no longer matches the demo values; refusing to overwrite a change by another process or user');
    }
    try {
      const result = await oracleConnection.execute(
        `UPDATE ${oracleTable('CUSTOMER_KYC')} SET KYC_STATUS=:status,RISK_RATING=:risk,LAST_UPDATED_TIMESTAMP=SYSTIMESTAMP WHERE CUSTOMER_ID=:customerId AND KYC_STATUS=:previousStatus AND ((RISK_RATING=:previousRisk) OR (RISK_RATING IS NULL AND :previousRisk IS NULL))`,
        { status: baseline.kycStatus, risk: baseline.riskRating, customerId: Number(id), previousStatus: current.status, previousRisk: current.riskRating });
      if (Number.isFinite(result?.rowsAffected) && result.rowsAffected !== 1) throw new Error('KYC changed concurrently; guarded reset did not update a row');
      await oracleConnection.commit();
    } catch (error) { try { await oracleConnection.rollback(); } catch {} throw error; }
    return { changed: true, current: { ...current, status: baseline.kycStatus, riskRating: baseline.riskRating }, baseline };
  }

  async function verifyTransaction(dbConnection, record) {
    if (!record) return { passed: false, error: 'No local demo transaction record was found; run demo:transaction again only if you intend another withdrawal' };
    const [relation, rows] = await Promise.all([
      customerAccount(dbConnection),
      dbConnection.query(
        `SELECT TRANSACTION_ID,ACCOUNT_ID,TRANSACTION_TYPE,TRANSACTION_STAGE,TRANSACTION_STATUS,TRANSACTION_AMOUNT,CURRENCY,TRANSACTION_TIMESTAMP FROM ${db2Table('ACCOUNT_TRANSACTION')} WHERE TRANSACTION_ID=? AND ACCOUNT_ID=?`,
        [record.transactionId, record.accountId])
    ]);
    const transactionRow = rows[0] || null;
    const currentAccountRows = await dbConnection.query(
      `SELECT BALANCE,AVAILABLE_BALANCE,CURRENCY FROM ${db2Table('BANK_ACCOUNT')} WHERE ACCOUNT_ID=?`, [record.accountId]);
    const current = currentAccountRows[0] || null;
    const relationshipValid = String(relation.CUSTOMER_ID).trim() === String(record.customerId) && String(relation.ACCOUNT_ID).trim() === String(record.accountId);
    const transactionValid = Boolean(transactionRow && String(transactionRow.TRANSACTION_ID).trim() === String(record.transactionId) &&
      String(transactionRow.ACCOUNT_ID).trim() === String(record.accountId) && String(transactionRow.TRANSACTION_TYPE).trim().toUpperCase() === 'WITHDRAWAL' &&
      String(transactionRow.TRANSACTION_STAGE).trim().toUpperCase() === 'POSTED' &&
      String(transactionRow.TRANSACTION_STATUS).trim().toUpperCase() === 'COMPLETED' &&
      Number(transactionRow.TRANSACTION_AMOUNT) === 200 && String(transactionRow.CURRENCY).trim().toUpperCase() === 'GBP' &&
      String(transactionRow.TRANSACTION_TIMESTAMP).trim() === String(record.transactionTimestamp).trim());
    const recordedDeductionValid = Math.abs(record.previousBalance - record.newBalance - 200) <= 0.0001 &&
      Math.abs(record.previousAvailableBalance - record.newAvailableBalance - 200) <= 0.0001;
    const accountValid = Boolean(current && String(current.CURRENCY).trim().toUpperCase() === 'GBP' &&
      Number.isFinite(Number(current.BALANCE)) && Number.isFinite(Number(current.AVAILABLE_BALANCE)));
    return { passed: relationshipValid && transactionValid && recordedDeductionValid && accountValid, record,
      transaction: transactionRow, account: current, relationshipValid, transactionValid, recordedDeductionValid, accountValid,
      currentMatchesRecordedAfter: Boolean(current && Number(current.BALANCE) === record.newBalance && Number(current.AVAILABLE_BALANCE) === record.newAvailableBalance) };
  }

  async function verifyKyc(oracleConnection) {
    const current = await currentKyc(oracleConnection);
    return { ...current, passed: String(current.status).trim().toUpperCase() === 'REVIEW_REQUIRED' &&
      String(current.riskRating).trim().toUpperCase() === 'HIGH' };
  }

  // Read-only source snapshot used by the optional TapData comparison stage.
  // The local runtime record supplies the exact transaction ID to inspect.
  async function readApiVerificationSources(dbConnection, oracleConnection, record) {
    if (!record || !record.transactionId) throw new Error('No locally recorded demo transaction ID is available; run demo:transaction first if you intend a withdrawal');
    if (String(record.customerId) !== id || String(record.accountId) !== account) {
      throw new Error(`The recorded transaction does not belong to configured customer/account ${id}/${account}`);
    }
    const [customer, transactionRows, kycRow] = await Promise.all([
      customerAccount(dbConnection),
      dbConnection.query(
        `SELECT TRANSACTION_ID,ACCOUNT_ID,TRANSACTION_TYPE,TRANSACTION_STAGE,TRANSACTION_STATUS,TRANSACTION_AMOUNT,CURRENCY FROM ${db2Table('ACCOUNT_TRANSACTION')} WHERE TRANSACTION_ID=? AND ACCOUNT_ID=?`,
        [record.transactionId, account]),
      kycRecord(oracleConnection)
    ]);
    if (!transactionRows.length) throw new Error(`Recorded transaction ${record.transactionId} was not found in the source DB2 account`);
    const row = transactionRows[0];
    return {
      customerId: String(customer.CUSTOMER_ID).trim(), accountId: String(customer.ACCOUNT_ID).trim(),
      balance: customer.BALANCE, availableBalance: customer.AVAILABLE_BALANCE, currency: customer.CURRENCY,
      transaction: { id: row.TRANSACTION_ID, amount: row.TRANSACTION_AMOUNT, currency: row.CURRENCY,
        type: row.TRANSACTION_TYPE, stage: row.TRANSACTION_STAGE, status: row.TRANSACTION_STATUS },
      kyc: { customerId: String(kycRow[0]).trim(), status: kycRow[2], riskRating: kycRow[3] ?? null }
    };
  }

  async function verify(dbConnection, oracleConnection, stage = 'all', record) {
    if (!['transaction', 'kyc', 'all'].includes(stage)) throw new Error('Verification stage must be transaction, kyc, or all');
    const result = { stage };
    if (stage === 'transaction' || stage === 'all') result.transaction = await verifyTransaction(dbConnection, record);
    if (stage === 'kyc' || stage === 'all') result.kyc = await verifyKyc(oracleConnection);
    result.passed = Object.values(result).filter(value => value && typeof value === 'object' && 'passed' in value).every(value => value.passed);
    return result;
  }

  return { status, transaction, currentKyc, setKyc, resetKyc, verifyTransaction, verifyKyc, verify, readApiVerificationSources };
}

module.exports = { createDemoService, DEFAULTS, DEMO_REFERENCE_PREFIX };
