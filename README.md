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

For the optional TapData API comparison, configure the TapData values in `.env` using the real environment details supplied by your TapData administrator. Replace the `example.invalid` URLs and dummy client values from `.env.example`; they cannot connect to a service. `TAPDATA_API_BASE_URL` is the TapData API host/base URL (the command appends `/api/v1/MDM_CUSTOMER360` and `/api/v1/CUSTOMER_KYC`). Set either a valid `TAPDATA_ACCESS_TOKEN`, or `TAPDATA_TOKEN_URL`, `TAPDATA_CLIENT_ID`, and `TAPDATA_CLIENT_SECRET` with the authentication method supported by your TapData deployment. Keep all credentials in `.env` only; never commit them. The Customer 360 and KYC API paths and collection names should match the published TapData services.

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
npm run demo:verify -- --stage transaction
npm run demo:verify -- --stage api
npm run demo:kyc
npm run demo:verify -- --stage kyc
npm run demo:verify -- --stage api
npm run demo:kyc:reset
```

- `demo:status` reads the customer, linked account balances, recent transactions, and Oracle KYC details.
- `demo:transaction` creates one completed GBP 200 withdrawal and deducts it from the account balance and available balance in the same database transaction. Type the requested confirmation when prompted. Each confirmed run creates a new withdrawal.
- `demo:kyc` sets the existing Oracle KYC record to `REVIEW_REQUIRED` with risk rating `HIGH`. Type the requested confirmation when prompted. Re-running it makes no change if those values are already set.
- `demo:verify -- --stage transaction` checks the recorded withdrawal by its exact transaction ID, its GBP 200 amount and status, the recorded balance deductions, and current account balances.
- `demo:verify -- --stage kyc` checks the current Oracle KYC status and risk rating.
- `demo:verify -- --stage api` reads the source account, exact locally recorded withdrawal, and Oracle KYC, then compares them with the published TapData `MDM_CUSTOMER360` and `CUSTOMER_KYC` APIs. It is read-only, reports each source/API value and PASS/FAIL, and returns a failure exit code when required fields do not match or cannot be found. Run `demo:transaction` first if you want to compare a demo withdrawal; this command uses its locally saved transaction ID and never selects a different/latest transaction.
- `demo:verify` with no stage runs both verification checks.
- `demo:kyc:reset` restores the selected customer's KYC status and risk rating from the original values saved locally before the first demo KYC update. It requires confirmation and refuses to guess if the saved baseline is missing or if current KYC values have changed unexpectedly. For the current default customer baseline, this restores `VERIFIED / LOW`.

The status and verify commands are read-only. The API comparison uses a configurable CDC wait (`DEMO_API_CDC_RETRY_INTERVAL_MS`, default `2000`; `DEMO_API_CDC_TIMEOUT_MS`, default `30000`) so newly committed source changes have time to appear in TapData. `TAPDATA_REQUEST_TIMEOUT_MS` (default `15000`), `TAPDATA_PAGE_SIZE` (default `200`), and `TAPDATA_SCAN_LIMIT` (default `1000`) control API requests and record scanning. The transaction, KYC, and KYC reset commands change remote database records only after interactive confirmation. Runtime baseline and transaction records are stored under the ignored `runtime/` directory. KYC reset does not reverse withdrawals or restore account balances.

## Verify changes

After the real-time run, check its execution summary for insert and update counts by table. Confirm the corresponding records or updated values in your demo databases. Counts can be zero for tables whose events were not selected during that run.
