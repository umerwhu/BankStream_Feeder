# BankStream Feeder

BankStream Feeder generates banking transactions and customer updates in Oracle and IBM i (AS/400, DB2) source databases for a Customer 360 demo. TapData captures committed changes through separately configured Change Data Capture (CDC) tasks and updates downstream customer views.

The Feeder changes source data and verifies results. It does not create schemas or configure TapData tasks, FDM, MDM, or pipelines. Source schemas, demo records, and TapData pipelines must already be set up.

## Before you start: choose a mode

- **Remote Mode (recommended for partners):** TapData provides the databases and service. Skip database setup and follow [Remote Mode](#remote-mode-recommended-for-partners).
- **Local Mode:** you manage your own Oracle and IBM i databases. Complete the database setup below first, then follow [Local Mode](#local-mode).

### Local Mode only: create databases, schemas, and demo records first

1. Deploy Oracle and IBM i (AS/400) and make them reachable from the Feeder computer.
2. Download this repository to access the SQL files. Run the schema scripts using your database SQL tools, then load the matching sample data:

| Database | First: create schemas and tables | Next: load demo records |
|---|---|---|
| IBM i | [01_db2i_schema.sql](ddl/01_db2i_schema.sql) | [01_db2i_sample_data.sql](bulk-data/01_db2i_sample_data.sql) |
| Oracle | [02_oracle_schema.sql](ddl/02_oracle_schema.sql) | [02_oracle_sample_data.sql](bulk-data/02_oracle_sample_data.sql) |

3. Review setup placeholders and permissions with your database administrator. In the IBM i script, replace `username` and apply its table grant after creating the table. The Oracle script requires SQL*Plus/SQLcl and prompts for a password, PDB name, and service.
4. Grant the Feeder user read/write access to the required tables. Ensure the demo customer and account exist and are linked through `ACCOUNT_CUSTOMER_RELATIONSHIP`.

The supplied scripts use `BANKCORE` for IBM i and `C##BANKCRM` for Oracle. Use the same names in your connection configuration, or adapt the scripts and configuration together. PostgreSQL is not required for the Feeder commands below.

## Remote Mode (recommended for partners)

The CLI connects to the TapData-hosted Control Service. The service uses your partner's assigned databases and keeps database and TapData credentials on the server. You do not need your own database installation.

### 1. Install

You need Git, Node.js 24 (the validated baseline), npm, and network access to the Hosted Service. Ask Tapdata for the HTTPS URL, partner API token, and release or branch to use.

```bash
git clone https://github.com/umerwhu/BankStream_Feeder.git
cd BankStream_Feeder
npm ci 
```

Use the release or branch supplied by your operator. On Windows PowerShell, replace `npm` with `npm.cmd` if script execution policy blocks it.

### 2. Configure

Copy `.env.example` to `.env` in the project folder.

**PowerShell:**

```powershell
Copy-Item .env.example .env
```

**macOS/Linux:**

```bash
cp .env.example .env
```

Edit these three settings in `.env` using the URL and token from your operator:

```ini
FEEDER_MODE=remote
DEMO_API_URL=https://demo.example.com
DEMO_API_TOKEN=replace_with_partner_token
```

The URL must use HTTPS. No other settings are needed for Remote Mode. Keep your token private; do not commit `.env` or share it in logs or screenshots.

### 3. Check the connection

Before running `npm run demo:status`, `npm run demo:transaction`, or the other demo commands, confirm with your operator that the required TapData tasks have completed their initial synchronization, CDC tasks are running, and the Customer 360 and KYC APIs are published and accessible.

```bash
npm run dry-run
npm run demo:status
```

These commands are read-only. `dry-run` checks Oracle and IBM i connectivity through the service. `demo:status` shows your assigned customer, linked account, balances, recent transactions, and KYC details. Once they succeed, use the demo commands below.

## Local Mode

Complete the database setup above before these steps.

### 1. Install

Use Git, Node.js 24, and npm. Download the project and install database dependencies. If you already downloaded it for database setup, open that project folder and run only the install command:

```bash
git clone https://github.com/umerwhu/BankStream_Feeder.git
cd BankStream_Feeder
npm ci 
```

### 2. Configure

Copy `.env.example` to `.env` using the PowerShell or macOS/Linux copy command above. Set:

```ini
FEEDER_MODE=local
```

Configure the Local Mode settings in [.env.example](.env.example) for Oracle and IBM i connections, actual schema names, and demo IDs. These settings are required when using Local Mode. The default customer is `100002` and account is `AC1000021`. Remote service URL/token settings are not used in Local Mode.

Configure TapData tasks separately. Before running `npm run demo:status`, `npm run demo:transaction`, or the other demo commands, complete the initial synchronization, keep CDC tasks running, and publish the Customer 360 and KYC APIs. Set the TapData API settings in `.env` for `demo:verify`. Keep all credentials private.

### 3. Check the connection and demo records

```bash
npm run doctor
npm run dry-run
npm run demo:status
```

`doctor` checks configuration and runtime dependencies without connecting. `dry-run` checks database connectivity; `demo:status` reads the customer, account, and KYC records. These checks do not change data. Continue with the demo commands once they pass.

## Demo commands

Run commands from the project folder after completing the TapData task and API setup above. All commands below work in both modes.

| Command | What it does |
|---|---|
| `npm run dry-run` | Checks both source database connections using read-only SELECT queries. |
| `npm run demo:status` | Displays customer, account, transaction, and KYC details without changing data. |
| `npm run demo:transaction` | Previews the account and asks for a GBP withdrawal amount and confirmation. Inserts a completed withdrawal and reduces balance and available balance. |
| `npm run demo:kyc` | Shows current KYC and asks for confirmation before setting status/risk to `REVIEW_REQUIRED / HIGH`, if needed. |
| `npm run demo:reset` | Offers KYC reset, balance reset, both, or cancel. Reads current values after selection and confirms only necessary changes. Restores KYC to `VERIFIED / LOW` and/or both balances to `40000`. Keeps transaction history. |
| `npm run demo:verify` | Reads source transactions/KYC and compares source balances, transactions, and KYC with TapData published APIs. Reports PASS/FAIL without changing data. |
| `npm run realtime -- --duration 5m --interval 15s` | Generates transactions and customer activity for five minutes, with a 15-second delay between cycles. |

Transaction and KYC commands require an interactive terminal. Confirmation defaults to **No**; enter `y` to proceed. Cancelling makes no changes. Each confirmed withdrawal creates a new transaction. Use writing commands only against your assigned demo environment.

For a simple demo, run `demo:transaction`, then `demo:verify`; run `demo:kyc`, then `demo:verify` again. Use `demo:reset` and select **Reset KYC** to restore the KYC baseline.

`demo:reset` commits each database separately. If either step fails, it reports both outcomes and exits with an error. Remote partial failures require operator reconciliation before further writes. Remote reset requires a Control Service version with the reset endpoints.

### Realtime activity

Adjust `--duration` and `--interval` as needed, within your service limits. Remote Mode allows one active job per partner and does not support unlimited duration. The CLI reports the job ID, progress, status, and final counts by table. Press **Ctrl+C** to request cancellation and let the current database operation finish.

Realtime can change matched customers and accounts across the assigned schemas, beyond the interactive demo account. Activities are randomly selected, so short runs may not change every table.

Cancellation does not undo committed changes. Jobs do not resume after a service restart, and changes across both databases are not one atomic transaction.

## Data changed by the Feeder

TapData independently captures these committed changes; `demo:verify` checks source records and the corresponding published API results.

| Database | Table | Changes |
|---|---|---|
| IBM i / AS400 (DB2) | `ACCOUNT_TRANSACTION` | Inserts transactions. Realtime also updates pending transactions to completed/posted or rejected. Interactive withdrawals are inserted as completed/posted. |
| IBM i / AS400 (DB2) | `BANK_ACCOUNT` | Updates balances for posted transactions or restores both to `40000` through reset. |
| Oracle | `CUSTOMER_PROFILE` | Updates the preferred customer channel during realtime activity. |
| Oracle | `CUSTOMER_KYC` | Updates KYC status and risk through KYC commands or realtime activity. |
| Oracle | `CUSTOMER_INTERACTIONS` | Inserts customer service interactions during realtime activity. |
| Oracle | `CUSTOMER_OFFERS` | Updates existing offer status during realtime activity. |

## Troubleshooting

| Problem | What to do |
|---|---|
| Authentication failed | Check `DEMO_API_TOKEN`. Ask the operator whether the token expired, was revoked, or your partner access was disabled. |
| Cannot reach the Hosted Service | Check `DEMO_API_URL`, network access, service availability, and certificate trust. `localhost` means your own computer. Ask the operator for the correct URL or CA certificate; do not disable TLS verification. |
| Verification reports FAIL | CDC may still be synchronizing. Wait and rerun verification. If it still fails, check the reported source/API values and ask the operator to check TapData tasks and published APIs. Realtime activity can change records during comparison. |
| Realtime options rejected | Choose duration/interval values allowed by your operator. Remote unlimited jobs are not supported. |
| A write or job request times out | It may already have executed. Keep the reported idempotency key or job ID and contact the operator before submitting another writing command. Rerunning a command creates a new request. |

## Further documentation

- [Technical guide](docs/technical-guide.md): local dependencies and drivers, configuration, verification settings, service contracts, realtime limits, and developer testing.
