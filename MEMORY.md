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

**Province beats OFFERING=LOCUMS everywhere, not just in routing** (2026-09-28).
`isLocumsDealSheetRow` returns false for a Canadian province. Before that, a Canada row with
OFFERING=LOCUMS (placement 1463925) took locums' revenue column (MARGIN ended up 0) and locums'
PAYMENT_TYPE "1099" (unknown to the burden table, so the whole T4 chain was null).

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

### NL weekly per diem — $70 default, editable on the RR-Dashboard (2026-09-25)
Nexus `lodging_amount`/`meal_amount` read 0 for NL, though the run-rate has $70 on 92/93 NL rows
(asked Sunil which field holds it — no answer). The sync now defaults NL to **70** when Nexus sends
0/null, and a user overrides it per row in the RR-Dashboard Edit modal
(`src/utils/canadaPerDiemRecalc.js` there, which recomputes T4/FINAL_PAY/FINAL_COST/both margins).
- Precedence: real Nexus per diem > stored value (incl. a typed 0) > 70. The stored value wins only
  when the incoming one is our default — see `applyCanadaNlPerDiemCarryForward`, hooked into
  `hasBusinessColumnChanges`, `applyManualColumnsCarryForward` and `computeChangedFields`.
- Frontend and backend formulas must agree to the cent, or the sync sees a change and appends.
- `sql/backfill_canada_nl_default_per_diem.sql` must run **before** the first sync with this code:
  the old stored 0s are otherwise indistinguishable from a typed 0 and would be kept forever.

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

EXTENSION rows only take `COMMENTS` / `BACKOUT_OR_TERMINATION` / `ST_DT_PUSHBACK_REASON` from a
run-rate row at the SAME location. Health/locums judge that on client IDs; Canada's run-rate has
none, so Canada compares `PARENT_CLIENT_NAME` + `FACILITY_NAME` instead (2026-09-25,
`buildExtensionSameLocationSql`). Before that, Canada extensions never received these three.

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

**Exception: Canada's `ownership_change_logs` are ON (2026-09-29).** Canada has no inorganic
hierarchy, so this log is its only record of who held a seat. Business rules (confirmed by the user):
- Canada logs the 5 usual roles AND every managed hierarchy seat (ATL…VP, no AVP, no SECONDARY_*):
  person added (PREVIOUS = NA), seat vacated (NEW = NA), replacement, promotion (vacate + fill).
  The person is on the deal sheet immediately (live hierarchy); the log still dates the change
  TENTATIVE_END_DATE + 1 like health. Deal→Extension differences use the CONTRACT_CHAIN dates.
- The Canada scan walks EVERY version of each placement (the live-hierarchy append runs before it
  in the same trigger and would hide a recruiter change from a latest-vs-previous scan).
- Canada runs only the ownership scan + its date sync (`SYNC_DOMAINS_WITH_OWNERSHIP_LOG_SCANS_ONLY`),
  never the health maintenance backfills in `syncOwnershipChangeLogEffectiveDatesFromExtensions`.
- Switches: `OWNERSHIP_LOG_WRITES_ENABLED_FOR_CANADA` (bigQueryClient, insert-time) +
  `SYNC_DOMAINS_WITH_OWNERSHIP_LOG_SCANS_ONLY` (index). Reset: `sql/reset_canada_ownership_logs.sql`.
- The refresh endpoint's handover log is still off for Canada (enrich gate); the next scan catches it.

**Every audit-log scan is scoped to its trigger's domain (2026-09-25).** The ownership / inorganic /
effective-date scans used to UNION all three deal sheet tables, so a *health* run wrote logs for
canada and locums placements — 300 ownership + 1 inorganic canada rows had leaked in and were
deleted by hand. Now `sync_domain` flows from each trigger into `buildActiveChangeScanUnionParts`
(and the other scan sources), so health logs only health, canada only canada, locums only locums —
including the recruiter-hierarchy MOVES, which follow the scan's `srcTable`. The manual refresh
endpoint takes the domain from the row's table (`resolveSyncDomainForActiveTableId`). No domain
given (bare HTTP call to a scan) still means all three.

---

## Recruiter hierarchy — health freezes, Canada/Locums are LIVE (2026-09-25)

Health: hierarchy frozen at hire (NEW_HIRE_DATE snapshot / parent DEAL / run-rate), later joiners go
to `inorganic_hierarchy_logs`. **Canada and Locums have no inorganic concept** — a person is
effective the moment they are in the recruiter's chain (business rule, confirmed by the user):
- DEAL **and** EXTENSION inserts take the recruiter's CURRENT directory chain; an extension does not
  inherit the managed hierarchy from parent DEAL / prior extension / run-rate.
