-- Add the derived "Extension/Rehire" column to all 6 domain deal sheet tables (active + ended).
-- BigQuery identifiers cannot contain "/", so the column is EXTENSION_REHIRE.
--
-- Values (computed by functions/src/extensionRehire.js, recomputed on every sync):
--   DEAL_TYPE = DEAL      : NULL               -> first deal, nothing after it yet
--                           'EXTENSION'        -> this deal has since been extended (same client)
--                           'REHIRED'          -> candidate already existed (deal sheet or run-rate)
--                                                 at a DIFFERENT parent client, not extended yet
--   DEAL_TYPE = EXTENSION : 'REOFFERED'        -> 1st extension, not started (BOOKED/OFFERED; stays
--                                                 REOFFERED on DID NOT START / DID NOT ACCEPT)
--                           'REBOOKED'         -> 1st extension that started (stays REBOOKED on ENDED)
--                           'REBOOKED/EXTENSION' -> 2nd+ extension of the same deal, any status
--
-- Run once in BigQuery BEFORE deploying (the recompute pass fails while the column is missing).

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS EXTENSION_REHIRE STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS EXTENSION_REHIRE STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS EXTENSION_REHIRE STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS EXTENSION_REHIRE STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS EXTENSION_REHIRE STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS EXTENSION_REHIRE STRING;
