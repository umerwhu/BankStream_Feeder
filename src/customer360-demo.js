const { randomUUID } = require('node:crypto');
const { moneyToMinorUnits, databaseMoneyToMinorUnits, formatMinorUnits, validateAgainstAvailable } = require('./demo-amount');

const DEMO_REFERENCE_PREFIX = 'C360-DEMO:';
const DEFAULTS = Object.freeze({ customerId: '100002', accountId: 'AC1000021', amount: 200, currency: 'GBP' });

function schemaName(value, fallback, label) {
  const name = String(value || fallback).trim();
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(name)) throw new Error(`${label} must be a valid schema identifier`);
  return name.toUpperCase();
}

function createDemoService({ db2Schema = 'BANKCORE', oracleSchema = 'BANKCRM', customerId = DEFAULTS.customerId,
  kycCustomerId = '100002', accountId = DEFAULTS.accountId, amount = DEFAULTS.amount, currency = DEFAULTS.currency, makeId = randomUUID } = {}) {
  const db2 = schemaName(db2Schema, 'BANKCORE', 'DB2I_SCHEMA');
  const oracle = schemaName(oracleSchema, 'BANKCRM', 'ORACLE_SCHEMA');
  const db2Table = name => `${db2}.${name}`;
  const oracleTable = name => `${oracle}.${name}`;
  const id = String(customerId).trim();
  const kycId = String(kycCustomerId).trim();
  const account = String(accountId).trim();
  const withdrawalAmount = formatMinorUnits(moneyToMinorUnits(amount, 'DEMO_WITHDRAWAL_AMOUNT'));
  const transactionCurrency = String(currency).trim().toUpperCase();
  if (!/^\d+$/.test(id)) throw new Error('DEMO_CUSTOMER_ID must contain digits only');
  if (!/^\d+$/.test(kycId)) throw new Error('KYC customer ID must contain digits only');
  if (!account || account.length > 30) throw new Error('DEMO_ACCOUNT_ID must contain 1 to 30 characters');
  if (transactionCurrency !== 'GBP') throw new Error('The Customer 360 demo withdrawal currency must be GBP');

  async function customerAccount(dbConnection) {
    const rows = await dbConnection.query(
      `SELECT C.CUSTOMER_ID,C.CUSTOMER_NAME,C.CUSTOMER_STATUS,R.OWNERSHIP_ROLE,R.EFFECTIVE_FROM,R.EFFECTIVE_TO,A.ACCOUNT_ID,A.ACCOUNT_NUMBER,A.ACCOUNT_TYPE,A.CURRENCY,A.ACCOUNT_STATUS,A.BALANCE,A.AVAILABLE_BALANCE FROM ${db2Table('CUSTOMER')} C JOIN ${db2Table('ACCOUNT_CUSTOMER_RELATIONSHIP')} R ON R.CUSTOMER_ID=C.CUSTOMER_ID JOIN ${db2Table('BANK_ACCOUNT')} A ON A.ACCOUNT_ID=R.ACCOUNT_ID WHERE C.CUSTOMER_ID=? AND A.ACCOUNT_ID=? AND R.EFFECTIVE_FROM<=CURRENT_DATE AND (R.EFFECTIVE_TO IS NULL OR R.EFFECTIVE_TO>=CURRENT_DATE)`,
      [id, account]);
    if (!rows.length) throw new Error(`Customer ${id} has no active relationship to account ${account}`);
    if (rows.length > 1) throw new Error(`Customer/account relationship for ${id}/${account} is ambiguous`);
    return rows[0];
  }

  async function readWithdrawalAccount(dbConnection) {
    const row = await customerAccount(dbConnection);
    return { customerId: String(row.CUSTOMER_ID).trim(), accountId: String(row.ACCOUNT_ID).trim(), customerName: String(row.CUSTOMER_NAME || '').trim(),
      accountStatus: String(row.ACCOUNT_STATUS || '').trim(), currency: String(row.CURRENCY || '').trim().toUpperCase(),
      balance: row.BALANCE, availableBalance: row.AVAILABLE_BALANCE };
  }

  async function kycRecord(oracleConnection) {
    const result = await oracleConnection.execute(
      `SELECT CUSTOMER_ID,KYC_RECORD_ID,KYC_STATUS,RISK_RATING,LAST_UPDATED_TIMESTAMP FROM ${oracleTable('CUSTOMER_KYC')} WHERE CUSTOMER_ID=:customerId`,
      { customerId: Number(kycId) });
    const rows = result.rows || [];
    if (!rows.length) throw new Error(`Oracle KYC record for customer ${kycId} was not found`);
    if (rows.length > 1) throw new Error(`Oracle returned duplicate KYC records for customer ${kycId}; refusing an ambiguous update`);
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

  async function transaction(dbConnection, requestedAmount = withdrawalAmount) {
    const amountCents = moneyToMinorUnits(requestedAmount, 'Withdrawal amount');
    const amountText = formatMinorUnits(amountCents);
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
      const balance = databaseMoneyToMinorUnits(locked.BALANCE, 'Account balance');
      const available = databaseMoneyToMinorUnits(locked.AVAILABLE_BALANCE, 'Available balance');
      if (String(locked.ACCOUNT_STATUS).trim().toUpperCase() !== 'ACTIVE') throw new Error(`Account ${account} is not active`);
      if (String(locked.CURRENCY).trim().toUpperCase() !== transactionCurrency) throw new Error(`Account ${account} currency is not ${transactionCurrency}`);
      validateAgainstAvailable(amountCents, available);
      if (amountCents > balance) throw new Error(`Withdrawal amount ${amountText} GBP exceeds account balance ${formatMinorUnits(balance)} GBP`);

      const transactionId = `RT-${makeId()}`;
      const reference = `${DEMO_REFERENCE_PREFIX}${makeId()}`;
      await dbConnection.query(
        `INSERT INTO ${db2Table('ACCOUNT_TRANSACTION')} (TRANSACTION_ID,ACCOUNT_ID,TRANSACTION_TYPE,TRANSACTION_STAGE,TRANSACTION_STATUS,TRANSACTION_AMOUNT,CURRENCY,TRANSACTION_TIMESTAMP,CHANNEL,COUNTERPARTY_REFERENCE,LAST_UPDATED_TIMESTAMP) VALUES (?,?, 'WITHDRAWAL','POSTED','COMPLETED',CAST(? AS DECIMAL(31,2)),?,CURRENT_TIMESTAMP,'BRANCH',?,CURRENT_TIMESTAMP)`,
        [transactionId, account, amountText, transactionCurrency, reference]);
      const updated = await dbConnection.query(
        `UPDATE ${db2Table('BANK_ACCOUNT')} SET BALANCE=BALANCE-CAST(? AS DECIMAL(31,2)),AVAILABLE_BALANCE=AVAILABLE_BALANCE-CAST(? AS DECIMAL(31,2)),LAST_UPDATED_TIMESTAMP=CURRENT_TIMESTAMP WHERE ACCOUNT_ID=? AND ACCOUNT_STATUS='ACTIVE' AND CURRENCY=? AND BALANCE>=CAST(? AS DECIMAL(31,2)) AND AVAILABLE_BALANCE>=CAST(? AS DECIMAL(31,2))`,
        [amountText, amountText, account, transactionCurrency, amountText, amountText]);
      if (Number.isFinite(updated?.count) && updated.count !== 1) throw new Error(`Account ${account} changed before the withdrawal could be applied`);
      const afterRows = await dbConnection.query(
        `SELECT BALANCE,AVAILABLE_BALANCE FROM ${db2Table('BANK_ACCOUNT')} WHERE ACCOUNT_ID=?`, [account]);
      const transactionRows = await dbConnection.query(
        `SELECT TRANSACTION_TIMESTAMP FROM ${db2Table('ACCOUNT_TRANSACTION')} WHERE TRANSACTION_ID=? AND ACCOUNT_ID=?`,
        [transactionId, account]);
      if (!afterRows.length || !transactionRows.length) throw new Error('Could not confirm the inserted transaction and updated account before commit');
      const newBalance = databaseMoneyToMinorUnits(afterRows[0].BALANCE, 'Updated account balance');
      const newAvailableBalance = databaseMoneyToMinorUnits(afterRows[0].AVAILABLE_BALANCE, 'Updated available balance');
      result = { customerId: id, accountId: account, transactionId, reference, amount: amountText, currency: transactionCurrency,
        previousBalance: formatMinorUnits(balance), newBalance: formatMinorUnits(newBalance),
        previousAvailableBalance: formatMinorUnits(available), newAvailableBalance: formatMinorUnits(newAvailableBalance),
        transactionTimestamp: String(transactionRows[0].TRANSACTION_TIMESTAMP).trim(), completionTimestamp: new Date().toISOString() };
      await dbConnection.commit();
      committed = true;
    } catch (error) {
      if (!committed) try { await dbConnection.rollback(); } catch {}
      throw error;
    }
    return result;
  }

  async function currentKyc(oracleConnection) {
    const record = await kycRecord(oracleConnection);
    return { customerId: String(record[0]).trim(), kycRecordId: String(record[1]).trim(), status: record[2], riskRating: record[3] ?? null };
  }

  async function setKyc(oracleConnection, expectedCurrent) {
    const current = await currentKyc(oracleConnection);
    if (expectedCurrent && (current.status !== expectedCurrent.status || current.riskRating !== expectedCurrent.riskRating || current.kycRecordId !== expectedCurrent.kycRecordId)) {
      throw new Error('KYC changed after confirmation preview; no update was applied');
    }
    const previous = { status: current.status, riskRating: current.riskRating };
    if (String(current.status).trim().toUpperCase() === 'REVIEW_REQUIRED' && String(current.riskRating).trim().toUpperCase() === 'HIGH') {
      return { changed: false, previous, current: { status: current.status, riskRating: current.riskRating } };
    }
    try {
      const update = await oracleConnection.execute(
        `UPDATE ${oracleTable('CUSTOMER_KYC')} SET KYC_STATUS=:status,RISK_RATING=:risk,LAST_UPDATED_TIMESTAMP=SYSTIMESTAMP WHERE CUSTOMER_ID=:customerId AND KYC_STATUS=:previousStatus AND ((RISK_RATING=:previousRisk) OR (RISK_RATING IS NULL AND :previousRisk IS NULL))`,
        { status: 'REVIEW_REQUIRED', risk: 'HIGH', customerId: Number(kycId), previousStatus: current.status, previousRisk: current.riskRating });
      if (Number.isFinite(update?.rowsAffected) && update.rowsAffected !== 1) throw new Error('Oracle KYC changed since it was read; update was not applied');
      await oracleConnection.commit();
    } catch (error) {
      try { await oracleConnection.rollback(); } catch {}
      throw error;
    }
    const committed = await currentKyc(oracleConnection);
    if (committed.status !== 'REVIEW_REQUIRED' || committed.riskRating !== 'HIGH') throw new Error('Oracle KYC update committed, but read-back did not match REVIEW_REQUIRED / HIGH');
    return { changed: true, previous, current: { status: committed.status, riskRating: committed.riskRating } };
  }

  async function resetKyc(oracleConnection, expectedCurrent) {
    const current = await currentKyc(oracleConnection);
    if (expectedCurrent && (current.status !== expectedCurrent.status || current.riskRating !== expectedCurrent.riskRating || current.kycRecordId !== expectedCurrent.kycRecordId)) {
      throw new Error('KYC changed after confirmation preview; no reset was applied');
    }
    if (current.status === 'VERIFIED' && current.riskRating === 'LOW') {
      return { changed: false, current };
    }
    try {
      const result = await oracleConnection.execute(
        `UPDATE ${oracleTable('CUSTOMER_KYC')} SET KYC_STATUS=:status,RISK_RATING=:risk,LAST_UPDATED_TIMESTAMP=SYSTIMESTAMP WHERE CUSTOMER_ID=:customerId AND KYC_STATUS=:previousStatus AND ((RISK_RATING=:previousRisk) OR (RISK_RATING IS NULL AND :previousRisk IS NULL))`,
        { status: 'VERIFIED', risk: 'LOW', customerId: Number(kycId), previousStatus: current.status, previousRisk: current.riskRating });
      if (Number.isFinite(result?.rowsAffected) && result.rowsAffected !== 1) throw new Error('KYC changed concurrently; guarded reset did not update a row');
      await oracleConnection.commit();
    } catch (error) { try { await oracleConnection.rollback(); } catch {} throw error; }
    const committed = await currentKyc(oracleConnection);
    if (committed.status !== 'VERIFIED' || committed.riskRating !== 'LOW') throw new Error('Oracle KYC reset committed, but read-back did not match VERIFIED / LOW');
    return { changed: true, current: committed };
  }

  async function latestPostedWithdrawal(dbConnection) {
    const rows = await dbConnection.query(
      `SELECT TRANSACTION_ID,ACCOUNT_ID,TRANSACTION_TYPE,TRANSACTION_STAGE,TRANSACTION_STATUS,TRANSACTION_AMOUNT,CURRENCY,TRANSACTION_TIMESTAMP FROM ${db2Table('ACCOUNT_TRANSACTION')} WHERE ACCOUNT_ID=? AND TRANSACTION_TYPE='WITHDRAWAL' AND TRANSACTION_STAGE='POSTED' AND TRANSACTION_STATUS='COMPLETED' ORDER BY TRANSACTION_TIMESTAMP DESC,TRANSACTION_ID DESC FETCH FIRST 1 ROW ONLY`,
      [account]);
    return rows[0] || null;
  }

  async function exactTransaction(dbConnection, transactionId) {
    const rows = await dbConnection.query(
      `SELECT TRANSACTION_ID,ACCOUNT_ID,TRANSACTION_TYPE,TRANSACTION_STAGE,TRANSACTION_STATUS,TRANSACTION_AMOUNT,CURRENCY,TRANSACTION_TIMESTAMP FROM ${db2Table('ACCOUNT_TRANSACTION')} WHERE TRANSACTION_ID=? AND ACCOUNT_ID=?`,
      [String(transactionId).trim(), account]);
    return rows[0] || null;
  }

  function validPostedWithdrawal(row) {
    return Boolean(row && String(row.ACCOUNT_ID).trim() === account &&
      String(row.TRANSACTION_TYPE).trim().toUpperCase() === 'WITHDRAWAL' &&
      String(row.TRANSACTION_STAGE).trim().toUpperCase() === 'POSTED' &&
      String(row.TRANSACTION_STATUS).trim().toUpperCase() === 'COMPLETED' &&
      String(row.CURRENCY).trim().toUpperCase() === 'GBP');
  }

  async function verifyTransaction(dbConnection, transactionId) {
    const [customer, row] = await Promise.all([customerAccount(dbConnection),
      transactionId ? exactTransaction(dbConnection, transactionId) : latestPostedWithdrawal(dbConnection)]);
    const [freshAccount, latestAfter] = await Promise.all([customerAccount(dbConnection), transactionId ? Promise.resolve(row) : latestPostedWithdrawal(dbConnection)]);
    const relationshipValid = String(customer.CUSTOMER_ID).trim() === id && String(customer.ACCOUNT_ID).trim() === account;
    const transactionValid = validPostedWithdrawal(row) && (!transactionId || String(row.TRANSACTION_ID).trim() === String(transactionId).trim());
    const stableAccount = String(customer.BALANCE) === String(freshAccount.BALANCE) &&
      String(customer.AVAILABLE_BALANCE) === String(freshAccount.AVAILABLE_BALANCE);
    const stableSelection = Boolean(transactionId) || String(row?.TRANSACTION_ID || '') === String(latestAfter?.TRANSACTION_ID || '');
    return { passed: relationshipValid && transactionValid && stableAccount && stableSelection, transaction: row, account: freshAccount,
      relationshipValid, transactionValid, stableAccount, stableSelection, selectedBy: transactionId ? 'exact transaction ID' : 'latest posted completed withdrawal' };
  }

  async function verifyKyc(oracleConnection) {
    const current = await currentKyc(oracleConnection);
    const updated = String(current.status).trim().toUpperCase() === 'REVIEW_REQUIRED' && String(current.riskRating).trim().toUpperCase() === 'HIGH';
    const baseline = String(current.status).trim().toUpperCase() === 'VERIFIED' && String(current.riskRating).trim().toUpperCase() === 'LOW';
    return { ...current, retrieved: true, expectedState: updated ? 'demo updated state' : baseline ? 'fixed demo baseline' : 'unexpected state', passed: updated || baseline };
  }

  async function readApiVerificationSources(dbConnection, oracleConnection, transactionId, { checkLatest = !transactionId } = {}) {
    const [customer, latest, kycRow] = await Promise.all([
      customerAccount(dbConnection), checkLatest ? latestPostedWithdrawal(dbConnection) : Promise.resolve(null), kycRecord(oracleConnection)
    ]);
    const selectedId = transactionId || latest?.TRANSACTION_ID;
    if (!selectedId) throw new Error(`No posted completed withdrawal was found for account ${account}`);
    const row = transactionId ? await exactTransaction(dbConnection, transactionId) : latest;
    if (!row) throw new Error(`Transaction ${selectedId} was not found in account ${account}`);
    return {
      customerId: String(customer.CUSTOMER_ID).trim(), accountId: String(customer.ACCOUNT_ID).trim(),
      balance: customer.BALANCE, availableBalance: customer.AVAILABLE_BALANCE, currency: customer.CURRENCY,
      transaction: { id: row.TRANSACTION_ID, amount: row.TRANSACTION_AMOUNT, currency: row.CURRENCY,
        type: row.TRANSACTION_TYPE, stage: row.TRANSACTION_STAGE, status: row.TRANSACTION_STATUS, timestamp: row.TRANSACTION_TIMESTAMP },
      latestTransactionId: checkLatest ? latest?.TRANSACTION_ID ?? null : selectedId,
      transactionValid: validPostedWithdrawal(row),
      kyc: { customerId: String(kycRow[0]).trim(), status: kycRow[2], riskRating: kycRow[3] ?? null }
    };
  }

  async function verify(dbConnection, oracleConnection, stage = 'all', transactionId) {
    if (!['transaction', 'kyc', 'all'].includes(stage)) throw new Error('Verification stage must be transaction, kyc, or all');
    const result = { stage };
    if (stage === 'transaction' || stage === 'all') result.transaction = await verifyTransaction(dbConnection, transactionId);
    if (stage === 'kyc' || stage === 'all') result.kyc = await verifyKyc(oracleConnection);
    result.passed = Object.values(result).filter(value => value && typeof value === 'object' && 'passed' in value).every(value => value.passed);
    return result;
  }

  return { status, readWithdrawalAccount, transaction, currentKyc, setKyc, resetKyc, verifyTransaction, verifyKyc, verify, readApiVerificationSources };
}

module.exports = { createDemoService, DEFAULTS, DEMO_REFERENCE_PREFIX };
