const { randomUUID } = require('node:crypto');

const DEMO_REFERENCE_PREFIX = 'C360-DEMO:';
const DEFAULTS = Object.freeze({ customerId: '100002', accountId: 'AC1000021', amount: 200, currency: 'GBP' });

function schemaName(value, fallback, label) {
  const name = String(value || fallback).trim();
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(name)) throw new Error(`${label} must be a valid schema identifier`);
  return name.toUpperCase();
}

function createDemoService({ db2Schema = 'BANKCORE', oracleSchema = 'BANKCRM', customerId = DEFAULTS.customerId,
  accountId = DEFAULTS.accountId, amount = DEFAULTS.amount, currency = DEFAULTS.currency, makeId = randomUUID } = {}) {
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
      await dbConnection.commit();
      return { transactionId, reference, amount: withdrawalAmount, currency: transactionCurrency,
        previousBalance: balance, newBalance: balance - withdrawalAmount,
        previousAvailableBalance: available, newAvailableBalance: available - withdrawalAmount };
    } catch (error) {
      try { await dbConnection.rollback(); } catch {}
      throw error;
    }
  }

  async function setKyc(oracleConnection) {
    const record = await kycRecord(oracleConnection);
    const previous = { status: record[2], riskRating: record[3] };
    if (String(record[2]).trim().toUpperCase() === 'REVIEW_REQUIRED' && String(record[3]).trim().toUpperCase() === 'HIGH') {
      return { changed: false, previous, current: { status: record[2], riskRating: record[3] } };
    }
    try {
      await oracleConnection.execute(
        `UPDATE ${oracleTable('CUSTOMER_KYC')} SET KYC_STATUS=:status,RISK_RATING=:risk,LAST_UPDATED_TIMESTAMP=SYSTIMESTAMP WHERE CUSTOMER_ID=:customerId`,
        { status: 'REVIEW_REQUIRED', risk: 'HIGH', customerId: Number(id) });
      await oracleConnection.commit();
    } catch (error) {
      try { await oracleConnection.rollback(); } catch {}
      throw error;
    }
    return { changed: true, previous, current: { status: 'REVIEW_REQUIRED', riskRating: 'HIGH' } };
  }

  async function verify(dbConnection, oracleConnection) {
    const [relation, latest, kyc] = await Promise.all([
      customerAccount(dbConnection),
      dbConnection.query(
        `SELECT TRANSACTION_ID,ACCOUNT_ID,TRANSACTION_TYPE,TRANSACTION_STAGE,TRANSACTION_STATUS,TRANSACTION_AMOUNT,CURRENCY,TRANSACTION_TIMESTAMP,COUNTERPARTY_REFERENCE FROM ${db2Table('ACCOUNT_TRANSACTION')} WHERE ACCOUNT_ID=? AND COUNTERPARTY_REFERENCE LIKE ? ORDER BY TRANSACTION_TIMESTAMP DESC FETCH FIRST 1 ROW ONLY`,
        [account, `${DEMO_REFERENCE_PREFIX}%`]),
      kycRecord(oracleConnection)
    ]);
    const withdrawal = latest[0] || null;
    const transactionValid = Boolean(withdrawal &&
      String(withdrawal.TRANSACTION_TYPE).trim().toUpperCase() === 'WITHDRAWAL' &&
      String(withdrawal.TRANSACTION_STAGE).trim().toUpperCase() === 'POSTED' &&
      String(withdrawal.TRANSACTION_STATUS).trim().toUpperCase() === 'COMPLETED' &&
      Number(withdrawal.TRANSACTION_AMOUNT) === 200 &&
      String(withdrawal.CURRENCY).trim().toUpperCase() === 'GBP');
    return { account: relation, withdrawal, transactionValid, kyc: { status: kyc[2], riskRating: kyc[3], valid:
      String(kyc[2]).trim().toUpperCase() === 'REVIEW_REQUIRED' && String(kyc[3]).trim().toUpperCase() === 'HIGH' } };
  }

  return { status, transaction, setKyc, verify };
}

module.exports = { createDemoService, DEFAULTS, DEMO_REFERENCE_PREFIX };