- `applyLiveRecruiterHierarchyToDealSheet` runs from both canada/locums triggers (before the
  audit-log guard — it is a deal sheet write, not a log) and appends a new version whenever an open
  placement's chain differs. Stops at ENDED. Skips a recruiter the directory cannot resolve.
- `syncInorganicHierarchyLogsFromBigQuery` skips canada/locums outright and, with no domain, scans
  health only. This is permanent (`LIVE_RECRUITER_HIERARCHY_DOMAINS`), not a validation switch.
- SECONDARY_RECRUITER / SECONDARY_AM stay manual. CSM levels (ONSITE_AM chain) are unchanged.

### Google Workspace designations → hierarchy column (as of 2026-10-14)
Source: `manager_title` in `cynetdatabase.MISC.directory_employee_hierarchy` (Workspace job title).
Code of record: `HIERARCHY_DESIGNATION_SYNONYMS` in `functions/src/recruiterHierarchyDesignations.js`
— if this list and the code disagree, the code wins; update this list.

Matching: lowercase + trim + collapse spaces, then EXACT lookup. If no hit, strip one trailing
` - Delivery` / ` - REC` / ` - Recruitment` / ` - Staffing` (separator `-`, `–` or `/`) and retry.
No substring/fuzzy matching — an unlisted title resolves to nothing and that seat stays blank.

| Column | Workspace titles accepted |
|---|---|
| ATL | atl, associate team lead, associate team lead - federal |
| TEAM_LEAD | tl, team lead, senior team lead, senior teamlead, senior tl, sr team lead, sr. team lead |
| RM | rm, recruitment manager, recruitement manager, associate recruitment manager, associate recruitement manager, associate recruiterment manager |
| ASSOCIATE_AM | associate delivery manager, associate account manager |
| ACCOUNT_MANAGER | delivery manager, sr. / sr / senior delivery manager, account manager, sr. / sr / senior account manager |
| ASSOCIATE_DELIVERY_DIRECTOR (log: ASSOCIATE_GROUP_DIRECTOR) | director, associate director, assoc director, associate group director, associate group directeor, associate director - delivery, associate director delivery, director - business operations, director delivery for public sector |
| DELIVERY_DIRECTOR | delivery director, director - delivery, director delivery |
| AVP | avp, associate vice president, associate vice president - delivery, associate vice president delivery |
| VP (log: VP_SR_VP) | vice president, vp, sr vp, sr. vp, svp, srvp, vp srvp, vp/srvp, sr / sr. / senior vice president, same three + " (svp)", sr vp (svp), sr. vp (svp) |
| SECONDARY_RECRUITER *(manual, never auto-filled)* | secondary recruiter, secondary rm, secondary recruitment manager |
| SECONDARY_AM *(manual, never auto-filled)* | secondary am, secondary account manager, secondary delivery manager |

Gotchas: plain "director" maps to ASSOCIATE_DELIVERY_DIRECTOR, not DELIVERY_DIRECTOR. AVP is its own
column (split from VP). Typos (recruitement, directeor) are deliberate — they are real Workspace titles.

CSM levels are positional (hierarchy_level 1/2/3 → LEVEL_2/3/4_CSM), not title-matched, but a level is
skipped when the manager has EVER carried (substring, any snapshot) one of: cfo, ceo-co, co-ceo, cgo,
cso, permanent, chief growth officer, chief strategy officer.

## Health rows are keyed on PLACEMENT_ID, not DEAL_SHEET_ID (2026-09-29)

Nexus can move a deal sheet onto a new submittal. Placement 1464278 was offer-rejected (DID NOT
ACCEPT, CHC23113, DEAL_SHEET_ID 5248044); the recruiter pointed the same deal sheet at a new job and
the candidate started as placement 1464580. The insert skipped it because the DEAL_SHEET_ID existed,
and the update trigger could not recover it because it refreshes the OLD placement.

For the health table only (`isPlacementKeyedDealSheetTable` in recruiterDomainTables.js):
- insert dedupe skips only on an existing PLACEMENT_ID (both the syncService pre-fetch filter and
  `insertEnrichedDealSheetBatch`, via `dedupeExistingByPlacementOnly`);
- CONTRACT_ID reuse matches `DEAL_SHEET_ID|PLACEMENT_ID`, so the new placement follows the normal
  new-contract rules (run-rate match, else mint) — decided with the user, NOT inherit the old id.
