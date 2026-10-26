# Ownership logs (`ownership_change_logs`)

`cynetdatabase.rr_project_data.ownership_change_logs` records **who owned a placement in which role, and from which date**: recruiter, onsite AM, CSM levels, and (Canada only) every hierarchy seat. Margin and incentive splits read it, so a wrong row or a wrong date moves credit to the wrong person.

Rebuilt on **2026-10-02**. The rules below were agreed that day. Code: [`functions/src/ownershipChangeLogRules.js`](../functions/src/ownershipChangeLogRules.js) (all rules, pure functions) and the ownership section of [`functions/src/bigQueryClient.js`](../functions/src/bigQueryClient.js) (BigQuery reads and writes).

---

## 1. Two kinds of rows

| | Data team rows | System rows |
|---|---|---|
| Source | `Cluster_Data.ownership_data`, loaded once on 2026-10-02 | The deal sheet sync (scheduled triggers, inserts) |
| How to recognise | `EDITED_BY = 'DATA_TEAM_SYNC'`, `EFFECTIVE_DATE_SOURCE = 'DATA_TEAM'` | `EDITED_BY` NULL, `PLACEMENT_ID` and `CONTRACT_ID` set |
| `PLACEMENT_ID` / `CONTRACT_ID` | NULL (the data team does not have them) | Set |
| Ever rewritten by code? | **Never** ("Done" and "Upcoming Extension" both stay as they are) | Dates are kept in sync with the deal sheet |

The system only adds changes the data team does not already have (rule 2).

---

## 2. The rules

### Rule 1: one change is one row per contract
A contract's placements are lined up by `START_DATE` and read as one timeline per role. A change is logged **once**, on the placement where it first appeared.

> **Example (Kayann Roopchan, CHC12569).** On 2026-09-15 the onsite AM changed from Elisa An to Jessica Van Essen. The update reached both open placements: 1466112 (running) and 1466705 (booked). The old code logged two rows with two different dates. Now it logs **one** row, on 1466112.

### Rule 2: never log what is already there
**Health: only changes first seen after the data team cutoff.** The data team reload is the history up to `config.ownershipLogDataTeamCutoff` (2026-10-02 12:50 UTC, env `OWNERSHIP_LOG_DATA_TEAM_CUTOFF`). A change the sync first sees before that moment is theirs, logged by them or deliberately not. The deal sheet's versions before the cutoff come from the 2026-08-19 table reload, which stamped every version with that day's owners, so changes read from them skip whoever sat in the seat in between.

> **Example (H13017_H13231, LEVEL_2_CSM).** Data team: Briana Silva → Jodi Stanton (04-05), Jodi Stanton → Damian Florio (05-24). The deal sheet only has Briana on the old extension and Damian on the new one, so without the cutoff the sync wrote Briana → Damian on 04-05, next to the data team's row. 375 such health rows were deleted on 2026-10-12 (`sql/ownership_rebuild/06_delete_pre_cutoff_and_varun_rows.sql`).

"First seen" is the first sighting: a pre-cutoff change that reaches another placement after the cutoff is still dropped. **Canada has no cutoff**: the data team history has 6 Canada rows out of 8,151, so the sync is Canada's only record. If the data team data is reloaded, move the cutoff to the reload time.

Then, for every change that passes the cutoff:
The change is compared with the rows already in the table for the same `CONTRACT_ID` **or** the same `SKU_NO` (data team rows only carry the SKU). Two rows are the same change when:
- the role is the same, and
- the previous owner and the new owner are the same person: emp no when both rows carry one, otherwise the name with its trailing team tag removed (`"Marco Mcneil (R5A)"` = `"Marco Mcneil"`) and `NA` treated as empty, **or**
- the same person arrives in the same role within **7 days** (`SAME_ARRIVAL_TOLERANCE_DAYS`), whoever is named as previous owner.

> **Example (H8503).** The data team has "Heather Hoffman → Derick Yi, 2026-05-03". The deal sheet never showed Heather, so it reads "Jodi Stanton → Derick Yi, 2026-05-03". That is the same arrival, so nothing new is logged.

A value that was only *filled in* (blank → a name) is not a handover, because nobody handed it over. The CSM levels were backfilled across the table on 2026-08-19, and this rule keeps those out. Canada's hierarchy seats are the exception: there an empty seat is a real state (`NA`), so a person joining or leaving a seat is logged.

### Rule 3: the effective date
Every change has an **anchor** placement (rule 4). From the anchor:

