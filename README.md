# BankStream Feeder

BankStream Feeder generates banking transactions and customer updates in Oracle and IBM i (AS/400, DB2) source databases for a Customer 360 demo. TapData captures committed changes through separately configured Change Data Capture (CDC) tasks and updates downstream customer views.

The Feeder changes source data and verifies results. It does not create schemas or configure TapData tasks, FDM, MDM, or pipelines. Source schemas, demo records, and TapData pipelines must already be set up.

## Remote Mode (recommended for partners)

In Remote Mode, the CLI sends requests to a Hosted Service(By Tapdata). The service uses your partner's assigned databases and keeps database and TapData credentials on the server. You do not need local database environments. 

### 1. Install

You need Git, Node.js 24 (the validated baseline), npm, and network access to the Hosted Service. Ask Tapdata for the HTTPS URL, partner API token, and release or branch to use.

```bash
git clone https://github.com/umerwhu/BankStream_Feeder.git
cd BankStream_Feeder
npm ci --omit=optional
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

```bash
npm run dry-run
npm run demo:status
```

These commands are read-only. `dry-run` checks Oracle and IBM i connectivity through the service. `demo:status` shows your assigned customer, linked account, balances, recent transactions, and KYC details. Once they succeed, use the demo commands below.

## Local Mode (alternative)

Local Mode requires you to deploy and configure your own data sources, including Oracle and IBM i (AS/400), with the required schemas and demo records. Set `FEEDER_MODE=local` and follow the **Optional: Local Mode** settings in [.env.example](.env.example) to configure database connections and other required settings, including TapData API access for verification. Install the required local dependencies and drivers as described in the [technical guide](docs/technical-guide.md). Run the same demo commands below.

## Demo commands

Run commands from the project folder. All commands below work in both modes.

| Command | What it does |
|---|---|
| `npm run dry-run` | Checks both source database connections using read-only SELECT queries. |
| `npm run demo:status` | Displays customer, account, transaction, and KYC details without changing data. |
| `npm run demo:transaction` | Previews the account and asks for withdrawal amount and confirmation. Inserts a completed withdrawal and reduces balance and available balance. |
| `npm run demo:kyc` | Shows current KYC and asks for confirmation before setting status/risk to `REVIEW_REQUIRED / HIGH`, if needed. |
| `npm run demo:reset` | Offers a menu to reset KYC, account balances, or both, or cancel. After confirmation, restores selected KYC to `VERIFIED / LOW` and/or both balances to `40000`, then verifies and summarizes the selected results. Keeps transaction history. |
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
| IBM i / AS400 (DB2) | `BANK_ACCOUNT` | Updates balance and available balance for posted transactions. |
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
- [Validation report](docs/phase6-validation.md): installation/platform checks and deployment limitations for service operators.
