ALTER TABLE rudder_analytics.product_analytics_collector_installations
  ADD COLUMN IF NOT EXISTS first_observed_event_at timestamptz;
--> statement-breakpoint
UPDATE rudder_analytics.product_analytics_collector_installations installation
SET first_observed_event_at = observed.first_observed_at
FROM (
  SELECT installation_id, min(occurred_at) AS first_observed_at
  FROM (
    SELECT installation_id, occurred_at
    FROM rudder_analytics.product_analytics_collector_events
    WHERE environment = 'production' AND is_internal = false
    UNION ALL
    SELECT installation_id, first_occurred_at AS occurred_at
    FROM rudder_analytics.product_analytics_collector_daily_rollups
    WHERE dimensions->>'environment' = 'production'
  ) events
  GROUP BY installation_id
) observed
WHERE installation.installation_id = observed.installation_id
  AND installation.first_observed_event_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rudder_analytics.erase_product_analytics_subject(target_analytics_subject text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, rudder_analytics
AS $function$
DECLARE
  affected_installations text[];
BEGIN
  IF target_analytics_subject IS NULL OR target_analytics_subject = '' THEN
    RAISE EXCEPTION 'invalid product analytics subject';
  END IF;
  SELECT array_agg(DISTINCT installation_id) INTO affected_installations
  FROM (
    SELECT installation_id
    FROM rudder_analytics.product_analytics_collector_subjects
    WHERE analytics_subject = target_analytics_subject
    UNION
    SELECT installation_id
    FROM rudder_analytics.product_analytics_collector_events
    WHERE analytics_subject = target_analytics_subject
  ) affected;
  DELETE FROM rudder_analytics.product_analytics_collector_events
  WHERE analytics_subject = target_analytics_subject;
  DELETE FROM rudder_analytics.product_analytics_collector_work_loop_revisions
  WHERE analytics_subject = target_analytics_subject;
  DELETE FROM rudder_analytics.product_analytics_collector_subjects
  WHERE analytics_subject = target_analytics_subject;
  UPDATE rudder_analytics.product_analytics_collector_installations installation
  SET first_observed_event_at = (
    SELECT min(event.occurred_at)
    FROM rudder_analytics.product_analytics_collector_events event
    WHERE event.installation_id = installation.installation_id
      AND event.environment = 'production'
      AND event.is_internal = false
  )
  WHERE installation.installation_id = ANY(COALESCE(affected_installations, ARRAY[]::text[]));
  DELETE FROM rudder_analytics.product_analytics_collector_daily_rollups;
  DELETE FROM rudder_analytics.product_analytics_collector_privacy_aggregates;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rudder_analytics.erase_product_analytics_subject(text) FROM PUBLIC;
