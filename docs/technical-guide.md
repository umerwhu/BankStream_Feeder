# BankStream Feeder technical guide

Use the [README](../README.md) for the partner quick start. This guide explains configuration, local dependencies, command behavior, and troubleshooting.

## How the Feeder works

The Feeder writes banking transactions and customer updates to IBM i (AS/400, DB2) and Oracle. TapData captures committed changes through separately configured CDC tasks. `demo:verify` reads source records and TapData published APIs to check the results.

The source schemas, sample records, customer/account relationships, and TapData pipelines must already exist. The Feeder does not create or manage TapData tasks, FDM, MDM, or pipelines. Database setup files are in [ddl](../ddl/) and [bulk-data](../bulk-data/).

## Remote Mode (recommended for partners)

The CLI sends HTTPS requests to a separate BankStream Demo Control Service. The service holds your partner's database credentials, TapData settings, and assigned customer/account IDs. Database settings in the CLI's `.env` do not change that assignment.

Use Node.js 24 (the validated baseline) and npm. From the project folder:

```bash
npm ci --omit=optional
```

Copy `.env.example` to `.env` using `cp .env.example .env` on macOS/Linux or `Copy-Item .env.example .env` in PowerShell. Set:

```ini
FEEDER_MODE=remote
DEMO_API_URL=https://demo.example.com
DEMO_API_TOKEN=replace_with_partner_token
```

Use the URL and token supplied by your operator. The URL must use HTTPS without embedded credentials, query parameters, or fragments. Keep `.env` and tokens private.

```bash
npm run doctor
npm run dry-run
npm run demo:status
```

`doctor` checks configuration without connecting. `dry-run` checks both database connections using read-only queries. `demo:status` also checks that the assigned demo records can be read.

Remote partners do not need database drivers or Java. In PowerShell, use `npm.cmd` if execution policy blocks `npm`.

### HTTPS certificates

For a private or self-signed service certificate, obtain the trusted certificate from your operator. Set `NODE_EXTRA_CA_CERTS` before starting Node.js; do not disable TLS verification.

PowerShell:

```powershell
$env:NODE_EXTRA_CA_CERTS = 'C:\certificates\service-ca.pem'
npm.cmd run dry-run
```

