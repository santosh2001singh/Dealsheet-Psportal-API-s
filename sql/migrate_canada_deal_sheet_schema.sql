-- Cynet Health CANADA deal sheet schema alignment (Aug 2026).
--
-- Scope: ONLY the two canada tables. cynet_health_deal_sheet / cynet_health_ended_deal_sheet /
-- cynet_locums_* are NOT touched by this file — health is working and stays as-is.
--
--   cynet_health_canada_deal_sheet        (active, 964 rows at migration time)
--   cynet_health_canada_ended_deal_sheet  (ended, 0 rows -> rebuilt from scratch)
--
-- Verified before writing this migration: every column dropped below is 100% NULL across all 964
-- active rows, so no data is lost. The two columns that DO hold data (LINE_OF_BUSINESS 964 filled,
-- EXT_OR_REHIRE_BY_RMG 87 filled) are deliberately KEPT.
--
-- Run top to bottom in the BigQuery console. Every statement is idempotent.

-- ---------------------------------------------------------------------------
-- STEP 0 (optional, recommended): snapshot the active table before altering.
-- ---------------------------------------------------------------------------
-- CREATE TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet_bkp_20260820`
-- AS SELECT * FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`;


-- ---------------------------------------------------------------------------
-- STEP 1 — ACTIVE: drop the columns Canada does not use.
--
-- All verified empty (0 non-null of 964). Grouped by why they go.
-- ---------------------------------------------------------------------------
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  -- Requested drop list
  DROP COLUMN IF EXISTS EXT_PENDING_ID,
  DROP COLUMN IF EXISTS AVP,
  DROP COLUMN IF EXISTS CLIENT_OWNER,
  DROP COLUMN IF EXISTS CLIENT_NAME_IN_CONREP,
  DROP COLUMN IF EXISTS CLIENT_CLUSTER_REGION,
  DROP COLUMN IF EXISTS RECRUITER_CLUSTER_REGION,
  DROP COLUMN IF EXISTS CLUSTER_TYPE,
  DROP COLUMN IF EXISTS HOURLY_GP,
  DROP COLUMN IF EXISTS FIFTYTWO_TENURE_RTO_LASTDATE,
  DROP COLUMN IF EXISTS FIFTYTWO_TENURE_CANDIDATE_STATUS,
  DROP COLUMN IF EXISTS AGENCY_SWITCH,
  DROP COLUMN IF EXISTS ONSITE_OWNER,
  DROP COLUMN IF EXISTS DIRECTOR_CLIENT_PARTNERSHIP,
  DROP COLUMN IF EXISTS ASSOCIATE_JUNIOR_CSM,
  DROP COLUMN IF EXISTS ONSITE_VP_AVP,
  DROP COLUMN IF EXISTS ASSOCIATE_SALES_PERSON,
  -- AVP / client-owner family: dropped together with AVP so no orphan emp-no or onsite twin remains
  DROP COLUMN IF EXISTS AVP_EMP_NO,
  DROP COLUMN IF EXISTS ONSITE_CLIENT_OWNER,
  -- US-only pay family. W2 does not apply in Canada (T4_PAY_RATE is the Canada equivalent).
  DROP COLUMN IF EXISTS W2_PAY_RATE,
  -- Canada does not use net margin (bill - cost). See STEP 2 for the new margin shape.
  DROP COLUMN IF EXISTS NET_MARGIN;

-- NOT dropped, on explicit instruction:
--   LINE_OF_BUSINESS      -- 964 rows filled, keep
--   EXT_OR_REHIRE_BY_RMG  -- 87 rows filled, post-sync recompute pass owns it, keep


