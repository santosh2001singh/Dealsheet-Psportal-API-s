-- Match CONTRACT_ID from ch_rate_change_logs against cynet_health_deal_sheet
-- where RATE_CHANGE = 'YES' and DEAL_TYPE = 'deal'.
-- Returns one row per matching log entry with key deal sheet fields.

SELECT
  log.CONTRACT_ID,
  log.CANDIDATE_NAME                 AS LOG_CANDIDATE_NAME,
  log.PLACEMENT_STATUS               AS LOG_PLACEMENT_STATUS,
  log.RATE_CHANGE                    AS LOG_RATE_CHANGE,
  log.RATE_CHANGE_EFFECTIVE_DATE     AS LOG_RATE_CHANGE_EFFECTIVE_DATE,
  ds.CANDIDATE_NAME                  AS DS_CANDIDATE_NAME,
  ds.PLACEMENT_STATUS                AS DS_PLACEMENT_STATUS,
  ds.CANDIDATE_STATUS                AS DS_CANDIDATE_STATUS,
  ds.DEAL_SHEET_ID                   AS DS_DEAL_SHEET_ID,
  ds.DEAL_TYPE,
  ds.RATE_CHANGE                     AS DS_RATE_CHANGE,
  ds.DEAL_SHEET_STATUS,
  ds.START_DATE,
  ds.END_DATE,
  ds.BILL_RATE,
  ds.PAY_RATE,
  ds.OT_RATE,
  ds.UPDATED_AT
FROM `cynetdatabase.rr_project_data.ch_rate_change_logs` AS log
INNER JOIN `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS ds
  ON ds.CONTRACT_ID = log.CONTRACT_ID
WHERE UPPER(TRIM(log.RATE_CHANGE)) = 'YES'
  AND LOWER(TRIM(ds.DEAL_TYPE))    = 'deal'
ORDER BY log.RATE_CHANGE_EFFECTIVE_DATE DESC;
