# BankStream Feeder

BankStream Feeder simulates real-time banking activity by continuously inserting new records and updating existing data in Oracle and IBM i (AS400) databases. These changes can be captured by TapData using real-time Change Data Capture (CDC), enabling live data integration and updates for the BankStream AI Dashboard demo.

## Tables changed by the feeder

**DB2i / AS400**

- `ACCOUNT_TRANSACTION` — insert and update
- `BANK_ACCOUNT` — update

**Oracle**

- `CUSTOMER_PROFILE` — update
- `CUSTOMER_KYC` — update
- `CUSTOMER_INTERACTIONS` — insert
- `CUSTOMER_OFFERS` — update

## Prerequisites

- Node.js 20 or later and npm.
- Reachable Oracle and IBM i Db2 databases, with matching customer/account demo records already loaded.
- Runtime database users with read and write access to the required tables.
- Java 11 or later for the included JT400 driver used by the default IBM i connection.

Create the database tables and load the initial records before running the feeder. The setup scripts are in [`ddl/`](ddl/) and [`bulk-data/`](bulk-data/).

## Configure

Copy the example file and edit `.env` with your database connection details:

```sh
cp .env.example .env
```

In PowerShell, use `Copy-Item .env.example .env` instead. Set the Oracle user, password, connect string, and schema (`ORACLE_*` variables). For the default IBM i connection, set the host, schema, user, and password (`DB2I_HOST`, `DB2I_SCHEMA`, `DB2I_USER`, and `DB2I_PASSWORD`). The project-local JT400 driver path is already set in the example. Keep `.env` private; it is excluded from Git.

The optional Customer 360 demo settings select the customer and linked account used by the demo commands. Defaults are customer `100002`, account `AC1000021`, and a fixed withdrawal of `GBP 200`. The withdrawal amount and currency must remain `200` and `GBP`.

## Quick start

From the project folder, run:

```sh
npm ci
npm run dry-run
npm run realtime -- --duration 5m --interval 15s
```

`dry-run` checks database connectivity without writing data. The real-time command runs for five minutes; press **Ctrl+C** to stop earlier.

## Customer 360 demo commands

These commands run independently of the real-time feeder. The selected customer and account must already exist in the databases and be linked through `ACCOUNT_CUSTOMER_RELATIONSHIP`.

```sh
npm run demo:status
npm run demo:transaction
npm run demo:verify
npm run demo:kyc
npm run demo:verify
```

- `demo:status` reads the customer, linked account balances, recent transactions, and Oracle KYC details.
- `demo:transaction` creates one completed GBP 200 withdrawal and deducts it from the account balance and available balance in the same database transaction. Type the requested confirmation when prompted. Each confirmed run creates a new withdrawal.
- `demo:kyc` sets the existing Oracle KYC record to `REVIEW_REQUIRED` with risk rating `HIGH`. Type the requested confirmation when prompted. Re-running it makes no change if those values are already set.
- `demo:verify` reads the latest demo withdrawal, current account balances, and Oracle KYC values from the source databases.

The status and verify commands are read-only. The transaction and KYC commands change remote database records only after interactive confirmation. There is no reset or recovery command; withdrawals are not reversed automatically.

## Verify changes

After the real-time run, check its execution summary for insert and update counts by table. Confirm the corresponding records or updated values in your demo databases. Counts can be zero for tables whose events were not selected during that run.
