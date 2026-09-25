# Project memory — deal sheet BigQuery sync

Context that is NOT obvious from the code or git history. Read this first; update it whenever a
decision is made that a future reader would otherwise have to rediscover.

**Rule: never touch a domain you were not asked to touch.** Health has been live and correct
throughout; Canada and Locums were built alongside it. Every domain-specific behaviour must sit
behind a domain gate, and a change must be proven not to alter the other two.

---

## The three domains

| Domain | Deal sheet table | Run-rate source | CONTRACT_ID prefix |
|---|---|---|---|
| health | `cynet_health_deal_sheet` | `all_CH_data_runrate` | CHC (from 23000) |
| canada | `cynet_health_canada_deal_sheet` | `all_Health_Canada_data_Runrate` | CAC (from 1000) |
| locums | `cynet_locums_deal_sheet` | `all_locums_runrate` | LOC (from 1000) |

Deploy target: Firebase project **`runrate-505913`**, region `us-central1`, codebase
`deal-sheet-sync`. BigQuery lives in a DIFFERENT project, **`cynetdatabase`** — the functions write
cross-project via the service account in `functions/.env`.

---

## CYNET HEALTH CANADA — status: done, in production

Work ran 2026-08-20 → 2026-08-27. Since then the same patterns were reused for Locums.

### Routing is by PROVINCE, not by recruiter email
A row is Canada when `CLIENT_STATE` is one of the nine provinces
(AB BC MB NB NL NS ON QC SK). A `@cynethealth.ca` recruiter placing a US state goes to health;
`CLIENT_STATE = "CA"` is **California**, not Canada — only `iso_country_code` carries the country.

### Schema — Canada tables differ from health on purpose
**Dropped** (all verified 100% NULL before dropping): `AVP`, `AVP_EMP_NO`, `CLIENT_OWNER`,
`ONSITE_CLIENT_OWNER`, `CLIENT_NAME_IN_CONREP`, `CLIENT_CLUSTER_REGION`,
`RECRUITER_CLUSTER_REGION`, `CLUSTER_TYPE`, `HOURLY_GP`, both `FIFTYTWO_TENURE_*`, `AGENCY_SWITCH`,
`ONSITE_OWNER`, `DIRECTOR_CLIENT_PARTNERSHIP`, `ASSOCIATE_JUNIOR_CSM`, `ONSITE_VP_AVP`,
`ASSOCIATE_SALES_PERSON`, `EXT_PENDING_ID`, `W2_PAY_RATE`, `NET_MARGIN`.

**Added**: `T4_PAY_RATE`, `CALCULATED_MARGIN`, `GROSS_MARGIN`, `CLIENT_AVERAGING_AGREEMENT`,
`CANDIDATE_AVERAGING_AGREEMENT`, `NO_OF_TIME_EXTENSION_RECEIVED`.

**Canada has no AVP role** — the hierarchy tops out at VP / Sr. VP. This caused the same
"Unrecognized name: AVP" failure in three separate queries before every column list was routed
through a per-table resolver. See `DEAL_SHEET_MISSING_COLUMNS_BY_TABLE` in `bigQueryClient.js` —
it is the single source of truth; do not add a fourth private copy.

