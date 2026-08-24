# Deal Sheet BigQuery Sync - Firebase Functions

Sync deal sheet data from Nexus API to BigQuery using Firebase Functions.

## Project Structure

```
functions/
├── src/
│   ├── index.js              # Firebase Functions entry point
│   ├── config.js             # Configuration settings
│   ├── nexusClient.js        # Nexus API client
│   ├── bigQueryClient.js     # BigQuery operations
│   ├── columnMappings.js     # Data transformation mappings
│   ├── syncService.js        # Main sync orchestration
│   └── api/
│       └── dealSheetEnricher.js  # Parallel data enrichment
├── package.json
└── .eslintrc.js
```

## Functions

### 1. `dealSheetSync` (HTTP Triggered)
Manually trigger deal sheet sync to BigQuery.

**Endpoint:** `https://<region>-<project>.cloudfunctions.net/dealSheetSync`

**Query Parameters:**
- `only_new=true` - Only insert new deal sheets (skip existing `DEAL_SHEET_ID` in the **resolved** table per recruiter domain)
- `max_candidates=N` - Limit candidates processed
- `test_limit=N` - Limit submittals fetched (for testing)
- `bq_table` / `bq_dataset` - Optional; when omitted, rows go to `cynet_health_deal_sheet`, `cynet_health_canada_deal_sheet`, or `cynet_locums_deal_sheet` by `ASSIGNMENT_RECRUITER_EMAIL` domain
- `checkpoint_use_submittal_page=true` - With `resume=true`, Firestore stores the next Nexus job-submittals **page** number (survives flaky `next` links after socket errors). Scheduled active sync enables this by default.
- `use_ended_domain_routing=true` - Without `bq_table`, routes rows to ended tables (`cynet_health_ended_deal_sheet`, `cynet_health_canada_ended_deal_sheet`, `cynet_locums_ended_deal_sheet`) by recruiter email. Do not combine with `bq_table`.

**Examples:**
```bash
# Full sync
curl https://<region>-cynet-uat-projects.cloudfunctions.net/dealSheetSync

# New only (daily incremental)
curl "https://<region>-cynet-uat-projects.cloudfunctions.net/dealSheetSync?only_new=true"

# Test with 20 records
curl "https://<region>-cynetdatabase.cloudfunctions.net/dealSheetSync?max_candidates=20&test_limit=20"
```

### 2. `dealSheetSyncTrigger` (Scheduled — insert only)

Runs **hourly at :00** Eastern from **9:00 AM through 7:00 PM** (`09:00`–`19:00`). Writes to **domain-routed active** tables — no `bq_table` on the function.

- **Skips insert** if **`DEAL_SHEET_ID` or `PLACEMENT_ID`** already exists in BigQuery (checked before enrich and again at insert).
- **`append_on_change_by_dealsheet` is off** — no updates on this trigger; insert-only.
- Nexus submittals: **`PERM_STARTS,ACTIVE,BOOKED`** only; **full** job-submittals pagination each run (no Firestore page checkpoint).
- **First row** for net-new keys: **`STARTED` or `BOOKED`** only (`first_insert_placement_status_allowlist`).
- **Row filter:** `START_DATE >= 2026-01-01` (UTC).

Does **not** refresh existing deal sheets — use **`dealSheetSyncUpdateTrigger`** (runs **30 minutes later** each hour, 9:30 AM–7:30 PM Eastern).

### 2b. `dealSheetSyncUpdateTrigger` (Scheduled — updates)

Runs **hourly at :30** Eastern from **9:30 AM through 7:30 PM** (30 minutes after each insert trigger run).

1. Loads one target per **`DEAL_SHEET_ID`** from all three active domain tables (latest row per deal sheet). Rows with null deal sheet use **`PLACEMENT_ID`** as fallback only.
2. For each target (batched, env `DEAL_SHEET_UPDATE_TRIGGER_MAX_PAIRS` per run, default **500**): Nexus refresh by **deal sheet id** (or placement fallback) → enrich → compare **all business columns** to the **latest BigQuery row for that deal sheet** → **append** if different (ignores `ID`, `LAST_UPDATED`, `IS_REJECTED`). Does not create first rows.
3. Firestore checkpoint **`active-deal-sheet-update-cursor`** stores pair index when more composites remain; cleared after a full pass.
4. Same **`START_DATE >= 2026-01-01`** rule as insert.