| Situation | `OWNERSHIP_EFFECTIVE_DATE` | `EFFECTIVE_DATE_SOURCE` |
|---|---|---|
| The contract has a next **EXTENSION** after the anchor (not DID NOT START / ACCEPT) | that extension's `START_DATE` | `EXTENSION_START` (final) |
| No such extension yet, anchor has `END_DATE` | `END_DATE + 1` | `END_PLUS_1` (provisional) |
| No `END_DATE` either | `TENTATIVE_END_DATE + 1` | `TENTATIVE_PLUS_1` (provisional) |
| Anchor is DID NOT START / DID NOT ACCEPT | `END_DATE + 1`, never moved to an extension | `END_PLUS_1` |

`END_DATE_PREVIOUS_OWNER` is always the effective date − 1. `EFFECTIVE_DATE_PLACEMENT_ID` is the placement whose date was used, so any row can be checked by hand. A provisional date becomes final on a later run, once the extension is booked.

### Rule 4: the anchor
| What happened | Anchor | Result |
|---|---|---|
| The owner changed **while the placement was running** | that placement | effective after it: its end + 1, then the next extension's start |
| The placement **started with the new owner** (its first record, or changed before its `START_DATE`) | the placement before it | the next extension *is* this placement, so the date is its `START_DATE`; `CHANGE_REASON_NOTES = 'CONTRACT_CHAIN'` |
| The placement **never started** | itself | `END_DATE + 1` |

> **Example (Ramona, CHC21460).** Recruiter Akriti Singh on the DEAL; extension 1465877 started 2026-09-21 with Marco Mcneil. The extension started with the new owner, so the date is **2026-09-21**.
>
> **Example (Kayann again).** Onsite AM changed on 09-15 while 1466112 was running (09-13 → 10-17). Provisionally **10-18**. 1466705 is already booked, so the final date is its start, **11-19**.

### Promotions (hierarchy moves, health)
When the employee directory shows a person in a different designation than the seat the deal sheet froze, the deal sheet is corrected and two rows are logged: the old seat vacated (`NEW = NA`) and the new seat filled. Two guards:
- **Not a promotion if the person already held the new designation when the placement was frozen** (DEAL: `NEW_HIRE_DATE`, else `START_DATE`; before the directory history starts, its earliest snapshot). The deal sheet is still corrected, but nothing is logged. This removed ~600 fake rows such as Maneet Gupta VP → AVP.
- Logged once per contract (rule 2), on the earliest placement.

A promotion is noticed while the placement runs, so its date follows rule 3 anchored on that placement.

---

## 3. Columns

Existing columns are unchanged. Three were added on 2026-10-02:

| Column | Meaning |
|---|---|
| `INITIAL_START_DATE` | Contract's first start. Data team rows: their `START_DATE`. System rows: the deal sheet's `INITIAL_START_DATE`. |
| `EFFECTIVE_DATE_SOURCE` | `DATA_TEAM` / `END_PLUS_1` / `TENTATIVE_PLUS_1` / `EXTENSION_START` (rule 3) |
| `EFFECTIVE_DATE_PLACEMENT_ID` | The placement whose date was used (anchor, or the extension) |

Data team columns that have no counterpart: `COMMENT` and `EFFECTIVE_DATE_SHOULD_BE_UPDATE_AFTER` both go into `CHANGE_REASON_NOTES`, as `Upcoming Extension | SHOULD_BE_UPDATED_AFTER=2026-10-17`. Role names use the system's names (`TL` / `Team Lead` → `TEAM_LEAD`, `Onsite Owner` → `LEVEL_2_CSM`, `VP / Sr. VP` → `VP`, `Group Director (/ Associate Director)` → `ASSOCIATE_DELIVERY_DIRECTOR`).

---

## 4. Where rows are written

| Path | When | Code |
|---|---|---|
| Scheduled scan | every health / canada trigger run | `syncOwnershipChangeLogsFromBigQuery` → `fetchOwnershipScanVersions` + `buildOwnershipChangeLogRowsFromVersions` |
| Insert-time | right after deal sheet rows are inserted (also the refresh endpoint) | `insertContractChainOwnershipLogsForInsertedRows` (only changes first seen on the inserted placements) |
| Promotions | inorganic scan | `buildOwnershipChangeLogRowsForHierarchyMoves` |
| Date sync | end of every scan, plus the date-sync steps | `syncStoredOwnershipChangeLogDates` (one MERGE per 500 changed rows, never a data team row) |
| Candidate name / email | end of every scan | `overwriteOwnershipChangeLogCandidateInfoFromDealSheet` |

