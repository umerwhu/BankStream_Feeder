# BankStream Feeder technical guide

This guide covers local database execution, runtime dependencies, remote API contracts and operational limits. For partner installation and commands, see the [README](../README.md).

## Installation and portability

See the [Phase 6 validation report](phase6-validation.md) for executed Windows/Linux checks, the dependency/driver audit, onboarding workflow and outstanding production release pin.

Use a currently supported Node.js LTS release; Windows Node 24 is tested. The declared engine floor of 20 preserves compatibility but is not a recommendation to deploy an end-of-life release. Check the [Node release schedule](https://nodejs.org/en/about/previous-releases).

Remote-only installation requires no Java, JAR, ODBC or Oracle client installation:

```bash
npm ci --omit=optional
```

On Windows PowerShell, use `npm.cmd` if the execution policy blocks `npm.ps1`; changing execution policy is unnecessary. On Linux/macOS use `npm`. Copy `.env.example` to an untracked `.env` (`Copy-Item` on PowerShell or `cp` on POSIX), set remote mode/URL/token, then run `npm run doctor`. Only `dotenv@16.6.1` is mandatory. Database packages are optional, lazy-loaded and omitted by the remote profile, including installation scripts. The package whitelist excludes real environments, configuration, private keys, JARs, staging directories and source-schema/sample-data scripts.

For local database execution:

```bash
npm ci --include=optional
npm run driver:jt400
npm run doctor
npm run demo:status
```

The JDBC installer downloads JT400 21.0.6 from Maven Central, verifies a pinned SHA-256 and refuses to overwrite a mismatched existing file. Configure `DB2I_JT400_JAR=./runtime/drivers/jt400-21.0.6.jar`. A previously configured JAR remains supported. The tracked legacy JAR is preserved for existing source checkouts but excluded from npm distributions; packaged/local deployments acquire the official artifact explicitly. Upstream licensing/notices are maintained by [IBM JTOpen](https://github.com/IBM/JTOpen/blob/main/LICENSE.md). The installer does not install Java or operating-system drivers.

To use ODBC, omit `DB2I_JT400_JAR` and install IBM i Access's matching system driver/DSN separately. Optional npm installation can fail without failing the overall install: always run the doctor and check its results. If you use a selected adapter rather than all optional adapters, install the exact pinned `oracledb@6.10.0` and/or `odbc@2.6.0` with `--no-save --package-lock=false`; retain the reviewed application lockfile.

| Connection path | External prerequisites | Platform notes |
|---|---|---|
| Remote CLI | Node, HTTPS URL/token, network/CA trust | No database packages, Java or source credentials |
| IBM i JDBC | JDK 11+ source launcher, verified JT400 JAR | No native ODBC binding needed; Java command comes from PATH or explicit JAVA_COMMAND |
| IBM i ODBC | Node odbc package plus vendor driver/DSN | Windows: IBM i Access package and compatible native build tools if no prebuild. Linux: IBM i Access plus unixODBC development/system libraries. macOS: vendor package/unixODBC; not validated here |
| Oracle | Node oracledb package | This application uses default Thin mode; Oracle 12.1+ and no Instant Client libraries. Thick mode/older databases need separate implementation and validation |

See [Oracle's versioned installation guide](https://node-oracledb.readthedocs.io/en/v6.7.0/user_guide/installation.html), [IBM node-odbc prerequisites](https://github.com/IBM/node-odbc), and [IBM i driver installation](https://ibmi-oss-docs.readthedocs.io/en/latest/odbc/installation.html). `npm ci` does not install OS-level drivers, a JDK or Oracle client libraries.

The six demo commands and `dry-run` work in either mode. A partner may also run an independently installed private Control Service and use the same remote CLI against it. The service supplies all partner-specific source/TapData secrets; never copy server secret storage to the partner CLI.

`npm run dry-run` remains available in local and remote modes. It runs read-only SELECT connectivity checks against both source databases. Remote mode uses the authenticated partner configuration on the service; no source credentials or drivers are needed locally. `doctor` remains a non-connecting configuration/runtime diagnostic.

The non-connecting doctor checks configuration/runtime availability; it does not prove credentials, grants, connectivity or replication isolation. Missing optional packages have actionable errors. For a controlled clean-install check, run `npm run portability:check -- --service <explicit-control-service-checkout>`. That test exports whitelisted files into unrelated temporary directories, installs the Feeder dependency through an ephemeral trusted HTTPS npm artifact, and uses mocked sources. It does not publish a release. Production pinning still requires the reviewed immutable release described in the Control Service README.

## Execution mode

The six main demo commands are `demo:status`, `demo:transaction`, `demo:kyc`, `demo:kyc:reset`, `demo:verify` and `realtime`. In remote mode the CLI sends authenticated HTTPS requests; the service resolves the partner's server-side configuration and runs the shared Feeder business logic. Partner setup needs only remote mode, the service URL and API token. Database and TapData published API credentials stay on the service.

Neither project configures or manages TapData replication tasks, FDM, MDM or pipelines. Manage those separately in TapData. `demo:verify` only reads source records and the corresponding published APIs, preserving verification options and PASS/FAIL comparisons. These commands and `dry-run` work in local and remote modes.

The supplied `.env.example` selects `FEEDER_MODE=remote` for partners. Local mode remains supported by explicitly selecting `FEEDER_MODE=local`; the fallback when the variable is entirely absent remains local for backward compatibility.

Remote mode supports **all existing commands**, including `realtime`:

```ini
FEEDER_MODE=remote
DEMO_API_URL=https://demo.example.com
DEMO_API_TOKEN=<assigned-partner-token>
DEMO_API_TIMEOUT_MS=150000
```

Run the same npm commands in either mode. Remote transaction and KYC commands preview the assigned data and ask for confirmation before submitting mutations. Remote commands avoid database driver imports and require no source database or TapData credentials locally. Keep tokens in an untracked `.env` file. The service URL must use HTTPS without embedded credentials, query parameters, or fragments; requests use fixed `/api/demo/...` paths at that origin. Redirects are rejected.

The status API returns JSON `{ "version": 1, "result": { "customer": {}, "transactions": [], "kyc": [] }, "exitCode": 0 }`, where `result` contains the existing status operation's customer row, transaction rows, and Oracle KYC row array (at least four columns). The hosted backend is a separate project; production does not require a sibling checkout.

### Remote transaction contract

Both endpoints require bearer authentication and the same version-1 response envelope:

- `GET /api/demo/transaction/preview` returns `result: { previewId, account }`. `account` is the existing `readWithdrawalAccount()` result: `customerId`, `customerName`, `accountId`, `currency`, `accountStatus`, `balance`, and `availableBalance`. `previewId` is an opaque, short-lived reference bound server-side to the authenticated partner, assigned customer/account, and configuration revision. References must contain 1–256 URL-safe letters, digits, dots, underscores, tildes or hyphens.
- `POST /api/demo/transaction` receives JSON `{ "amount": "12.50", "previewId": "...", "confirmed": true }` and an `Idempotency-Key` header containing a newly generated UUID. It returns the existing `transaction()` result, including transaction ID, amount/currency, previous/new balances and available balances, transaction timestamp and completion timestamp. Decimal amounts and balances in this response are strings.

The client sends no partner ID, schema, account selection or connection settings. Before execution, the hosted service must authenticate, resolve its own partner configuration, validate confirmation/amount and the preview's ownership, expiry and assignment, then reread the account and invoke the existing `transaction()` implementation. Retain its active-customer, account/currency and locked balance/available-funds checks. Reject invalid or stale previews with a safe error (such as HTTP 409); never execute based solely on the client's preview or amount validation.

The service must persist idempotency records scoped to the authenticated partner and operation, bind each key to the request payload, reject changed-payload reuse, and serialize concurrent requests using the same key. A completed replay returns the recorded result without another withdrawal, even if its original preview has since expired. Coordinate the idempotency record and database commit/reconciliation so a crash cannot cause a second withdrawal. The separate Control Service implements these safeguards using the shared Feeder operations.

The CLI submits once, only after confirmation. A failed submission reports its idempotency key because a timeout or lost response may occur after commit. Retain that key for operator reconciliation; do not rerun the command as a retry, since a new invocation generates a new key. No automatic replay or reconciliation command is provided.

### Hosted service integration

The independently installed `BankStream_Demo_Control_Service` implements status, transaction, verification, KYC update/reset, dry-run and realtime job APIs. Its README documents protected partner configuration, token issuance, local HTTPS testing, idempotency recovery and production dependency pinning. Production installs a reviewed immutable Feeder package dependency. `FEEDER_PATH` is only an explicit development override; no sibling checkout is assumed. The service uses the side-effect-free `banking-customer360-demo/service` interface (`src/hosted-service.js`) with explicit partner configuration and existing business logic; it never loads this CLI or this project's `.env`.

Authentication failures, network failures, invalid responses and timeouts print a safe error and exit with code 1. The optional timeout accepts 1–300000 milliseconds. Without an override, verification allows 150 seconds for source checks and CDC/API comparisons; other requests allow 30 seconds. Responses are limited to 1 MiB. Requests are not retried automatically.

### Hosted realtime jobs

With `FEEDER_MODE=remote`, `DEMO_API_URL` and `DEMO_API_TOKEN` configured, run `npm run realtime -- --duration 5m --interval 15s`. The CLI starts the authenticated partner's server-managed job and reports progress/status until completion. Ctrl+C requests cancellation, respects the server polling interval and retrieves final output before exiting. No database driver or source credentials are needed on the partner computer.

The existing command works in both modes:

```powershell
npm.cmd run realtime -- --duration 5m --interval 15s --events-per-cycle 1
```

Local mode retains the existing generator, recovery, scheduling, retry behavior and summaries, including `--duration unlimited`. Remote mode sends only the parsed duration/interval/event count, plus a new job-creation idempotency key, to the hosted service. No source driver or credentials are needed on the CLI computer. The service runs the same generator in an isolated execution context, with its assigned schemas and connections.

The remote CLI prints its job ID, polls at two-second intervals or longer when required by the service, displays only new sequenced output and exits on completion. Ctrl+C requests cancellation of that job, waits for the current event to settle, and prints its final state/summary. Exit codes: `0` completed, `1` failed/completed with errors, `130` clean cancellation. Repeated Ctrl+C does not cancel other jobs. A failed poll/stop reports the job ID because it may still be running. A lost start response reports the idempotency key: reconcile or replay the identical start request with that key rather than starting a fresh job.

Hosted limits: duration 1 second–1 hour, interval 1 second–1 hour, 1–10 events per cycle, one active job per partner and, by default, four active jobs globally. Global concurrency and tighter per-partner limits are configured by the service operator. Remote unlimited jobs are rejected. Different partners run concurrently. Each event (including recovery and source updates) holds the existing partner mutation lock; verification/KYC/transactions can run between events. A long database operation or verification can delay scheduling. Cancellation and duration expiry stop subsequent events, not already committed writes.

The service keeps at most 256 output entries per job (1 KiB each), 100 full job objects and 1000 durable job-creation records. A cursor gap is reported when old output has expired; persisted final counts remain available. Running jobs do not survive service restart: interrupted jobs become Failed and are never replayed. Uncertain event intents block further mutations for that partner pending manual reconciliation. Counts describe acknowledged commits; both databases are not one atomic transaction. Completed event intents remain archived on disk rather than in the live memory index. Journal backups/retention and ledger-capacity maintenance are operator responsibilities; never discard pending records or idempotency keys to unblock work.

For local manual testing, restart the updated Control Service, configure its HTTPS certificate and partner token as documented in its README, then use the command above with `FEEDER_MODE=remote` against an approved test tenant. Realtime changes transactions and Oracle profile/KYC/interaction/offer data across matched records in the assigned schemas. `npm.cmd test` in both projects exercises the same code with mocked databases without modifying live data.

### Verification and KYC

`npm run demo:verify` now checks source transactions, source KYC, and source-to-TapData balances/transactions/KYC in **both local and remote modes**. Local mode needs valid TapData settings; remote mode uses only the authenticated partner's server-side TapData configuration. Missing configuration or failed comparisons return exit code 1, never a silent source-only PASS. Existing stage flags remain available:

```powershell
npm.cmd run demo:verify
npm.cmd run demo:verify -- --stage transaction
npm.cmd run demo:verify -- --stage kyc
npm.cmd run demo:verify -- --stage api --transaction-id RT-...
```

Remote KYC update/reset first calls `GET /api/demo/kyc/preview`, displays the current state, then uses the existing `y/N` prompt. A confirmed POST to `/api/demo/kyc` or `/api/demo/kyc/reset` carries only `{ previewId, confirmed: true }` plus a new `Idempotency-Key` header. Cancellation sends no POST. Reset remains fixed to `VERIFIED / LOW` for the assigned customer; there is no arbitrary reset API. Stale/foreign/expired previews fail without an update. Retain the idempotency key on uncertain failures and reconcile before starting another mutation.

Verification uses `/api/demo/verify` with optional `stage`/`transactionId`, returns the existing PASS/FAIL reports, and runs under the partner's mutation lock. A FAIL comparison is an HTTP 200 result with `exitCode: 1`; the CLI exits 1. Other service failures return safe non-success HTTP statuses.

For safe local testing, run `npm.cmd test` in both projects. Service tests mock databases and TapData and include actual CLI calls over local HTTPS. To manually test an already configured local service, follow its HTTPS/certificate/token instructions, then run `demo:status` and `demo:verify` with `FEEDER_MODE=remote`. KYC previews can be cancelled with `n`; confirming KYC or transactions against live data requires approval.

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

- A supported Node.js LTS release and npm (Node 24 is the validated baseline; the engine floor remains 20 for compatibility).
- Reachable Oracle and IBM i Db2 databases, with matching customer/account demo records already loaded.
- Runtime database users with read and write access to the required tables.
- A JDK 11+ including `jdk.compiler` for JDBC source-file launch, plus the verified JT400 JAR. These are not needed remotely or when using ODBC.

Create the database tables and load the initial records before running the feeder. The setup scripts are in [`ddl/`](../ddl/) and [`bulk-data/`](../bulk-data/).

## Configure

Copy the example file and edit `.env` with your database connection details:

```sh
cp .env.example .env
```

In PowerShell, use `Copy-Item .env.example .env` instead. For local execution, change the active mode to `FEEDER_MODE=local` and uncomment the needed settings under **Optional: Local Mode**. Set the Oracle user, password, connect string, and schema (`ORACLE_*` variables). For IBM i, configure either the DSN or host-based connection, schema, user, and password. Uncomment the installed JT400 path for JDBC, or leave it commented for ODBC. Configure TapData published API access for default verification. Keep `.env` private; it is excluded from Git.

The optional Customer 360 demo settings select the customer and linked account used by the demo commands. Defaults are customer `100002`, account `AC1000021`, and a default configured amount of `GBP 200`. The interactive command asks for a dynamic amount; currency remains `GBP`.

For default local verification or the API stage, configure the TapData values in `.env` using the real environment details supplied by your TapData administrator. Replace the `example.invalid` URLs and dummy client values from `.env.example`; they cannot connect to a service. `TAPDATA_API_BASE_URL` is the TapData API host/base URL (the command appends `/api/v1/MDM_CUSTOMER360` and `/api/v1/CUSTOMER_KYC`). Set either a valid `TAPDATA_ACCESS_TOKEN`, or `TAPDATA_TOKEN_URL`, `TAPDATA_CLIENT_ID`, and `TAPDATA_CLIENT_SECRET` with the authentication method supported by your TapData deployment. Keep all credentials in `.env` only; never commit them. The Customer 360 and KYC API paths and collection names should match the published TapData services.

## Quick start

From the project folder, run:

```sh
npm ci
npm run demo:status
npm run realtime -- --duration 5m --interval 15s
```

`demo:status` reads the assigned source records without writing data. The real-time command runs for five minutes; press **Ctrl+C** to stop earlier.

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
- `demo:transaction` creates one completed withdrawal for the confirmed dynamic GBP amount and deducts it from the account balance and available balance in the same database transaction. Type the requested confirmation when prompted. Each confirmed run creates a new withdrawal.
- `demo:kyc` reads Oracle KYC for the configured `DEMO_CUSTOMER_ID` and asks `Confirm KYC update? (y/N):` before setting `REVIEW_REQUIRED / HIGH`. It updates any current KYC state after confirmation and makes no change if those target values are already set.
- `demo:verify -- --stage transaction` checks the latest posted completed GBP withdrawal, customer/account relationship and source stability. Add `--transaction-id RT-...` to check an exact transaction.
- `demo:verify -- --stage kyc` reads current Oracle KYC for `DEMO_CUSTOMER_ID`; it reports retrieval separately and passes only for the documented demo states `VERIFIED / LOW` or `REVIEW_REQUIRED / HIGH`.
- `demo:verify -- --stage api` reads the current source account and latest completed withdrawal directly from DB2, plus current KYC for `DEMO_CUSTOMER_ID` from Oracle, then compares these values with the published TapData `MDM_CUSTOMER360` and `CUSTOMER_KYC` APIs. It is read-only, retries for CDC synchronization, reports each source/API value and PASS/FAIL, and returns a failure exit code when required fields do not match or cannot be found. Add `--transaction-id RT-...` to compare a specific DB2 transaction.
- `demo:verify` with no stage runs source transaction, source KYC, and TapData API comparisons in both execution modes.
- `demo:kyc:reset` reads Oracle KYC for `DEMO_CUSTOMER_ID` and asks `Confirm KYC reset? (y/N):` before setting the fixed demo baseline `VERIFIED / LOW`. It makes no change if already at that state. No local KYC JSON is read or written. This reset intentionally changes any other current state to the fixed demo baseline after confirmation; the repository's Oracle sample data seeds customers `100002` and `100011` as `VERIFIED / MEDIUM`.

The status and verify commands are read-only. The API comparison uses a configurable CDC wait (`DEMO_API_CDC_RETRY_INTERVAL_MS`, default `2000`; `DEMO_API_CDC_TIMEOUT_MS`, default `30000`) so newly committed source changes have time to appear in TapData. `TAPDATA_REQUEST_TIMEOUT_MS` (default `15000`), `TAPDATA_PAGE_SIZE` (default `200`), and `TAPDATA_SCAN_LIMIT` (default `1000`) control API requests and record scanning. The transaction, KYC, and KYC reset commands change remote database records only after interactive confirmation. The local demo does not depend on runtime baseline or transaction JSON files. The hosted service persists its own idempotency journal. KYC reset does not reverse withdrawals or restore account balances.

## Verify changes

After the real-time run, check its execution summary for insert and update counts by table. Confirm the corresponding records or updated values in your demo databases. Counts can be zero for tables whose events were not selected during that run.