Before the change, 0 health deal sheets sat under more than one placement, so existing rows are
unaffected. Canada / Locums still dedupe on DEAL_SHEET_ID; add them to the set if the same case shows up.

## ownership_change_logs rebuilt from the data team's history (2026-10-02)

Full write-up: `docs/OWNERSHIP_LOGS.md`. Rules: `functions/src/ownershipChangeLogRules.js` (pure, tested).
- The table was emptied and reloaded from `Cluster_Data.ownership_data` (8,151 rows, `EDITED_BY =
  'DATA_TEAM_SYNC'`, no PLACEMENT_ID / CONTRACT_ID). Backup: `ownership_change_logs_backup_20261002`.
  **Code never rewrites data team rows**; the system only adds changes they do not already have.
- Why: the old code logged one change on every open extension, each with a different date
  (TENTATIVE_END_DATE + 1 of that extension), plus ~600 fake promotion rows (people frozen in the wrong
  seat, e.g. Maneet Gupta in VP while always AVP). The insert-time path also never worked: it passed no
  table, fell back to the deal sheet, and failed on every run.
- Agreed with the user: one change = one row per contract; effective date = END_DATE + 1 (else
  TENTATIVE_END_DATE + 1) of the placement it happened on, overwritten with the next EXTENSION's
  START_DATE once booked; DID NOT START / ACCEPT keep END_DATE + 1; role names use the system's
  (Onsite Owner -> LEVEL_2_CSM). Columns added: INITIAL_START_DATE, EFFECTIVE_DATE_SOURCE,
  EFFECTIVE_DATE_PLACEMENT_ID.
- All writes are behind `OWNERSHIP_LOG_WRITES_ENABLED=true` (off by default). Turn it on only after
  `sql/ownership_rebuild/05_delete_old_code_rows.sql` has removed what the old code wrote.

## inorganic_hierarchy_logs: the recruiter is never inorganic (2026-10-02)

Agreed with the user after placement 1455552 (Miguel Ipina):
- `INORGANIC_RECRUITER` is never written — not on a recruiter change, not from the run-rate's
  INORGANIC_RECRUITER even when the RR team fills it. The recruiter is the assignment recruiter;
  the change goes to ownership_change_logs.
- On a recruiter change the new recruiter's chain is read on the day the recruiter CHANGED (the
  latest row's LAST_UPDATED), not NEW_HIRE_DATE / EXTENSION_DATE. Robin Kumar -> Vance Tyson were in
  the same team on 09-14, but read at the EXTENSION_DATE (04-22) Vance was under a different RM.
- A recruiter change that already has a row (PLACEMENT_ID + RECRUITER_EMAIL_ID) is never appended
  again — the RR dashboard (`RR-Dashboad/functions/rrupdateApiCandidate.js`) edits / clears rows in
  place, and the scan used to undo those edits. Cleanup: `sql/inorganic_recruiter_cleanup.sql`.

## An EXTENSION's parent DEAL started strictly BEFORE it (2026-10-02)

`fetchContractIdsForExtensions` and the parent-DEAL inherit tier picked "the latest DEAL starting on
or before the extension". Placement 1470658 (Martay L Shepard): the candidate was first booked as a
new DEAL 1470294 (CHC23778, start 11-22, later retracted), then re-booked the same day as an
extension of CHC22640 (started 08-24). The same-day DEAL won under `<=`, so the extension took its
contract, INITIAL_START_DATE and RM. Now a DEAL must start strictly before the extension (a prior
EXTENSION of the chain may share the day). One-row fix: `sql/fix_extension_same_day_parent_1470658.sql`.
NEW_HIRE_DATE is NOT contract-level for extensions (515 of 695 differ from their parent DEAL).

## SUBMISSION_DATE = the DEAL's first SENT_TO_CLIENT, carried like NEW_HIRE_DATE (2026-10-10)

The old code stored the submittal's `submitted_date`, which is the time it entered **AWAITING_APPROVAL**.
Placement 1468833 (CHC23500) is the example: stored 20:33:37, sent to client 20:36:58.
- Rule agreed with the user: one date per contract, stored in **UTC**.
  - **DEAL:** the earliest SENT_TO_CLIENT job-submittal note (`created_date`). A deal that was never
    sent to client stays **blank**. `submitted_date` is NOT a fallback (2026-10-11).
  - **EXTENSION:** null at enrich. It inherits at first insert through the NEW_HIRE_DATE tiers:
    parent DEAL -> prior EXTENSION -> run-rate. The run-rate tier takes the SKU's earliest row, then the
    matched row. It has no `client_first_assignment` step, because that step can reach another contract.
  - `applySubmissionDateFreeze` freezes the value on update-append, and SUBMISSION_DATE was removed
    from `API_OWNED_COLUMNS`. Flag: `SUBMISSION_DATE_FREEZE_ENABLED`. `extensionParentBackfill.js`
    lists it in `DATE_LIKE_COLUMNS` (TIMESTAMP).
