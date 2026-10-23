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

## Quick start

From the project folder, run:

```sh
npm ci
npm run dry-run
npm run realtime -- --duration 5m --interval 15s
```

`dry-run` checks database connectivity without writing data. The real-time command runs for five minutes; press **Ctrl+C** to stop earlier.

## Verify changes

After the real-time run, check its execution summary for insert and update counts by table. Confirm the corresponding records or updated values in your demo databases. Counts can be zero for tables whose events were not selected during that run.