All of them write through `insertOwnershipChangeLogBatch` (dedupe, rule 2) or the MERGE above. **Every write is off unless `OWNERSHIP_LOG_WRITES_ENABLED=true`** (`config.ownershipLogWritesEnabled`). Locums stays out entirely (`LOG_WRITES_DISABLED_FOR_LOCUMS`).

The scan reads the **whole version history** of the domain's active deal sheet table each run (health ~8k rows). The ended table is not read.

---

## 5. Rebuild runbook (2026-10-02)

SQL in [`sql/ownership_rebuild/`](../sql/ownership_rebuild/):

1. `01_backup.sql`: backup to `ownership_change_logs_backup_20261002` (done, 10,369 rows)
2. `02_add_columns.sql`: the three new columns (done)
3. `03_reload_from_data_team.sql`: delete everything, load the 8,151 data team rows (done)
4. `04_verify_reload.sql`: checks (done, all matched)
5. Deploy the new code with `OWNERSHIP_LOG_WRITES_ENABLED` unset (off)
6. `05_delete_old_code_rows.sql`: remove rows the old code wrote after the reload (1,032 health rows at 12:53 UTC on 10-02, plus whatever later runs added). Inserts are load jobs, so there is no streaming-buffer wait.
7. Set `OWNERSHIP_LOG_WRITES_ENABLED=true` in `functions/.env` and redeploy. The first run adds the changes the data team does not have (simulated on 10-02: health ~367, canada ~373).

Rollback: restore from the backup table (see the header of `01_backup.sql`).

---

## 6. Checking it

```sql
-- Same change logged more than once (should be 0 for system rows)
SELECT CONTRACT_ID, OWNERSHIP_ROLE, PREVIOUS_OWNER_NAME, NEW_OWNER_NAME, COUNT(*) n
FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE EDITED_BY IS DISTINCT FROM 'DATA_TEAM_SYNC'
GROUP BY 1, 2, 3, 4 HAVING n > 1;

-- Where each system row's date came from
SELECT EFFECTIVE_DATE_SOURCE, COUNT(*) n
FROM `cynetdatabase.rr_project_data.ownership_change_logs`
GROUP BY 1;

-- One row by hand: the date must equal the START_DATE (EXTENSION_START) or END/TENTATIVE + 1 of
-- EFFECTIVE_DATE_PLACEMENT_ID on the deal sheet.
SELECT PLACEMENT_ID, OWNERSHIP_ROLE, PREVIOUS_OWNER_NAME, NEW_OWNER_NAME,
       OWNERSHIP_EFFECTIVE_DATE, EFFECTIVE_DATE_SOURCE, EFFECTIVE_DATE_PLACEMENT_ID
FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE CONTRACT_ID = 'CHC12569';
```

More in `sql/ownership_same_change_repeats.sql` and `sql/ownership_move_pairs_verdict.sql`.

---

## 7. Known limits

- **Data team vs deal sheet disagreements.** ~60 health changes name the same new owner as a data team row but months apart (e.g. H12185: data team says Vish Singh arrived 2026-08-02, the deal sheet says 2026-05-03). They are kept as separate rows, because the code cannot tell which source is right.
- **Rows without a SKU** on the deal sheet can only be matched by `CONTRACT_ID`, which data team rows do not have.
- A change that genuinely repeats on the same contract (A → B, later B → A, later A → B again) is logged only the first time.
- Canada VP: "Sr. Vice President - Delivery" / "(SVP)" did not resolve to VP, so Varun Gupta's VP seat came out blank. Fixed in `HIERARCHY_DESIGNATION_SYNONYMS` (2026-10-09); the blank versions need `sql/fix_canada_vp_varun_backfill.sql`, otherwise the seat reads Varun → NA → Varun (245 rows deleted 2026-10-12).
- An "Upcoming Extension" data team row can go stale when the extension's owner changes after the reload. H15370: data team Shim Kashung → Sonam Chaudhary (10-11); on 10-08 the extension moved to Sid Kumar, so the sync adds Sonam → Sid (10-11). Both rows stay; together they read Shim → Sonam → Sid.

## 8. Do not
- Do not update or delete data team rows from code. Fix them in `Cluster_Data.ownership_data` and reload.
- Do not add a second writer that bypasses `insertOwnershipChangeLogBatch`: the dedupe lives there.
- Do not compute effective dates anywhere else. Change `ownershipChangeLogRules.js` and its tests.