- Source of truth for backfills: `RupertSync.cynet_nexus_job_submittal_status_history`
  (MIN `created_date` where code = SENT_TO_CLIENT). `cynet_nexus_job_submittals.sent_to_client_at` agrees.
  `CynetHealth.ch_run_rate.SUBS_DATE` is manual and in **EST**, and only ~25% is exact. Use ch_run_rate
  only for KEYS (`NEXUS_ID` = candidate, `NEXUS_INTERNAL_JOBID` = job), never for its date.
- Backfilled 2026-10-10:
  - All ACTIVE deal sheets (health, canada, locums) and `all_CH_data_runrate`. That includes 15,717
    data-team rows (EST -> UTC), so extensions of old deals inherit correct values.
  - **Ended tables were left alone** at the user's request.
  - Health uses the ch_run_rate origin when the contract predates our first placement. Canada / Locums
    always prefer the placement's own date, because their run-rate rows are data-team copies with start
    dates shifted by days.
  - Plan / backup tables: `fix_plan_20261010_submission_date*`, `bkp_20261010_submission_date_*`.
- **PENDING, user is asking the data team:**
  1. Does FED_SUBMITTED (federal clients) count as Sent to Client?
  2. Should the 512 rows whose contract has no Sent to Client be blanked? They still hold old values:
     health deal sheet 116 DEAL + 335 EXT, canada 2, locums 11, our all_CH rows 48. Of the 56 health
     DEAL placements, 14 are FT/PERM, and 18 CT were bulk-created as BOOKED with start 2026-04-01.
- Code change is **not committed / deployed**. Do not deploy until item 2 is decided — the freeze would
  lock those old values.

## Rehire status (EXT_OR_REHIRE_BY_RMG): new flow from the business (2026-10-13)

The current code in `extensionRehire.js` counts a DEAL as a repeat when the candidate has **any** earlier
placement, whatever its status. The business wants REBOOKED to depend on whether an earlier contract
actually **STARTED**. DNA = did not accept, DNS = did not start.

| Contract | Status | Rehire status |
|---|---|---|
| Candidate's 1st contract ever | BOOKED / DNA / DNS / STARTED / ENDED | **blank** |
| Later contract | BOOKED / DNA / DNS (not started) | **REOFFERED** |
| Later contract, an earlier contract had started (ENDED / ENDED<30) | STARTED / ENDED | **REBOOKED** |
| Later contract, no earlier contract ever started (all DNA/DNS) | STARTED / ENDED | **blank** (first real start) |
| EXTENSION of a blank (first-start) contract | any | **EXTENSION** |
| EXTENSION of a REBOOKED contract | any | **REBOOKED / EXTENSION** |

Example: contract 1 is DNS, contract 2 is BOOKED and shows REOFFERED. When contract 2 starts, it turns
**blank** because it is the first start. Its extensions read EXTENSION. Contract 3 shows REOFFERED while
booked and REBOOKED once started.
- Answers from the user (2026-10-13):
  - An earlier contract that is still **STARTED** (not ended yet) counts as started, so the new one is REBOOKED.
  - **Client does not matter.** Only the candidate's contracts are counted.
  - A contract that exists only in the legacy **run-rate** tables counts as an earlier contract. Its STARTED /
    ENDED / ENDED<30 rows count as started. Its BOOKED rows count only as an earlier contract (assumption).
  - "Earlier" is ordered by **start date**.
- **Code done 2026-10-13, not deployed.** `extensionRehire.js` facts are now `hasEarlierContract`,
  `hasEarlierStart`, `parentHasEarlierStart`. The sync recomputes the 6 deal sheet tables only.
- **all_CH_data_runrate** is updated by the one-off SQL only (`runrateUpdateTableIds`; the sync does not
  pass it). Only rows with DEAL_TYPE set are written, and each gets EXACTLY the deal sheet value of the same
  DEAL_SHEET_ID / PLACEMENT_ID. All 932 such rows matched a deal sheet unit (2026-10-13). The ~22k
  data-team rows have **no DEAL_TYPE and no PLACEMENT_ID**, so they cannot be classified; they keep their
  hand-set value and only count as history. Classifying them on their own blanked ~10k rows in the preview.
