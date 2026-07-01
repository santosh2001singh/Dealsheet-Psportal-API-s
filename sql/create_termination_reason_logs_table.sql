-- Global termination/cancellation reason audit log (one row per Nexus detail record per sync snapshot).
-- Run in BigQuery BEFORE deploying updated Firebase functions.

CREATE TABLE IF NOT EXISTS `cynetdatabase.rr_project_data.ch_termination_reason_logs` (
  ID STRING NOT NULL,
  DATE_AND_TIME TIMESTAMP NOT NULL,
  DEAL_SHEET_ID INT64,
  PLACEMENT_ID INT64,
  CONTRACT_ID STRING,
  TERMINATION_DETAIL_ID INT64,
  CANCELLED_BY STRING,
  NOTES STRING,
  VALUE STRING,
  TERMINATION_TYPE STRING,
  DNR_AT STRING
)
PARTITION BY DATE(DATE_AND_TIME);
