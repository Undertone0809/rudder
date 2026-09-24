CREATE OR REPLACE FUNCTION rudder_analytics.expire_product_analytics_raw_events(cutoff timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, rudder_analytics
AS $function$
DECLARE
  deleted_count bigint;
BEGIN
  IF cutoff > statement_timestamp() - interval '1 day'
     OR cutoff < statement_timestamp() - interval '3650 days' THEN
    RAISE EXCEPTION 'invalid product analytics retention cutoff';
  END IF;
  DELETE FROM rudder_analytics.product_analytics_collector_events
  WHERE occurred_at < cutoff;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rudder_analytics.erase_product_analytics_installation(target_installation_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, rudder_analytics
AS $function$
BEGIN
  IF target_installation_id IS NULL OR target_installation_id = '' THEN
    RAISE EXCEPTION 'invalid product analytics installation';
  END IF;
  DELETE FROM rudder_analytics.product_analytics_collector_events
  WHERE installation_id = target_installation_id;
  DELETE FROM rudder_analytics.product_analytics_collector_subjects
  WHERE installation_id = target_installation_id;
  DELETE FROM rudder_analytics.product_analytics_collector_daily_rollups
  WHERE installation_id = target_installation_id;
  DELETE FROM rudder_analytics.product_analytics_collector_work_loop_revisions
  WHERE installation_id = target_installation_id;
  DELETE FROM rudder_analytics.product_analytics_collector_installations
  WHERE installation_id = target_installation_id;
  DELETE FROM rudder_analytics.product_analytics_collector_privacy_aggregates;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rudder_analytics.erase_product_analytics_subject(target_analytics_subject text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, rudder_analytics
AS $function$
BEGIN
  IF target_analytics_subject IS NULL OR target_analytics_subject = '' THEN
    RAISE EXCEPTION 'invalid product analytics subject';
  END IF;
  DELETE FROM rudder_analytics.product_analytics_collector_events
  WHERE analytics_subject = target_analytics_subject;
  DELETE FROM rudder_analytics.product_analytics_collector_work_loop_revisions
  WHERE analytics_subject = target_analytics_subject;
  DELETE FROM rudder_analytics.product_analytics_collector_subjects
  WHERE analytics_subject = target_analytics_subject;
  DELETE FROM rudder_analytics.product_analytics_collector_daily_rollups;
  DELETE FROM rudder_analytics.product_analytics_collector_privacy_aggregates;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rudder_analytics.expire_product_analytics_raw_events(timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rudder_analytics.erase_product_analytics_installation(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rudder_analytics.erase_product_analytics_subject(text) FROM PUBLIC;