### 3. `dealSheetSyncOfferRejected` (HTTP — manual)

Ended-style stream: submittals `EARLY_TERM,COMPLETED,CANCELLED,CANCELED` (override with `submittal_codes`), deal sheets **FINAL** only, **domain-routed ended** tables. **Placement filter** (after enrich): `DID NOT START`, `ENDED`, `ENDED<30`, `DID NOT ACCEPT`. **Tentative date:** `TENTATIVE_END_DATE >= 2026-05-01` (UTC). Logs each flush with prefix **`[offer-rejected-transform]`** (`enriched_in`, `after_placement_status_filter`, `after_tentative_date_filter`).

**BigQuery behaviour (aligned with scheduled active sync):** `append_on_change_by_dealsheet`, `generated_uuid_field: ID`, same `compare_ignore_fields`, and **`first_insert_placement_status_allowlist`** = expanded active list (`STARTED`, `BOOKED`, `ENDED`, `ENDED<30`, `DID NOT START`, `DID NOT ACCEPT`). **`CONTRACT_ID` is always null** on ended inserts (`skip_contract_id`); prefixed Firestore allocation runs only on active insert (`dealSheetSyncTrigger` / manual `dealSheetSync` HTTP). Defaults: **`dedupe_by_placement_id=false`**, **`skip_did_not_accept_existing=false`** (pass `dedupe_by_placement_id=true` or `skip_did_not_accept_existing=true` if you need the older skip behaviour).

**There is no Firebase-managed schedule** for this function. After upgrading from the old scheduled trigger, delete the legacy GCP Scheduler job `firebase-schedule-dealSheetSyncOfferRejectedTrigger-*` if it still appears. To run on a schedule or ad hoc from GCP, create an **HTTP** Scheduler job (or use `curl`) pointing at this function’s URL.

**Endpoint:** `https://<region>-<project>.cloudfunctions.net/dealSheetSyncOfferRejected`

**Query parameters (optional):** `resume` (default `true`; use `resume=false` to ignore checkpoint), `reset_checkpoint=true`, `checkpoint_key`, `max_pages`, `max_candidates`, `test_limit`, `submittal_codes`, `bq_dataset`, `dedupe_by_placement_id`, `skip_did_not_accept_existing`, `checkpoint_use_submittal_page`.

**Example:**
```bash
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "https://<region>-<project>.cloudfunctions.net/dealSheetSyncOfferRejected?reset_checkpoint=true"
```

DDL: [`sql/create_domain_ended_deal_sheet_tables.sql`](sql/create_domain_ended_deal_sheet_tables.sql).

## CONTRACT_ID (prefixed per domain table)

Active deal sheet inserts assign a **STRING** `CONTRACT_ID` per business line (no hyphen):

| BigQuery table | Prefix | First ID example |
|---|---|---|
| `cynet_health_deal_sheet` | `CHC` | `CHC23000` |
| `cynet_health_canada_deal_sheet` | `CAC` | `CAC1000` |
| `cynet_locums_deal_sheet` | `LOC` | `LOC1000` |

- **DEAL** rows only: new id from a per-table Firestore counter (`workspaces/run-rate-tool/contractIdSequences/{table_id}`). Health starts at **23000** (Aug 2026), canada/locums at **1000**. The counter follows config **only when the sequence doc does not exist** — after a data reset run `functions/scripts/resetContractIdSequences.js`, or the old range carries on.
- **EXTENSION** rows: never mint an id — they inherit, fill-if-empty, in this order: parent DEAL row → prior EXTENSION in the same chain → matched run-rate row (alongside `SKU_NUMBER`) → table-scoped BigQuery reuse lookup. An extension with no resolvable source stays null until its parent DEAL lands.
- **Ended** inserts: `CONTRACT_ID` remains null (`skip_contract_id`).

