CREATE TABLE IF NOT EXISTS "rudder_analytics"."product_analytics_collector_quality_counters" (
  "day" date PRIMARY KEY NOT NULL,
  "received_batches" integer DEFAULT 0 NOT NULL,
  "accepted_events" integer DEFAULT 0 NOT NULL,
  "duplicate_events" integer DEFAULT 0 NOT NULL,
  "rejected_events" integer DEFAULT 0 NOT NULL,
  "late_events" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rudder_analytics_collector') THEN
    GRANT SELECT, INSERT, UPDATE ON "rudder_analytics"."product_analytics_collector_quality_counters" TO rudder_analytics_collector;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rudder_analytics_rollup') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "rudder_analytics"."product_analytics_collector_quality_counters" TO rudder_analytics_rollup;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rudder_analytics_reader') THEN
    GRANT SELECT ON "rudder_analytics"."product_analytics_collector_quality_counters" TO rudder_analytics_reader;
  END IF;
END
$$;