- SQL (generated from the JS, do not hand-edit): `sql/preview_extension_rehire.sql` (writes nothing) and
  `sql/backfill_extension_rehire.sql` (backup copies `bkp_20261013_ext_rehire_*`, then the UPDATEs).
  Both WRITE only the active tables (3 active deal sheets + all_CH_data_runrate, `updateTableIds`); the
  ended tables are still READ as history. The deployed sync still writes all 6 deal sheet tables.
- **Backfill RUN 2026-10-13 (before deploy, at the user's request):** health 121, canada 9, locums 29,
  all_CH_data_runrate 103 rows. Re-preview showed 0 pending. Backups: `bkp_20261013_ext_rehire_*` (4 tables).
  Until the new code is deployed, the old sync rewrites the deal sheet values back on every run; after
  deploy the sync keeps the deal sheets right. Re-run `sql/backfill_extension_rehire.sql` after deploy
  for all_CH_data_runrate (the sync does not write run-rate).

## DID NOT ACCEPT deals: NEW_HIRE_DATE = the day the offer was rejected (2026-10-14)

A DNA deal is never BOOKED, so the BOOKED-note rule left every one of them blank (394 rows /
326 placements in the health deal sheet).
- Rule agreed with the user:
  - **DEAL + DID NOT ACCEPT:** NEW_HIRE_DATE = the earliest OFFER_REJECTED job-submittal note
    (`created_date`, UTC). It wins over a BOOKED note. With no OFFER_REJECTED note it stays null.
  - **EXTENSION + DID NOT ACCEPT is NOT changed.** It keeps the contract's hire date it inherited.
  - Code: `resolveNewHireDateForDealRow` / `resolveOfferRejectedDateFromSubmittalNotes`.
- The freeze still applies. A deal that was BOOKED (hire date set) and only later turned DNA keeps the
  BOOKED date.
- Backfilled 2026-10-14 from `RupertSync.cynet_nexus_job_submittal_status_history`:
  - 394 DNA DEAL rows in `cynet_health_deal_sheet`, and the 5 DNA rows of ours in `all_CH_data_runrate`.
  - The 48 DNA extension rows were not touched.
  - Plan: `fix_plan_20261014_dna_new_hire_date`. Backups: `bkp_20261014_dna_new_hire_date_*`.
- 12 DNA placements have MOVE_RUNRATE = true in the deal sheet, but 7 of them have no row in
  all_CH_data_runrate at all. This is not explained yet.
- Code is **not committed / deployed**. It ships with the SUBMISSION_DATE change above.

### START_DATE / OFFER_TIME_START_DATE sources (2026-10-15, all three domains)
Rules agreed with the user. Code: `resolveStartAndOfferTimeDates` (columnMappings), wired in the enricher.

| Status | START_DATE | END_DATE | OFFER_TIME_START_DATE |
|---|---|---|---|
| DID NOT ACCEPT | job API `start_date`, **live on every sync** | = START_DATE | job API; re-taken once on the update that turns the row DNA, then frozen |
| every other status | submittal (job only if the submittal is blank) | unchanged | **submittal** start, set at first insert, then frozen |

- DNA DEAL: INITIAL_START_DATE follows START_DATE. DNA EXTENSION: only EXTENSION_START_DATE (its mirror)
  follows; INITIAL_START_DATE is NOT touched (`applyDidNotAcceptDateOverridesForRow`).
- Live job date was the user's choice. A reused job moves the date (job 35541883 / placement 1470179:
  offered 2026-10-19, job API later 2026-11-02), so the DNA row appends a new version when that happens.
- `applyOfferTimeStartDateFreeze` lets a row that TURNS DNA re-take the job date once.
- Existing OFFER_TIME_START_DATE values (job-sourced) were left as-is ("ab se" only).
- `RupertSync.cynet_nexus_jobs` is not reliable for start dates: ~62% are blank on jobs created since
  Aug 2026.
- Data done 2026-10-15, before the rule went live: health DNA START/END(/INITIAL for DEAL) were set to
  OFFER_TIME_START_DATE. That was 221 DEAL + 6 EXT deal sheet rows and 3 all_CH rows; backups are
  `bkp_20261015_dna_dates_*`. After deploy the live job date takes over on the next sync.
- Not committed / deployed.

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