**Firestore layout:** sync state lives under `workspaces/run-rate-tool`:
- `contractIdSequences/{table_id}` — CONTRACT_ID counters (CHC/CAC/LOC)
- `dealSheetSyncCheckpoints/{checkpoint_key}` — backfill/update/ended pagination cursors

Override parent path via `FIRESTORE_WORKSPACE_COLLECTION` / `FIRESTORE_WORKSPACE_DOC_ID` (defaults: `workspaces` / `run-rate-tool`).

**BigQuery migration (run before deploying functions):** [`sql/migrate_contract_id_to_string.sql`](sql/migrate_contract_id_to_string.sql) — changes `CONTRACT_ID` from `INT64` to `STRING` on active/ended deal sheet tables and log tables.

**Clear values only (after STRING migration):** [`sql/migrate_contract_id_column.sql`](sql/migrate_contract_id_column.sql).

## EXT_OR_REHIRE_BY_RMG ("Extension/Rehire")

Derived column on all 6 domain deal sheet tables (active + ended). A BigQuery identifier cannot contain `/`, so the column is `EXT_OR_REHIRE_BY_RMG`; the `/` only appears in a value.

| `DEAL_TYPE` | Value | When |
|---|---|---|
| `DEAL` | *(blank)* | First deal, nothing after it yet |
| `DEAL` | `EXTENSION` | This deal has since been extended (same client) |
| `DEAL` | `REHIRED` | Candidate already existed (deal sheet **or** run-rate) at a **different parent client**, and this deal has no extension yet |
| `EXTENSION` | `REOFFERED` | 1st extension of the deal, not started (`BOOKED`/`OFFERED`; stays `REOFFERED` if it becomes `DID NOT START` / `DID NOT ACCEPT`) |
| `EXTENSION` | `REBOOKED` | 1st extension that started (stays `REBOOKED` once `ENDED` / `ENDED<30`) |
| `EXTENSION` | `REBOOKED/EXTENSION` | 2nd+ extension of the same deal (extension on extension), whatever its placement status |

- **Same client** = candidate (`CANDIDATE_ID`, else `CANDIDATE_EMAIL`) + client (`CLIENT_ID`, else `PARENT_CLIENT_NAME`) — the same identity `CONTRACT_ID` is allocated on, so it groups a DEAL with its EXTENSIONs exactly like `CONTRACT_ID` while also covering run-rate-only placements that have no parent DEAL row here.
- **Extension on extension** is counted per **deal generation**: each DEAL opens a generation, so a chain whose deal only exists in the legacy run-rate table still treats the first extension we hold as the 1st extension (`REOFFERED`/`REBOOKED`).
- The deal sheet is append-only, so every row of one deal/extension event (`DEAL_SHEET_ID`, else `PLACEMENT_ID`) gets the same value, and the placement status is **sticky** — `STARTED` at any point in a unit's history wins.
- Recomputed by an idempotent post-sync pass (`backfillExtensionRehireForDealSheets`, run from both scheduled triggers): a brand-new extension must flip its **parent DEAL** row from blank to `EXTENSION`, which no insert-time rule can do. Steady state updates 0 rows.

Rules + SQL: [`functions/src/extensionRehire.js`](functions/src/extensionRehire.js).

**BigQuery migration (run before deploying functions):** [`sql/migrate_add_extension_rehire_column.sql`](sql/migrate_add_extension_rehire_column.sql) — the recompute pass fails while the column is missing.

**Fill immediately without waiting for a sync:** [`sql/backfill_extension_rehire.sql`](sql/backfill_extension_rehire.sql) (generated from the same builder; returns rows changed per table).

## Setup

### 1. Install Dependencies
```bash
cd functions
npm install
```

### 2. Configure Environment Variables
Set environment variables using Firebase Functions config:

```bash
# Required: Nexus API credentials
firebase functions:config:set nexus.username="your_username"
firebase functions:config:set nexus.password="your_password"

# Optional: Override defaults
firebase functions:config:set nexus.base_url="https://nexusapi.cynetcorp.com"
firebase functions:config:set bigquery.project_id="cynetdatabase"
firebase functions:config:set bigquery.dataset_id="demo_purpose"
firebase functions:config:set bigquery.table_id="deal_sheet_data"
```

