# TapData Banking Demo — Import & Setup Guide

This guide explains how to restore the BankStream demo in a new TapData environment: **import replication tasks first, then transformation tasks, configure and test every connection, **start replication tasks, start transformation tasks, and finally import and publish the APIs****.

> **Before you start:** Use the three exported TapData packages listed below. The import UI and options may vary by TapData version.

The export packages listed below are in this folder. Use them when importing tasks and API services into TapData.

## 1. Required export files

| Import order | Package | File |
|---|---|---|
| 1 | Data replication (CDC) tasks | `replication-tasks_batch-20261023.json.gz` |
| 2 | Data transformation / merging tasks | `transformation_tasks_batch-20261023.json.gz` |
| 3 | Published API services | `Tapdata_API_module_batch-20261023.json.gz` |

These public export packages have been sanitized: saved database URIs and TapData user identifiers were removed. Update and test connections after import. Never commit raw exports or live database passwords, tokens, or API credentials.

## 2. Import replication tasks first

1. Open the TapData environment and navigate to the task import feature.
2. Import the **replication tasks** `.json.gz` package.
3. Check that the imported tasks reference the intended **IBM i / AS400**, **Oracle**, and destination connections.
4. Do not start tasks until their connections are configured and tested.

These tasks replicate source changes into the **FDM** layer.

## 3. Import transformation tasks second

1. Import the **transformation tasks** `.json.gz` package.
2. Check source and target mappings: **FDM → TapData merge/join/transform → MongoDB MDM**.
3. Confirm that the `MDM_CUSTOMER360` collection and other expected MDM collections are mapped correctly.
4. Review task dependencies and make sure the required FDM data is available before running transformation tasks.

## 4. Update and verify all connections

Open the connection settings in TapData and replace any environment-specific values with those of the target environment.

| Connection | Verify |
|---|---|
| IBM i / AS400 (DB2 for i) | Host, port, library/schema, username, password, permissions, and CDC/journaling prerequisites |
| Oracle | Host, listener port, service name/PDB, username, password, schema, and CDC prerequisites |
| FDM storage | Target host, database/schema, credentials, and write permissions |
| MongoDB MDM | URI/host, database, authentication, and required read/write permissions |
| Any additional imported connection | Host, credentials, mappings, and permissions |

**For every imported connection:** save the settings, run **Test Connection**, and confirm it succeeds. Check that all replication and transformation tasks point to the correct connection objects. Do not assume imported connection credentials are valid or automatically restored.

After all connections pass, start the tasks in the order below.

## 5. Start the tasks in order

**Step 1 — Start replication tasks (CDC)**

1. Open the imported **Replication** tasks in TapData.
<img width="2560" height="1305" alt="image" src="https://github.com/user-attachments/assets/12949179-c806-4ad1-b976-7d1c6031e75f" />

3. Start the replication tasks and check that they show a running/healthy status.
4. Confirm that data from Oracle and IBM i / AS400 is arriving in the **FDM** layer.

**Step 2 — Start transformation tasks**

1. Once FDM data is available, open the imported **Transformation** tasks.
2. Start the transformation tasks and check that they show a running/healthy status.
3. Confirm that TapData merges and transforms FDM data into **MongoDB MDM**, including `MDM_CUSTOMER360`.

**Step 3 — Import and publish APIs**

Only after the MDM collections contain the expected data, proceed to the API import and publishing steps below.

## 6. Import and publish the API services last

1. Navigate to the TapData API management page and use its **Import** function.
2. Import the API services `.json.gz` package.
3. Verify that each API uses the correct **MDM connection**, collection/table, service name, and path.
4. Publish the imported services if they are not already published.
5. Test the APIs and confirm they return expected records. Check authentication and access settings before exposing any endpoint.

### Expected published API services

Use the following **service names, table names, and paths** as shown in the reference screenshot. The common API prefix is `/v1`.

| Service name | MDM table / collection | API path |
|---|---|---|
| `MDM_CUSTOMER360` | `MDM_CUSTOMER360` | `/v1/MDM_CUSTOMER360` |
| `CUSTOMER_SERVICE_CASE` | `MDM_Oracl_BANKCRM_CUSTOMER_SERVICE_CASE` | `/v1/CUSTOMER_SERVICE_CASE` |
| `CUSTOMER_PREFERENCE` | `MDM_Oracl_BANKCRM_CUSTOMER_PREFERENCE` | `/v1/CUSTOMER_PREFERENCE` |
| `CUSTOMER_OFFERS` | `MDM_Oracl_BANKCRM_CUSTOMER_OFFERS` | `/v1/CUSTOMER_OFFERS` |
| `CUSTOMER_KYC` | `MDM_Oracl_BANKCRM_CUSTOMER_KYC` | `/v1/CUSTOMER_KYC` |
| `CUSTOMER_INTERACTIONS` | `MDM_Oracl_BANKCRM_CUSTOMER_INTERACTIONS` | `/v1/CUSTOMER_INTERACTIONS` |
| `CUSTOMER_CONSENT` | `MDM_Oracl_BANKCRM_CUSTOMER_CONSENT` | `/v1/CUSTOMER_CONSENT` |
| `CUSTOMER_CAMPAIGN_RESPONSE` | `MDM_Oracl_BANKCRM_CUSTOMER_CAMPAIGN_RESPONSE` | `/v1/CUSTOMER_CAMPAIGN_RESPONSE` |
| `TERM_DEPOSIT` | `MDM_BANKCORE_TERM_DEPOSIT` | `/v1/TERM_DEPOSIT` |
| `PAYMENT_INSTRUCTION` | `MDM_BANKCORE_PAYMENT_INSTRUCTION` | `/v1/PAYMENT_INSTRUCTION` |
| `PAYMENT_BENEFICIARY` | `MDM_BANKCORE_PAYMENT_BENEFICIARY` | `/v1/PAYMENT_BENEFICIARY` |
| `LOAN_REPAYMENT` | `MDM_BANKCORE_LOAN_REPAYMENT` | `/v1/LOAN_REPAYMENT` |
| `LOAN_ACCOUNT` | `MDM_BANKCORE_LOAN_ACCOUNT` | `/v1/LOAN_ACCOUNT` |

**Expected total: 13 published APIs.** Names are transcribed from the screenshot; verify capitalization and the `MDM_Oracl_...` spelling against the actual exported API definitions before importing or editing anything.

## 7. Final checklist

- [ ] Replication package imported
- [ ] Transformation package imported
- [ ] Every connection updated and tested successfully
- [ ] Replication tasks started first; FDM data available
- [ ] Transformation tasks started second; MongoDB MDM populated
- [ ] API services imported and published third
- [ ] API package imported and 13 services published
- [ ] Service names, MDM collections, and paths match the table above
- [ ] API requests return expected data

**End-to-end flow:** Oracle + IBM i / AS400 → TapData CDC → FDM → TapData merging/transformation → MongoDB MDM → TapData codeless APIs → BankStream AI Dashboard.