macOS/Linux:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/service-ca.pem
npm run dry-run
```

The certificate must also cover the hostname or IP used in `DEMO_API_URL`.

## Local Mode (your own databases)

Deploy and configure your own Oracle and IBM i sources, with demo records and read/write permissions on the required tables. Follow **Optional: Local Mode** in [.env.example](../.env.example).

1. Set `FEEDER_MODE=local`.
2. Configure the database connections below.
3. Install the required drivers.
4. Run `doctor`, `dry-run`, and `demo:status`.

| Connection | Settings and dependencies |
|---|---|
| Oracle | Set `ORACLE_USER`, `ORACLE_PASSWORD`, `ORACLE_CONNECT_STRING`, and `ORACLE_SCHEMA`. Requires `oracledb@6.10.0`. The application uses Thin mode; no Oracle Instant Client is needed. |
| IBM i through JDBC | Set `DB2I_HOST`, `DB2I_USER`, `DB2I_PASSWORD`, `DB2I_SCHEMA`, and `DB2I_JT400_JAR`. Requires JDK 11+ including `jdk.compiler` and the JT400 JAR. `DB2I_JDBC_URL` can override the JDBC URL; `JAVA_COMMAND` can select Java. |
| IBM i through ODBC | Leave `DB2I_JT400_JAR` unset. Configure `DB2I_DSN` or `DB2I_HOST`, plus credentials and schema. Host connections use `DB2I_DRIVER`. Requires `odbc@2.6.0` and the IBM i Access system driver; Linux also needs unixODBC prerequisites. |

Install local dependencies:

```bash
npm ci --include=optional
```

For JDBC, also run:

```bash
npm run driver:jt400
```

The installer downloads and verifies JT400. Set:

```ini
DB2I_JT400_JAR=./runtime/drivers/jt400-21.0.6.jar
```

It does not install Java or system drivers. Optional npm packages can fail to install without failing the whole installation, so check:

```bash
npm run doctor
npm run dry-run
npm run demo:status
```

Use the actual source schema names. Local demo commands use `DEMO_CUSTOMER_ID` and `DEMO_ACCOUNT_ID`, defaulting to `100002` and `AC1000021`. These records must exist and have a current relationship in `ACCOUNT_CUSTOMER_RELATIONSHIP`. Set `FEEDER_MODE` explicitly: omitting it falls back to Local Mode for compatibility.

## Demo commands

Commands work in both modes. Transaction, KYC, and reset commands require an interactive terminal. Confirmation defaults to No; enter `y` to proceed.

| Command | Behavior |
|---|---|
| `npm run demo:status` | Reads the customer, linked account, balances, recent transactions, and KYC. |
| `npm run demo:transaction` | Asks for a GBP withdrawal amount and confirmation. Inserts a completed/posted withdrawal and reduces both balances in one IBM i transaction. Each confirmed run creates a new withdrawal. |
| `npm run demo:kyc` | Sets KYC to `REVIEW_REQUIRED / HIGH` after confirmation. Skips the update if already at that state. |
| `npm run demo:reset` | Offers KYC reset, balance reset, both, or cancel. Details below. |
| `npm run demo:verify` | Checks source transactions/KYC and compares balances, transactions, and KYC with TapData APIs. Read-only; reports PASS/FAIL. |
| `npm run realtime -- --duration 5m --interval 15s` | Generates source activity for five minutes with a 15-second delay between cycles. |

### Interactive reset

After you select an option, `demo:reset` fetches current source values and displays the relevant fields:

- **Reset KYC:** restores `VERIFIED / LOW`.
- **Reset Account Balances:** sets both `BALANCE` and `AVAILABLE_BALANCE` to `40000`.
- **Reset Both:** checks KYC and balances independently and resets only values needing changes.
- **Cancel:** exits without changing data.

If nothing needs resetting, it exits without confirmation or updates. Otherwise, it lists the pending changes and asks for confirmation. The summary reports SUCCESS, SKIPPED, or FAILED for selected operations and shows their available results. Reset keeps transaction history.

Oracle and IBM i commit separately. A partial failure can leave one change committed; follow the reported reconciliation guidance before retrying. The older `demo:kyc:reset` command remains available and only resets KYC; it never restores balances.

### Verification settings

Remote verification uses the service's TapData configuration. For Local Mode, configure the published APIs in `.env`:

- `TAPDATA_API_BASE_URL` and the collection/path settings in `.env.example`. Default collections are `MDM_CUSTOMER360` and `CUSTOMER_KYC`.
- Either `TAPDATA_ACCESS_TOKEN`, or `TAPDATA_TOKEN_URL`, `TAPDATA_CLIENT_ID`, and `TAPDATA_CLIENT_SECRET` with the supported `TAPDATA_TOKEN_AUTH_METHOD`.

Default verification includes source checks and API comparisons. Missing API settings or mismatched values cause failure. To limit the checks:

```bash
npm run demo:verify -- --stage transaction
npm run demo:verify -- --stage kyc
npm run demo:verify -- --stage api --transaction-id RT-...
```

Replace `RT-...` with a real transaction ID. The API comparison waits for CDC synchronization: `DEMO_API_CDC_TIMEOUT_MS` defaults to `30000`, and `DEMO_API_CDC_RETRY_INTERVAL_MS` to `2000`. Other API request and scan settings are listed in `.env.example`.

### Realtime behavior

Use `--duration`, `--interval`, and `--events-per-cycle` to control the workload:

```bash
npm run realtime -- --duration 5m --interval 15s --events-per-cycle 1
```

Realtime can change matched customers/accounts across the configured schemas, beyond the interactive demo account. Randomly selected activity may leave some tables unchanged during short runs. The final summary gives insert/update counts by table.

Remote limits allow duration and interval up to one hour, 1-10 events per cycle, and one active job per partner. Operators can set tighter limits. Unlimited duration is supported only in Local Mode.

Press **Ctrl+C** to stop future work and let the current operation finish. Cancellation does not undo committed changes. Remote jobs do not resume after a service restart. Realtime exits with `0` for completion, `1` for failure/errors, or `130` for clean remote cancellation.

## Troubleshooting

| Problem | Check |
|---|---|
| Cannot reach the service | Check the URL, network, service availability, and certificate trust. `localhost` points to the CLI computer. |
| HTTP 401/403 | Check the partner token and ask the operator about expiry, revocation, or disabled access. |
| HTTP 503 | Ask the operator to check server runtime dependencies, assigned schemas/records, and the installed Feeder version. A successful dry run proves connectivity, not that the demo tables exist. |
| Reset fails while status succeeds | Confirm the remote service and its installed Feeder dependency both include reset support. Updating the partner CLI alone does not update the server. |
| Table not found | Check the configured source schema and table permissions. In Remote Mode, fix the partner's server-side settings. |
| Verification FAIL | Review source/API differences, wait for CDC, and rerun verification. Check TapData API configuration and tasks if it persists. Realtime activity can affect comparisons. |
| Write or job request times out | It may have executed. Keep the idempotency key or job ID and contact the operator before submitting another writing command. |

`DEMO_API_TIMEOUT_MS` optionally sets the remote request timeout (1-300000 milliseconds). Without an override, verification allows 150 seconds and other requests 30 seconds. Requests are not retried automatically.

## Notes for service operators and developers

The Control Service is a separate project. Use its own README for deployment, partner configuration, logs, and release pinning. It loads the Feeder's `banking-customer360-demo/service` interface; it does not load the partner CLI's `.env`.

Deploy compatible service and Feeder versions. The server needs database runtime dependencies even though a remote-only CLI does not. After installing or updating the pinned Feeder dependency, ensure required optional drivers are installed and run the service's release/runtime checks before starting it. Production requires a pinned dependency; `FEEDER_PATH` is a development-only override.

Run the Feeder tests from this project:

```bash
npm test
```

Tests use mocked database/API operations. For platform validation details, see the [validation report](phase6-validation.md).
