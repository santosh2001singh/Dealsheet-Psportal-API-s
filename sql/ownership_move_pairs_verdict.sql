-- Health ownership_change_logs: every hierarchy "move" pair (VACATE row + FILL row, same placement,
-- same LAST_UPDATED, same person) with a verdict from three sources:
--   directory_employee_hierarchy : the person's title on the day the placement was frozen (anchor)
--   cynet_health_deal_sheet      : the seat on the placement's FIRST deal sheet row + latest status
--   all_CH_data_runrate          : the seat the run-rate holds for the same placement
-- Read-only. vacate_id / fill_id are the ownership_change_logs.ID values of the two rows.
CREATE TEMP FUNCTION seat(t STRING) AS (CASE LOWER(TRIM(t))
  WHEN 'atl' THEN 'ATL' WHEN 'associate team lead' THEN 'ATL' WHEN 'team lead' THEN 'TEAM_LEAD'
  WHEN 'recruitment manager' THEN 'RM' WHEN 'associate recruitment manager' THEN 'RM'
  WHEN 'associate delivery manager' THEN 'ASSOCIATE_AM' WHEN 'delivery manager' THEN 'ACCOUNT_MANAGER'
  WHEN 'delivery director' THEN 'DELIVERY_DIRECTOR'
  WHEN 'avp - delivery' THEN 'AVP' WHEN 'associate vice president - delivery' THEN 'AVP' END);
WITH l AS (SELECT * FROM `cynetdatabase.rr_project_data.ownership_change_logs` WHERE CONTRACT_ID LIKE 'CHC%'),
pairs AS (
  SELECT v.ID vacate_id, f.ID fill_id, v.PLACEMENT_ID, v.SKU_NO, v.CANDIDATE_NAME, v.PREVIOUS_OWNER_NAME who, v.PREVIOUS_OWNER_EMP_NO emp,
         v.OWNERSHIP_ROLE from_role, f.OWNERSHIP_ROLE to_role, v.LAST_UPDATED log_at, v.START_DATE log_start, v.OWNERSHIP_EFFECTIVE_DATE log_eff
  FROM l v JOIN l f ON v.PLACEMENT_ID=f.PLACEMENT_ID AND v.LAST_UPDATED=f.LAST_UPDATED AND v.PREVIOUS_OWNER_EMP_NO=f.NEW_OWNER_EMP_NO AND v.OWNERSHIP_ROLE!=f.OWNERSHIP_ROLE
  WHERE v.NEW_OWNER_NAME='NA' AND f.PREVIOUS_OWNER_NAME='NA' AND v.PREVIOUS_OWNER_EMP_NO NOT IN ('NA','')
),
ds_first AS (
  SELECT CAST(PLACEMENT_ID AS STRING) pid, DEAL_TYPE, START_DATE, NEW_HIRE_DATE,
    [STRUCT('ATL' AS col, ATL_EMP_NO AS e), ('TEAM_LEAD', TEAM_LEAD_EMP_NO), ('RM', RM_EMP_NO), ('ASSOCIATE_AM', ASSOCIATE_AM_EMP_NO),
     ('ACCOUNT_MANAGER', ACCOUNT_MANAGER_EMP_NO), ('ASSOCIATE_DELIVERY_DIRECTOR', ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO),
     ('DELIVERY_DIRECTOR', DELIVERY_DIRECTOR_EMP_NO), ('AVP', AVP_EMP_NO), ('VP', VP_EMP_NO)] seats
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY PLACEMENT_ID ORDER BY LAST_UPDATED) = 1
),
rr AS (
  SELECT CAST(PLACEMENT_ID AS STRING) pid,
    [STRUCT('ATL' AS col, ATL_EMP_NO AS e), ('TEAM_LEAD', TEAM_LEAD_EMP_NO), ('RM', RM_EMP_NO), ('ASSOCIATE_AM', ASSOCIATE_AM_EMP_NO),
     ('ACCOUNT_MANAGER', ACCOUNT_MANAGER_EMP_NO), ('ASSOCIATE_DELIVERY_DIRECTOR', ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO),
     ('DELIVERY_DIRECTOR', DELIVERY_DIRECTOR_EMP_NO), ('AVP', AVP_EMP_NO), ('VP', VP_EMP_NO)] seats
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` WHERE PLACEMENT_ID IS NOT NULL
),
dir AS (
  SELECT manager_employee_id emp, DATE(synced_at) d, ANY_VALUE(seat(manager_title)) s, ANY_VALUE(manager_title) t
  FROM `cynetdatabase.MISC.directory_employee_hierarchy`
  WHERE manager_employee_id IN (SELECT DISTINCT emp FROM pairs) AND seat(manager_title) IS NOT NULL
  GROUP BY 1,2
),
rr_flat AS (
  SELECT r.pid, UPPER(TRIM(s.e)) e, STRING_AGG(DISTINCT s.col) cols FROM rr r, UNNEST(r.seats) s WHERE s.e IS NOT NULL GROUP BY 1,2
),
latest_status AS (
  SELECT CAST(PLACEMENT_ID AS STRING) pid, UPPER(TRIM(PLACEMENT_STATUS)) status FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY PLACEMENT_ID ORDER BY LAST_UPDATED DESC) = 1
),
dir_first AS (SELECT emp, MIN(d) first_day FROM dir GROUP BY 1),
dir_seat_first AS (SELECT emp, s, MIN(d) seat_from FROM dir GROUP BY 1,2),
x AS (
  SELECT p.*, d.DEAL_TYPE,
    COALESCE(IF(d.DEAL_TYPE='DEAL', SAFE_CAST(d.NEW_HIRE_DATE AS DATE), NULL), SAFE_CAST(d.START_DATE AS DATE), SAFE_CAST(p.log_start AS DATE)) anchor,
    (SELECT STRING_AGG(s.col) FROM UNNEST(d.seats) s WHERE UPPER(TRIM(s.e))=UPPER(p.emp)) ds_first_seat,
    rf.cols rr_seat
  FROM pairs p LEFT JOIN ds_first d ON d.pid=p.PLACEMENT_ID
  LEFT JOIN rr_flat rf ON rf.pid=p.PLACEMENT_ID AND rf.e=UPPER(p.emp)
),
y AS (
  SELECT x.*, ls.status latest_status, da.s dir_seat_at_anchor, da.d dir_snapshot_used, df.first_day dir_first_day, nt.seat_from new_title_from
  FROM x
  LEFT JOIN dir da ON da.emp=x.emp AND da.d<=x.anchor
  LEFT JOIN dir_first df ON df.emp=x.emp
  LEFT JOIN latest_status ls ON ls.pid=x.PLACEMENT_ID
  LEFT JOIN dir_seat_first nt ON nt.emp=x.emp AND nt.s=x.to_role
  QUALIFY ROW_NUMBER() OVER (PARTITION BY x.vacate_id ORDER BY da.d DESC) = 1
)
SELECT *,
  CASE
    WHEN latest_status IN ('DID NOT START','DID NOT ACCEPT') THEN 'DELETE: placement never started'
    WHEN dir_seat_at_anchor = to_role THEN 'DELETE: already held new role when placement was frozen'
    WHEN dir_seat_at_anchor = from_role THEN 'KEEP: promoted during placement (effective = new_title_from)'
    ELSE 'REVIEW' END verdict
FROM y
ORDER BY who, PLACEMENT_ID