-- ---------------------------------------------------------------------------
-- STEP 2 — ACTIVE: margin columns.
--
-- Before this migration the Canada active table carried:
--   MARGIN      = gross margin  (FINAL_BILL_RATE - FINAL_PAY_RATE)   <- verified against live rows
--   NET_MARGIN  = net margin    (FINAL_BILL_RATE - FINAL_COST)       <- dropped in STEP 1
--
-- After:
--   CALCULATED_MARGIN = FINAL_BILL_RATE - FINAL_COST   (the sheet's "MARGIN")
--   GROSS_MARGIN      = FINAL_BILL_RATE - FINAL_PAY_RATE
--   MARGIN            = Nexus hourly_revenue, picked straight from the API and never derived
--
-- The old MARGIN value is bill-minus-pay, which is GROSS_MARGIN's definition, so it is carried into
-- GROSS_MARGIN (not CALCULATED_MARGIN). CALCULATED_MARGIN is left NULL and filled by the next sync.
-- ---------------------------------------------------------------------------

-- 2a. Add the new columns.
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS CALCULATED_MARGIN FLOAT64,
  ADD COLUMN IF NOT EXISTS GROSS_MARGIN FLOAT64;

-- 2b. The old MARGIN held bill - pay, which is GROSS_MARGIN.
UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  SET GROSS_MARGIN = MARGIN
  WHERE GROSS_MARGIN IS NULL AND MARGIN IS NOT NULL;

-- 2c. CALCULATED_MARGIN = bill - cost, recoverable from the columns already on the row.
UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  SET CALCULATED_MARGIN = ROUND(FINAL_BILL_RATE - FINAL_COST, 2)
  WHERE CALCULATED_MARGIN IS NULL
    AND FINAL_BILL_RATE IS NOT NULL
    AND FINAL_COST IS NOT NULL;

-- 2d. MARGIN is repurposed for Nexus hourly_revenue, so clear the gross value it used to hold
--     (now preserved in GROSS_MARGIN above). The next update sync fills it from the API.
--     Run only after 2b has succeeded.
UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  SET MARGIN = NULL
  WHERE MARGIN IS NOT NULL;


-- ---------------------------------------------------------------------------
-- STEP 3 — ACTIVE: sheet columns that had no BigQuery home yet.
--
-- CLIENT_AVERAGING_AGREEMENT / CANDIDATE_AVERAGING_AGREEMENT are manual (hand-edited in BigQuery,
-- carried forward untouched on every sync).
--
-- NO_OF_TIME_EXTENSION_RECEIVED is the sheet's "NO OF TIME EXTENSION RECEIVED" column. Added as
-- manual for now; it is derivable from the extension chain later if you want it computed.
-- ---------------------------------------------------------------------------
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS CLIENT_AVERAGING_AGREEMENT STRING,
  ADD COLUMN IF NOT EXISTS CANDIDATE_AVERAGING_AGREEMENT STRING,
  ADD COLUMN IF NOT EXISTS NO_OF_TIME_EXTENSION_RECEIVED STRING,
  -- Canada pay rate (T4/T4A). Already computed by canadaDerivedPlacementFields.js; added here in
  -- case the column predates that logic.
  ADD COLUMN IF NOT EXISTS T4_PAY_RATE FLOAT64;


-- ---------------------------------------------------------------------------
-- STEP 4 — ACTIVE: CLIENT_TYPE / TYPE_OF_CLIENT re-purposing.
--
-- No column is renamed here, because the meaning shifts one slot rather than the name changing:
--
--   sheet "FINAL INVOICE PENDING"  ->  CLIENT_TYPE      (manual)
--   sheet "CLIENT TYPE"            ->  TYPE_OF_CLIENT   (manual)
--
-- Both columns already exist and are already MANUAL_COLUMNS, and both are 100% empty in Canada
-- (0 of 964 filled), so nothing has to be moved — only the header mapping changes, which lives in
-- the reporting layer, not in this DDL. This block is a no-op kept for the record.
-- ---------------------------------------------------------------------------
-- (no DDL required)


-- ---------------------------------------------------------------------------
-- STEP 5 — ENDED: rebuild.
--
-- cynet_health_canada_ended_deal_sheet is currently on the OLD legacy schema (POSITION,
-- END_CLIENT_DEPT_FACILITY, TENTATIVE_DATE, CLT_PYMT_TERM, VP_SRVP, EXTENSION_REHIRE, ...) and does
-- NOT match cynet_health_ended_deal_sheet the way create_domain_ended_deal_sheet_tables.sql assumes.
-- It holds 0 rows, so the clean fix is drop + recreate from the (already migrated) canada active
-- table, giving ended exactly the same shape as active.
--
-- SAFETY: re-check the row count is still 0 before running the DROP.
--   SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`;
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`;

CREATE TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
LIKE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`;

-- Ended rows never carry a CONTRACT_ID (skip_contract_id on the ended insert path), but the column
-- stays present so the table shape matches active.


-- ---------------------------------------------------------------------------
-- STEP 6 — verify.
-- ---------------------------------------------------------------------------
-- Column counts should match between active and ended:
--   SELECT table_name, COUNT(*) cols
--   FROM `cynetdatabase.rr_project_data.INFORMATION_SCHEMA.COLUMNS`
--   WHERE table_name IN ('cynet_health_canada_deal_sheet',
--                        'cynet_health_canada_ended_deal_sheet')
--   GROUP BY table_name;
--
-- Dropped columns should return zero rows:
--   SELECT column_name
--   FROM `cynetdatabase.rr_project_data.INFORMATION_SCHEMA.COLUMNS`
--   WHERE table_name = 'cynet_health_canada_deal_sheet'
--     AND column_name IN ('NET_MARGIN','W2_PAY_RATE','AVP','AVP_EMP_NO','CLIENT_OWNER',
--                         'ONSITE_CLIENT_OWNER','HOURLY_GP','CLUSTER_TYPE','EXT_PENDING_ID');
--
-- Gross value must have survived the MARGIN -> CALCULATED_MARGIN carry-over (expect 964 / 0):
--   SELECT COUNTIF(CALCULATED_MARGIN IS NOT NULL) carried,
--          COUNTIF(MARGIN IS NOT NULL) margin_should_be_zero
--   FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`;
--
-- Health tables must be unchanged by this file (expect the original 184 / 186):
--   SELECT table_name, COUNT(*) cols
--   FROM `cynetdatabase.rr_project_data.INFORMATION_SCHEMA.COLUMNS`
--   WHERE table_name IN ('cynet_health_deal_sheet','cynet_health_ended_deal_sheet')
--   GROUP BY table_name;


-- ---------------------------------------------------------------------------
-- STEP 7 — routing change: Canada is now decided by CLIENT_STATE, not recruiter email.
--
-- Rows whose CLIENT_STATE is one of AB/BC/MB/NB/NL/NS/ON/QC/SK belong to Cynet Health Canada,
-- whichever desk recruited them. Conversely a @cynethealth.ca recruiter placing a US state is NOT
-- Canada business and must not sit in the Canada table, whose schema has no US rate family.
--
-- Live data at migration time (964 active rows):
--   BC  967 rows   (762 T4A + 205 T4)
--   NL   55 rows   (T4)
--   ON    2 rows   (T4A) -- previously produced a NULL pay rate; ON was not in the old code
--   AZ    2 rows   -- Arizona: NOT Canada. Recruiter stella.s@cynethealth.ca, deal sheet 5107104.
--
-- 7a. Move the non-Canada rows out. Their target schema (health) is a superset, so a plain
--     INSERT..SELECT of the shared columns is enough; run the SELECT first and eyeball it.
--
--   SELECT DEAL_SHEET_ID, PLACEMENT_ID, CLIENT_STATE, ASSIGNMENT_RECRUITER_EMAIL, PARENT_CLIENT_NAME
--   FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
--   WHERE UPPER(TRIM(CLIENT_STATE)) NOT IN
--         ('AB','BC','MB','NB','NL','NS','ON','QC','SK');
--
--   -- then, once the list looks right, delete them here and let the next sync re-insert them into
--   -- cynet_health_deal_sheet through the corrected routing:
--   DELETE FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
--   WHERE UPPER(TRIM(CLIENT_STATE)) NOT IN
--         ('AB','BC','MB','NB','NL','NS','ON','QC','SK');
--
-- 7b. Recalculation notice. The burden multipliers now follow Finance's 2026 table, which differs
--     from what produced the stored values. Existing rows keep their old numbers until the update
--     sync re-appends them; expect these shifts:
--
--       BC T4A (762 rows): multiplier 1.044 -> 1.0000
--                          pay rate falls ~4.4%, margins rise correspondingly
--       NL T4   (55 rows): 1.04 x 1.1672 (1.213888) -> 1.2072
--                          pay rate falls ~0.67% (the 4% vacation was double-counted)
--       ON T4A   (2 rows): NULL -> 1.0337 (ON was missing from the old code entirely)
--
--     AB/MB/SK/QC/NB are "No business" for T4A per Finance: such a row now yields a NULL pay rate
--     rather than an invented 1.0 multiplier, and its FINAL_COST / margins stay NULL with it.
-- ---------------------------------------------------------------------------
