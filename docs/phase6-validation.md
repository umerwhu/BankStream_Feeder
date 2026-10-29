# Phase 6 implementation and validation

**Current command surface:** six partner commands are supported: status, transaction, KYC update, KYC reset, verification and realtime. The additional dry-run command/endpoint is retained for read-only source connectivity checks. Operator administration, diagnostics and validation tools remain.

**Architecture update:** the later simplification removes the task/connection ID and MongoDB FDM/MDM metadata requirements described in this historical report. Partner configuration now covers source databases, demo assignments, published API verification and limits. Legacy pipeline metadata is ignored; pipeline administration belongs entirely to TapData. See the current service README for onboarding. The production release pin remains outstanding.

Validated 2026-10-29. Banking sources and TapData were mocked; no live database mutations, schema changes, task changes, commits, pushes or public deployment were performed.

## Release status

Dynamic registry, operator administration, runtime profiles and portability validation are implemented. **Independent production installation remains blocked on a real immutable Feeder release containing the hosted interface.** The current hosted changes are uncommitted; the older repository HEAD does not provide that interface. No incompatible commit, floating branch, local filesystem dependency or fictitious package version was substituted.

The service's `dependency:pin` command installs an approved exact package version, full Git commit or immutable HTTPS npm archive and updates its manifest/lockfile. `release:check` checks the declaration, lockfile, installed package and shared interface. Production rejects an absent pin and development overrides. Until a release is supplied, development requires an explicit `FEEDER_PATH`; this is not the independent production deployment deliverable.

## Architecture and administration

The service persists partner metadata separately from protected credential records. Each reference-format partner owns source schemas, credential references, demo assignments, TapData API/task/connection assignments, FDM/MDM namespaces and limits. Authentication resolves a frozen execution context. No environment-variable switching or banking implementation copying is used.

The local operator CLI supports `init`, `secret:set`, `register`, `update`, `enable`, `disable`, `token:issue`, `token:rotate`, `token:revoke`, `validate`, `list`, `status` and `remove`. Registry changes reload without restarting. Writes are serialized and atomically replaced. Tokens are random 32-byte values; only SHA-256 hashes are persisted, with expiration/revocation metadata. Plaintext issuance output must be delivered securely.

Onboard by storing credential objects, registering the complete partner document, validating configuration/runtime, issuing a token and enabling access. Update preserves identity/tokens; explicit enable/disable changes access. Disable rejects new requests and cancels the partner's jobs at safe boundaries. Offboard only after disabling, settling jobs and reconciling pending intents; removal retains a permanent ID tombstone and never deletes remote data or secrets.

Source/API/task/Mongo assignment overlaps are rejected. Per-partner mutation locks, durable idempotency, uncertainty handling and output ownership from earlier phases remain. Single-instance journal storage and one active job per partner remain intentional limits. Global request/job caps and tighter partner policies are configurable. Revoking a token prevents subsequent requests; disabling a partner also stops accepted jobs.

Metadata validation does not prove database grants, physical endpoint aliases, MongoDB permissions or TapData ACLs. Operators must establish least-privilege users, pipeline/target isolation and scoped published API credentials on those systems. MongoDB assignments are ownership metadata; this service does not connect directly to MongoDB.

## Dependency and driver audit

| Component | Result |
|---|---|
| Mandatory Feeder/service package | dotenv 16.6.1, locked |
| Database Node packages | Feeder optional dependencies: oracledb 6.10.0, odbc 2.6.0; loaded only for required operations |
| Remote-only installation | `npm ci --omit=optional`; no Java, JDBC, ODBC, Oracle module/client or source credentials required |
| Oracle local/hosted | Thin mode; install the reviewed optional adapter; no Instant Client initialization |
| IBM i JDBC | JDK 11+ with jdk.compiler, source launcher and JT400 21.0.6 |
| JDBC artifact | Explicit official Maven download with SHA-256 `0b3fbdc17486b57038c6f64aa38a3d488b576986e8bd5d7f85bbcdac24b264b7`; package artifacts exclude JARs |
| IBM i ODBC | Node adapter plus separately installed IBM i Access ODBC/system manager and native build prerequisites as applicable |
| Node | Node 24 tested; engine floor 20 preserved for compatibility, use a supported release for deployment |
| Production Feeder dependency | Pending immutable release; fail-closed guard implemented |