Or set as environment variables in the function configuration:
- `NEXUS_USERNAME`
- `NEXUS_PASSWORD`
- `GCP_PROJECT`
- `BQ_DATASET`
- `BQ_TABLE` — default `cynet_health_deal_sheet` for single-table tools; scheduled active sync routes by recruiter email when `bq_table` is not passed on the request
- `DEAL_SHEET_UPDATE_TRIGGER_MAX_PAIRS` (optional) — max placement composites refreshed per `dealSheetSyncUpdateTrigger` tick (default **500**; see [`functions/.env.example`](functions/.env.example))

### 3. Deploy
```bash
# Deploy all functions
firebase deploy --only functions

# Deploy specific function
firebase deploy --only functions:dealSheetSync
firebase deploy --only functions:dealSheetSyncOfferRejected

# Scheduled sync is split per domain (health / canada / locums) so cynet health can stay live
# while another domain is being worked on. Deploy one domain without touching the others:
firebase deploy --only functions:dealSheetSyncTriggerHealth,functions:dealSheetSyncUpdateTriggerHealth
firebase deploy --only functions:dealSheetSyncTriggerCanada,functions:dealSheetSyncUpdateTriggerCanada
firebase deploy --only functions:dealSheetSyncTriggerLocums,functions:dealSheetSyncUpdateTriggerLocums
```

**Schedules (America/New_York, hourly 8–19):** insert at :00 health / :10 canada / :20 locums, each
followed ~30m later by its update at :30 / :40 / :50. Staggered so the three domains never run
concurrently against the shared Nexus API budget.

**After deploying:** the old `dealSheetSyncTrigger` and `dealSheetSyncUpdateTrigger` functions (and
their Cloud Scheduler jobs) are gone from the codebase — delete the stale deployed functions with
`firebase functions:delete dealSheetSyncTrigger dealSheetSyncUpdateTrigger`, or they will keep
running on the old all-domains code path alongside the new per-domain ones.

## Performance Configuration

Environment variables for tuning:
- `BATCH_SIZE=300` - Rows per BigQuery insert batch
- `PER_PAGE=300` - API pagination size
- `FETCH_ALL_MAX=50` - Max parallel HTTP requests per batch
- `MAX_RETRIES=3` - Retry count for transient errors
- `BATCH_DELAY_MS=100` - Delay between API batches (ms)

## Data Flow

1. **Auth** - Authenticate with Nexus API
2. **Job Submittals** - Fetch submittals with status PERM_STARTS, ACTIVE, BOOKED
3. **Deal Sheet Candidates** - Fetch candidates by job_id in parallel
4. **Enrich** - Fetch related data (deal sheets, jobs, clients, etc.) in parallel waves
5. **BigQuery Insert** - Stream enriched rows to BigQuery

## Logging

View function logs:
```bash
firebase functions:log
```

## BigQuery tables (active deal sheets)

Domain-routed tables in `cynetdatabase.rr_project_data`:

- `cynet_health_canada_deal_sheet` — `@cynethealth.ca`
- `cynet_health_deal_sheet` — `@cynethealth.com` and default for unknown/other emails
- `cynet_locums_deal_sheet` — `@cynetlocums.com`

DDL: [`sql/create_domain_deal_sheet_tables.sql`](sql/create_domain_deal_sheet_tables.sql)

## BigQuery tables (ended deal sheets — offer-rejected scheduled path)

Same schema as active; routing by `ASSIGNMENT_RECRUITER_EMAIL`:

- `cynet_health_canada_ended_deal_sheet` — `@cynethealth.ca`
- `cynet_health_ended_deal_sheet` — `@cynethealth.com` and default
- `cynet_locums_ended_deal_sheet` — `@cynetlocums.com`

DDL: [`sql/create_domain_ended_deal_sheet_tables.sql`](sql/create_domain_ended_deal_sheet_tables.sql)

Key columns:
- `DEAL_SHEET_ID` - Primary identifier (used for deduplication)
- `PLACEMENT_STATUS` - Current placement status
- `PLACEMENT_TYPE` - FT or CT based on job type
- All other deal sheet, job, candidate, and client fields
