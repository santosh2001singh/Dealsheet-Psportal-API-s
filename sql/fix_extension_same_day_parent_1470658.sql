-- Martay L Shepard, EXTENSION 1470658 (CHC22640): INITIAL_START_DATE and RM came from the wrong DEAL.
--
-- What happened (2026-09-30 17:00): the candidate was first booked as a NEW DEAL 1470294 (CHC23778,
-- start 2026-11-22, later DID NOT START / Retracted), then re-booked the same day as this EXTENSION
-- of CHC22640, which started 2026-08-24 as DEAL 1463071. The extension's contract lookup took "the
-- latest DEAL starting on or before the extension" — 1470294 starts the SAME day, so it won. The
-- extension was written with CHC23778, SKU NULL, INITIAL_START_DATE 2026-11-22 and RM Tony Huileng
-- (all from 1470294). CONTRACT_ID / SKU_NUMBER were later corrected to CHC22640 / H15616 outside the
-- sync; INITIAL_START_DATE and RM were not, because the parent backfill only fills EMPTY columns.
--
-- Fixed in code (bigQueryClient.js): a parent DEAL must start strictly BEFORE the extension.
-- This file corrects the one row that already went wrong. NEW_HIRE_DATE is left alone: an
-- extension carries its own (515 of 695 extensions differ from their parent DEAL).

-- 1. Preview: both versions of the extension next to the real parent.
SELECT PLACEMENT_ID, DEAL_TYPE, LAST_UPDATED, CONTRACT_ID, SKU_NUMBER, START_DATE, INITIAL_START_DATE, RM, RM_EMP_NO
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
WHERE PLACEMENT_ID IN (1470658, 1463071)
ORDER BY PLACEMENT_ID, LAST_UPDATED;

-- 2. Fix: the contract's initial start (parent DEAL 1463071) and the parent's frozen RM.
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET INITIAL_START_DATE = DATE '2026-08-24',
    RM = 'Mamta Rawat',
    RM_EMP_NO = 'CY1985'
WHERE PLACEMENT_ID = 1470658
  AND CONTRACT_ID = 'CHC22640';

-- 3. Check: expected 0.
SELECT COUNT(*) AS still_wrong
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
WHERE PLACEMENT_ID = 1470658
  AND (INITIAL_START_DATE IS DISTINCT FROM DATE '2026-08-24' OR RM_EMP_NO IS DISTINCT FROM 'CY1985');