No broad dependency upgrades were made. Java, OS ODBC drivers and vendor access are external prerequisites; npm does not provision them. macOS is untested; confirm vendor architecture/support before using local adapters. Driver prerequisites and upstream license links are in both READMEs.

Application/runtime/configuration paths are resolved from the installed application. An explicit external path is permitted for operator-managed mounts; there is no implicit sibling/default development-drive lookup. The existing service JDBC path was migrated to its checksum-verified `runtime/drivers` artifact, without changing credentials or schemas. Existing legacy partner files remain supported in development; production requires complete credential-reference metadata.

Package whitelists exclude private config, .env, keys, runtime data, staging files, DDL and bulk scripts. A tracked DDL static password example was found and excluded from distribution; it did not match configured source passwords. User source fixtures were preserved. Private dependency authentication must use an SSH agent/deploy key or external credential helper rather than embedded URL secrets.

## Executed tests

| Check | Windows x64 | Linux x64 |
|---|---|---|
| Feeder complete suite | 100/100 | 100/100 |
| Service complete suite | 36/36 | 36/36 |
| Clean remote npm ci, native adapters absent | Passed | Passed |
| Remote doctor with no Java/runtime credentials | Passed | Passed |
| Service clean npm ci, HTTPS package dependency, no sibling checkout | Passed | Passed |
| Existing remote commands over trusted HTTPS with mocked sources | Passed | Passed |
| Service startup from unrelated working directory | Passed | Passed |

Windows: Node 24.15.0/npm 11.12.1. Linux: Node 24.22.2/npm 11.19.1 in official image `node:24-bookworm@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413`. This was actual Linux execution through Docker, not a platform mock. macOS was not executed. No real database driver/server connectivity is claimed.

Clean tests used separate OS temporary directories, stripped development credentials/configuration, trusted ephemeral TLS, locked installs, and whitelisted npm artifacts. The Feeder was installed as an HTTPS package dependency in that isolated test. This proves installation mechanics, not publication of a production release. Machine-readable local reports are ignored under `runtime/phase6-portability.json` and `runtime/phase6-linux-portability.json`.

Configuration-only multi-partner tests cover registration/update, persistence, disable/enable, token issue/rotation/revocation, assignment rejection, correct schema/credential/API resolution, concurrent jobs, independent cancellation and denied cross-partner access. Existing withdrawal/KYC/verification/idempotency/uncertain-commit regression suites also pass.

## Installation and startup

Feeder remote-only, from its checkout:

```text
npm ci --omit=optional
```

Copy `.env.example` to `.env`, set `FEEDER_MODE=remote`, the HTTPS `DEMO_API_URL` and issued `DEMO_API_TOKEN`, then:

```text
npm run doctor
npm run demo:status
```

All six partner commands remain. Transaction, KYC and realtime commands can mutate the assigned sources; execute only against an approved environment. For local mode install the required optional adapters, provision the system prerequisites, configure local source settings and run doctor. See the Feeder README for each runtime profile.

Service release preparation, once an approved commit exists:

```text
npm run dependency:pin -- "git+ssh://git@<git-host>/<org>/<feeder-repo>.git#<full-40-character-reviewed-commit>"
npm run release:check
```

Retain the generated package.json and package-lock.json. On the target server:

```text
npm ci --include=optional
npm run release:check
npm run driver:jt400
npm run admin -- init
```

Configure `.env` and TLS, provision the JDK/ODBC prerequisites for the chosen profile, and follow the service README's protected credential-file/onboarding commands. Do not run init over existing configuration. Then:

```text
npm run admin -- validate <partner-id> --runtime
npm start
```

Use `npm.cmd` in PowerShell where script execution policy blocks `npm.ps1`. Reproduce clean tests from the Feeder using an explicit service checkout argument:

```text
npm run portability:check -- --service <service-checkout>
npm run portability:linux -- --service <service-checkout>
```

The Windows validation requires OpenSSL; Linux validation requires a working Linux Docker engine and image download access. Neither command starts a public deployment or uses actual protected partner configuration.
