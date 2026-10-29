# BankStream Feeder

BankStream Feeder generates banking transactions and customer updates in IBM i (AS400/DB2) and Oracle source databases for a Customer 360 demo. TapData independently captures these changes through Change Data Capture (CDC), keeping the demo's downstream customer views up to date.

Partners use the CLI to request operations from a Hosted Service. The service holds the database credentials and executes the existing Feeder logic using each authenticated partner's assigned configuration.

The Feeder generates source database changes. It does **not** configure or manage TapData tasks, FDM, MDM, or data pipelines; those are operated separately in TapData.

## Quick installation

Use Node.js 24, the validated baseline, and npm. Obtain your Hosted Service HTTPS URL and API token from the service operator.

```bash
git clone https://github.com/umerwhu/BankStream_Feeder.git
cd BankStream_Feeder
npm ci --omit=optional
```

Use the release or branch supplied by your operator. Remote mode requires no database credentials, database drivers, Java, or Oracle client installation.

On Windows PowerShell, use `npm.cmd` if `npm` is blocked by script execution policy.

## Partner configuration

Copy `.env.example` to `.env` in the project folder (`cp .env.example .env`, or `Copy-Item .env.example .env` in PowerShell). The example selects remote mode by default; replace only the URL and token:

```ini
FEEDER_MODE=remote
DEMO_API_URL=https://demo.example.com
DEMO_API_TOKEN=<partner-token>
```

Replace the example URL and token with the values supplied by your operator. The URL must use HTTPS. Keep the token private and do not commit `.env` or share it in logs or screenshots.

Check your setup:

```bash
npm run dry-run
npm run demo:status
```

`dry-run` checks source database connectivity through the service. `demo:status` displays your assigned customer, linked account, recent transactions, and KYC details. Both are read-only.

## Available demo commands

All seven commands work in local and remote modes.

| Command | What it does | Database writes |
|---|---|---|
| `npm run dry-run` | Checks Oracle and IBM i connectivity using SELECT queries. | None |
| `npm run demo:status` | Displays customer, account balances, recent transactions, and KYC details. | None |
| `npm run demo:transaction` | Previews the assigned account, asks for a GBP withdrawal amount, and requests confirmation. | Inserts a completed withdrawal and deducts the amount from balance and available balance. |
| `npm run demo:kyc` | Shows current KYC and asks for confirmation before setting `REVIEW_REQUIRED / HIGH`. | Updates KYC if needed. |
| `npm run demo:kyc:reset` | Asks for confirmation before restoring the fixed KYC baseline `VERIFIED / LOW`. | Updates KYC if needed; does not reverse withdrawals or restore balances. |
| `npm run demo:verify` | Checks source transaction/KYC records and compares source values with TapData published APIs, reporting PASS/FAIL. | None |
| `npm run realtime -- --duration 5m --interval 15s` | Generates banking and customer activity for five minutes, with a 15-second delay between cycles. | Inserts and updates records in the tables below. |

Transaction and KYC prompts default to **No**. Answer `y` to confirm; cancelling submits no mutation. Each confirmed transaction creates a new withdrawal. Run writing commands only against the assigned demo environment.

Verification normally needs no extra arguments. To check a particular stage or transaction:

```bash
npm run demo:verify -- --stage transaction
npm run demo:verify -- --stage kyc
npm run demo:verify -- --stage api --transaction-id RT-...
```

Realtime accepts configurable duration and interval, such as `--duration 2m --interval 10s`, subject to your partner's service limits. It reports a job ID, progress, status, and a final summary. Press **Ctrl+C** to request cancellation and allow the current database operation to finish safely. Partners run independent jobs; the service permits one active job per partner.

## How the demo works

1. You execute a command in the Feeder CLI.
2. The Hosted Service authenticates your token and runs the operation using your partner's server-side database configuration.
3. TapData independently captures committed source changes through its configured CDC tasks.
4. `demo:verify` reads source records and the corresponding TapData published APIs to check that the expected values match.

Realtime repeatedly generates source activity for the requested duration. It can select matched customers/accounts throughout the assigned schemas, beyond the interactive demo account. Some activities are randomly selected, so a short run may not change every table. The final summary shows insert/update counts by table.

## Database tables and operations

| Database | Table | Operations | Changes generated |
|---|---|---|---|
| IBM i / AS400 (DB2) | `ACCOUNT_TRANSACTION` | INSERT, UPDATE | Creates transactions. Realtime transitions pending transactions to completed/posted or rejected; the interactive withdrawal is inserted as completed/posted. |
| IBM i / AS400 (DB2) | `BANK_ACCOUNT` | UPDATE | Adjusts balance and available balance for posted transactions. |
| Oracle | `CUSTOMER_PROFILE` | UPDATE | Changes the preferred customer channel during realtime activity. |
| Oracle | `CUSTOMER_KYC` | UPDATE | Changes KYC status and risk rating through confirmed KYC commands or realtime activity. |
| Oracle | `CUSTOMER_INTERACTIONS` | INSERT | Adds customer service interactions during realtime activity. |
| Oracle | `CUSTOMER_OFFERS` | UPDATE | Changes an existing customer offer's status during realtime activity. |

The assigned schemas and demo records must already exist. Feeder commands do not provision schemas or TapData pipelines.

## Basic troubleshooting

| Problem | What to check |
|---|---|
| Authentication failed | Check `DEMO_API_TOKEN`. Ask the operator whether the token expired, was revoked, or the partner was disabled. |
| Cannot reach the Hosted Service | Check `DEMO_API_URL`, network access, service availability, and certificate trust. `localhost` refers to your own computer. Ask the operator for the correct address or CA certificate; do not disable TLS verification. |
| Verification reports FAIL | Check the reported source/API values. CDC may still be synchronizing; wait and rerun **verification**. If it continues failing, ask the operator to check published API configuration and the separately managed TapData tasks. Realtime activity can also change records during comparison. |
| Realtime options rejected | Use duration/interval values allowed for your partner. Remote unlimited jobs are not supported. |
| A mutation or job request times out | The operation may still have executed. Retain the reported idempotency key or job ID and contact the operator before submitting another writing command. |

Jobs do not resume after a service restart. Cancellation stops future work; it does not undo committed changes. A run spanning both databases is not one atomic transaction.

## Local mode and further documentation

The example configuration recommends remote mode. To use local mode, change its active setting to `FEEDER_MODE=local` and uncomment/configure the relevant settings under **Optional: Local Mode**. Local mode connects directly to databases and requires source credentials and runtime dependencies. For backward compatibility, installations that omit `FEEDER_MODE` entirely still use local mode.

- [Technical guide](docs/technical-guide.md): local setup, JDBC/ODBC requirements, verification settings, API contracts, realtime limits, and developer testing.
- [Validation report](docs/phase6-validation.md): installation/platform checks and deployment limitations for service operators.