### Margins
- `CALCULATED_MARGIN` = `FINAL_BILL_RATE - FINAL_COST` (this is the sheet's "MARGIN")
- `GROSS_MARGIN` = `FINAL_BILL_RATE - FINAL_PAY_RATE`
- `MARGIN` = Nexus `hourly_revenue`, taken straight from the API and **never derived**
- `NET_MARGIN` does not exist in Canada

### Burden multipliers (Finance's 2026 table)
| Province | T4 | T4A |
|---|---|---|
| ON | 1.2155 | 1.0337 |
| BC | 1.2258 | **1.0000** |
| NS | 1.2013 | 1.0195 |
| NL | **1.213888** | 1.0254 |
| AB MB SK QC NB | 1.1818 | **null — "No business"** |

Two deliberate departures from the older sheet formulas, both confirmed with the business:
- **AB group**: the sheet multiplied PAY_RATE by 1.04 before the 1.1818 loading, but the 4% vacation
  is already inside 18.18%. The extra 1.04 double-counted it, so it was dropped.
- **NL**: Finance's email states the loading two ways that disagree — the table says 20.72%
  (→ 1.2072), the note says "Pay Rate + 4% Vacation + 16.72%" (→ 1.04 × 1.1672 = **1.213888**).
  The code follows the NOTE, which matches the legacy run-rate sheet. If Finance ever confirms the
  flat total instead, change `NL.t4` back to 1.2072 and re-run `sql/backfill_canada_nl_margins.sql`.

A "No business" province + T4A yields a **NULL** pay rate, never an invented 1.0 multiplier.

### STILL OPEN — BC bill-rate 4% uplift
The NS sheet's Final Bill Rate carried an extra BC branch (`Bill_Rate * 1.04 * (1 - fee)`), but BC's
own sheet has no such uplift and the AB sheet explicitly says not to apply it. The code uses the
plain form (`BILL_RATE * (1 - fee)`) until the business confirms. **~967 BC rows would change.**
Asked several times; never answered.

### The SKU bug — one bug, THREE places
Canada's run-rate table has **0 CONTRACT_IDs out of 620 rows**, but 498 SKUs. Three separate gates
each required a contract id and so discarded every Canada match. All three had to be fixed:
1. `contractIdResolver.js` — the JS apply loop
2. `bigQueryClient.js` — the SQL `WHERE` in **both** lookup tiers
3. `bigQueryClient.js` — the tier-selection loop that turns hits into results

The rule everywhere is now: keep a row when it has **CONTRACT_ID *or* SKU_NUMBER**.
Canada run-rate CONTRACT_ID will **stay empty permanently** — confirmed by the user. Every Canada
DEAL therefore mints a fresh CAC id; only SKU and the manual columns come from the run-rate row.

### Manual-column carry-forward
Key: `CANDIDATE_ID + FACILITY_NAME + PARENT_CLIENT_NAME` + a date window
(`START_DATE .. COALESCE(END_DATE, TENTATIVE_END_DATE)`). Client IDs are NOT used — the Canada
run-rate table has none.

**Keep the date window.** The user suggested dropping it; live data shows 58 candidate+facility
identities have more than one contract with a *different* SKU, so identity alone picks the wrong
one. It costs only 2 matches (262 → 260) and prevents 58 wrong SKUs.

Canada carries five columns health does not (`CLIENT_AVERAGING_AGREEMENT`,
`CANDIDATE_AVERAGING_AGREEMENT`, `NO_OF_TIME_EXTENSION_RECEIVED`, `DT_RATE`, `CLIENT_DT_RATE`) and
drops three health has. Both directions live in per-table maps, never in the shared list.

`ENTITY` defaults to `"CANADA HEALTH"` — fill-if-empty only; a run-rate or hand-edited value wins.

### No date filter for Canada
Health and Locums fetch from 2026-01-01. Canada needs its **whole Nexus history**, so all three
layers of the filter are off for it (`submittal_start_date_from`, `transform_rows_fn`,
`min_start_date_ms`). See `SYNC_DOMAINS_WITHOUT_MIN_START_DATE`.

### Submittal pre-filter — the big win
Nexus's job-submittals endpoint has no state parameter, so Canada used to enrich every submittal
(~11 API calls each) and discard the non-Canadian ones afterwards. Only ~5% of live submittals are
Canadian, so **~95% of that fan-out was wasted** — and the volume is what tripped the edge rate
limit. The province is already on the submittal at `client.zipcode_data.state_code`, present on
1200/1200 live rows. Filtering there cut a page's enrich calls from ~3,300 to ~190.

A submittal with no resolvable state is **kept**, so a missing field never silently drops a row.

### Log tables are OFF for Canada
While the data is being validated, no log table accumulates Canada rows. Six paths, all gated:
`ch_additional_cost_logs`, `ch_termination_reason_logs`, `ownership_change_logs` (both the
table-wide scan AND the insert-time contract-chain writer), `inorganic_hierarchy_logs`,
`ch_rate_change_logs`. Switches: `LOG_WRITES_DISABLED_FOR_CANADA` (bigQueryClient),
`ENRICH_LOG_WRITES_DISABLED_DOMAINS` (syncService — currently holds BOTH canada and locums),
`SYNC_DOMAINS_WITHOUT_AUDIT_LOG_SCANS` (index).
**Turn these back on once the data is trusted.**

---

## Hard-won operational lessons

### `.env` values containing `#` MUST be quoted
`NEXUS_PASSWORD` ends with `#`. Unquoted, every `.env` parser treats it as an inline comment and
truncates the password (17 chars → 16), which auth-fails with **401**. This broke all three domains
at once. Always quote a value with `#`, spaces or quotes.

### Use `firebase deploy`, never `gcloud functions deploy`
`gcloud --update-env-vars` also truncated the password at the `#`. And `gcloud functions deploy`
uploads source from the current directory — running it from the repo root fails with
"function.js does not exist" because the source lives in `functions/`.

### Tuning lives in CODE, not per-function env vars
An env var set with gcloud is wiped by the next `firebase deploy` (it re-applies `.env`).
Per-domain Nexus pacing is therefore in `config.js` → `domainTuning` / `resolveDomainTuning`.
`applyDomainTuning` mutates the shared config at the start of a run, so the resolver falls back to
an immutable `TUNING_BASELINE` — otherwise one domain's values leak into the next.

### A 403 from Nexus is not always a permission error
Nexus (Django) answers a real auth/permission failure with **JSON**. The edge (Cloud Armor / LB)
answers a throttle with an **HTML** page (`<title>403</title>`). Only the HTML kind is retried —
see `isEdgeThrottle403` in `nexusClient.js`. Treating all 403s as fatal silently skipped records.

### Deploy does not mean "deployed code ran"
Rows inserted before a deploy carry the old behaviour. Always compare the newest row's
`LAST_UPDATED` against the function's `updateTime` before concluding a fix did not work. This cost
several debugging rounds.

### Reading a log line beats guessing
`[legacy contract lookup] ... keyed=21 matched=0` was the line that located the SKU bug: keys were
built fine, the SQL was discarding them. Ask for the log line rather than inferring.

---

## Testing helpers

- **Row cap**: `DEAL_SHEET_INSERT_TRIGGER_MAX_ROWS_CANADA=100` in `.env` stops a Canada run after
  100 rows so it can be checked in minutes. The name is domain-suffixed, so health/locums ignore it
  even though `.env` reaches every function. **Remove it before a production load.**
- `sql/cleanup_canada_test_rows.sql` — deletes Canada rows and every log row they produced, in the
  right order (deal sheet LAST, because the log deletes read their key list from it). Also lists the
  Firestore docs to delete: the CONTRACT_ID counter and the three `-canada` checkpoints.
- `sql/compare_canada_margins_vs_runrate.sql` — rows whose margins disagree with the run-rate table.
  Does not compare `MARGIN` (ours is Nexus hourly_revenue; the run-rate side is empty).

Run `npm test` in `functions/` before any deploy. Canada-specific suites:
`canadaProvinceRouting`, `canadaSchemaGapGuard`, `canadaLegacyManualColumns`,
`canadaSubmittalPreFilter`, `canadaLogTablesDisabled`, `canadaNoMinStartDate`.

`canadaSchemaGapGuard.test.js` holds a sweep that fails if ANY query path names a column Canada
lacks — it is the guard that stops the AVP class of bug returning.

---

## CYNET LOCUMS — status: in progress (2026-09-15 onwards)

Built on the Canada patterns. Its run-rate table lacks six manual columns health has
(`INVOICE_CYCLE_TO_CLIENT`, `CLIENT_PAYMENT_TERMS`, `CANDIDATE_PAYMENT_TERMS`, both
`FIFTYTWO_TENURE_*`, `PAYLOCITY_ID`) and adds three of its own (`DIRECT_MANAGER`,
`CREDENTIALED_DATE`, `SHIFTS`). Same per-table map mechanism as Canada.
