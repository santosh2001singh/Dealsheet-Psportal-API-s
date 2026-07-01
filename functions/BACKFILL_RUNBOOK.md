# Deal sheet sync runbook (active placements)

Pipeline loads Nexus **job-submittals** with:

- `organization_submittal_status_code=PERM_STARTS,ACTIVE,BOOKED` (bootstrap list when **all** domain tables are empty; expanded list once **any** domain table has rows)

and writes enriched rows to **one of** (by `ASSIGNMENT_RECRUITER_EMAIL` domain):

- `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` — `@cynethealth.ca`
- `cynetdatabase.rr_project_data.cynet_health_deal_sheet` — `@cynethealth.com` and default for unknown/other domains
- `cynetdatabase.rr_project_data.cynet_locums_deal_sheet` — `@cynetlocums.com`

**Scheduled job:** `dealSheetSyncTrigger` runs **hourly at :00 in `America/New_York`**, from **9:00 AM through 7:00 PM Eastern** (cron `0 9-19 * * *`). It does **not** pass `bq_table`, so inserts are domain-routed. For HTTP runs with `only_new=true`, each row’s `DEAL_SHEET_ID` is checked only in that row’s **resolved** target table (no duplicate deal sheets per domain table).

**Scheduled active sync (split):**

- **`dealSheetSyncTrigger` (:00 ET, hourly 9 AM–7 PM):** Insert only when **`DEAL_SHEET_ID` and `PLACEMENT_ID` are both new** in BQ (no append-on-change). Nexus **`PERM_STARTS,ACTIVE,BOOKED`**, full list pagination. First row: **`STARTED,BOOKED`** only. `START_DATE >= 2026-05-01`.
- **`dealSheetSyncUpdateTrigger` (:30 ET, hourly 9:30 AM–7:30 PM):** One target per **`DEAL_SHEET_ID`** from active BQ tables (`PLACEMENT_ID` fallback if deal sheet null). Nexus refresh by deal sheet, append when **business columns** differ vs latest deal-sheet row (no first-row inserts). **Two-tier sync:** every run refreshes **all** targets whose latest `PLACEMENT_STATUS` is **`STARTED`**, **`BOOKED`**, or **`ACTIVE`**; then processes up to **`DEAL_SHEET_UPDATE_TRIGGER_MAX_PAIRS`** (default 500) from the batch tier (`ENDED`, `ENDED<30`, `DID NOT START`, `DID NOT ACCEPT`, and any other/unknown status). Batch cursor: **`active-deal-sheet-update-cursor`** (`batchOffset` / `batchTotal` only).

## 1) Environment configuration

Set function environment variables to at least:

- `BQ_DATASET=rr_project_data`
- `BQ_TABLE=cynet_health_deal_sheet` (default for single-table overrides such as `?bq_table=` omitted elsewhere; domain-routed active sync ignores this for writes)
- `SUBMITTAL_STATUS_CODES=PERM_STARTS,ACTIVE,BOOKED`
- `BACKFILL_CURSOR_KEY=active-records-default`
- `BACKFILL_CHECKPOINT_COLLECTION=dealSheetSyncCheckpoints` (subcollection under `workspaces/run-rate-tool`)
- `FIRESTORE_WORKSPACE_COLLECTION=workspaces` (optional; default `workspaces`)
- `FIRESTORE_WORKSPACE_DOC_ID=run-rate-tool` (optional; default `run-rate-tool`)

Recommended stability tuning for Nexus:

- `PER_PAGE=300`
- `FETCH_ALL_MAX=50`
- `BATCH_DELAY_MS=50` to `100`

Create tables once: see [`sql/create_domain_deal_sheet_tables.sql`](../sql/create_domain_deal_sheet_tables.sql).

**Ended (offer-rejected) tables:** [`sql/create_domain_ended_deal_sheet_tables.sql`](../sql/create_domain_ended_deal_sheet_tables.sql) — `cynet_health_ended_deal_sheet`, `cynet_health_canada_ended_deal_sheet`, `cynet_locums_ended_deal_sheet` (domain-routed like active).

**Firestore checkpoint (page cursor):** checkpoints are stored at `workspaces/run-rate-tool/dealSheetSyncCheckpoints/{checkpoint_key}`. Scheduled `dealSheetSyncTrigger` persists `submittalPageNext`, `submittalPerPage`, and `checkpointCursorMode: "page"`. HTTP **`dealSheetSyncOfferRejected`** uses the same page cursor pattern with default `checkpoint_key=offer-rejected-ended-records` and `clear_checkpoint_on_complete` after a full successful pass. HTTP backfill for active sync can pass `checkpoint_use_submittal_page=true` with `resume=true`.

## 2) Deploy

From repo root:

```bash
firebase deploy --only functions
```

## 3) Reset checkpoint (start list from page 1 once)

```bash
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
"https://us-central1-<project-id>.cloudfunctions.net/dealSheetSync?resume=true&reset_checkpoint=true&checkpoint_key=active-records-default"
```

## 4) Manual full sync (continuous, all pages)

```bash
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
"https://us-central1-<project-id>.cloudfunctions.net/dealSheetSync?resume=true&checkpoint_key=active-records-default"
```

## 5) Optional chunked mode

```bash
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
"https://us-central1-<project-id>.cloudfunctions.net/dealSheetSync?resume=true&max_pages=1&checkpoint_key=active-records-default"
```

## 6) Optional HTTP overrides

For a one-off different table or status list (defaults come from env):

| Query param | Purpose |
|-------------|---------|
| `submittal_codes` | Comma-separated statuses (URL-encode `,` as `%2C`) |
| `checkpoint_use_submittal_page` | `true` — page-based Firestore cursor for job-submittals (with `resume=true`) |
| `use_ended_domain_routing` | `true` — write to three ended tables by recruiter email (no `bq_table`) |

## 7) Validate

- Logs: `submittalCodes=...`, `table=...ACTIVE_DOMAIN_ROUTED` / `ENDED_DOMAIN_ROUTED`, and checkpoint `submittalPageNext` when page mode is on.
- Firestore checkpoint `active-records-default`: `submittalStatusCodes` and `table` match (sentinel for routed runs).
- Response JSON: `hasMore` false when the Nexus list is exhausted.

## 8) Common issues

- Timeouts / pressure: lower `FETCH_ALL_MAX`, raise `BATCH_DELAY_MS`, or use `max_pages=1`.
- Stale cursor after changing env: `reset_checkpoint=true` or rely on automatic mismatch reset (codes/table vs checkpoint doc).
- Restart from page 1: `reset_checkpoint=true`.
