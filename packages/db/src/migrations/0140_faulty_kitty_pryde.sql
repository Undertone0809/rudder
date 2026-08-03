CREATE SCHEMA "rudder_analytics";
--> statement-breakpoint
CREATE TABLE "rudder_analytics"."product_analytics_collector_daily_rollups" (
	"day" date NOT NULL,
	"installation_id" text NOT NULL,
	"event_name" text NOT NULL,
	"origin" text NOT NULL,
	"dimension_hash" text NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"first_occurred_at" timestamp with time zone NOT NULL,
	"last_occurred_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rudder_analytics"."product_analytics_collector_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"analytics_subject" text,
	"event_name" text NOT NULL,
	"schema_version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"environment" text NOT NULL,
	"app_version" text NOT NULL,
	"release_channel" text NOT NULL,
	"deployment_mode" text NOT NULL,
	"coarse_platform" text,
	"actor_kind" text NOT NULL,
	"origin" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"pseudonymous_installation_id" text,
	"pseudonymous_org_id" text,
	"pseudonymous_work_id" text,
	"pseudonymous_work_cycle_id" text,
	"pseudonymous_root_run_id" text,
	"pseudonymous_run_id" text,
	"completion_revision" integer,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" text NOT NULL,
	"is_backfill" boolean DEFAULT false NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"consent_version" text NOT NULL,
	"consent_epoch" integer NOT NULL,
	"payload_sha256" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rudder_analytics"."product_analytics_collector_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" text NOT NULL,
	"mode" text DEFAULT 'anonymous' NOT NULL,
	"consent_version" text NOT NULL,
	"consent_epoch" integer NOT NULL,
	"analytics_subject" text,
	"revoked" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rudder_analytics"."product_analytics_collector_privacy_aggregates" (
	"day" date NOT NULL,
	"metric_name" text NOT NULL,
	"dimension_set_version" integer DEFAULT 1 NOT NULL,
	"dimension_hash" text NOT NULL,
	"dimension_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metric_value" integer DEFAULT 0 NOT NULL,
	"contributing_installations" integer DEFAULT 0 NOT NULL,
	"privacy_threshold" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rudder_analytics"."product_analytics_collector_subjects" (
	"installation_id" text NOT NULL,
	"analytics_subject" text NOT NULL,
	"consent_version" text NOT NULL,
	"consent_epoch" integer NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_analytics_collector_subjects_installation_id_analytics_subject_pk" PRIMARY KEY("installation_id","analytics_subject")
);
--> statement-breakpoint
CREATE TABLE "rudder_analytics"."product_analytics_collector_work_loop_revisions" (
	"installation_id" text NOT NULL,
	"analytics_subject" text,
	"pseudonymous_org_id" text,
	"pseudonymous_work_cycle_id" text NOT NULL,
	"completion_revision" integer NOT NULL,
	"completion_event_id" text NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason_code" text,
	"invalidation_event_id" text,
	"environment" text NOT NULL,
	"release_channel" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"confidence" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rudder_analytics_daily_rollup_uq" ON "rudder_analytics"."product_analytics_collector_daily_rollups" USING btree ("day","installation_id","event_name","origin","dimension_hash");--> statement-breakpoint
CREATE INDEX "rudder_analytics_events_installation_occurred_idx" ON "rudder_analytics"."product_analytics_collector_events" USING btree ("installation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "rudder_analytics_events_event_occurred_idx" ON "rudder_analytics"."product_analytics_collector_events" USING btree ("event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "rudder_analytics_events_subject_occurred_idx" ON "rudder_analytics"."product_analytics_collector_events" USING btree ("analytics_subject","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rudder_analytics_installation_uq" ON "rudder_analytics"."product_analytics_collector_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rudder_analytics_privacy_aggregate_uq" ON "rudder_analytics"."product_analytics_collector_privacy_aggregates" USING btree ("day","metric_name","dimension_set_version","dimension_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "rudder_analytics_work_loop_revision_uq" ON "rudder_analytics"."product_analytics_collector_work_loop_revisions" USING btree ("installation_id","pseudonymous_work_cycle_id","completion_revision");
--> statement-breakpoint
REVOKE ALL ON SCHEMA "rudder_analytics" FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  -- Roles are provisioned by deployment/IaC. Migrations never create or
  -- rotate roles, but grant the least-privilege capabilities when the named
  -- roles already exist.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rudder_analytics_collector') THEN
    GRANT USAGE ON SCHEMA "rudder_analytics" TO rudder_analytics_collector;
    GRANT SELECT, INSERT ON "rudder_analytics"."product_analytics_collector_events" TO rudder_analytics_collector;
    GRANT SELECT, INSERT, UPDATE ON "rudder_analytics"."product_analytics_collector_installations" TO rudder_analytics_collector;
    GRANT SELECT, INSERT, UPDATE ON "rudder_analytics"."product_analytics_collector_subjects" TO rudder_analytics_collector;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rudder_analytics_rollup') THEN
    GRANT USAGE ON SCHEMA "rudder_analytics" TO rudder_analytics_rollup;
    GRANT SELECT ON "rudder_analytics"."product_analytics_collector_events" TO rudder_analytics_rollup;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "rudder_analytics" TO rudder_analytics_rollup;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rudder_analytics_reader') THEN
    GRANT USAGE ON SCHEMA "rudder_analytics" TO rudder_analytics_reader;
    GRANT SELECT ON "rudder_analytics"."product_analytics_collector_daily_rollups" TO rudder_analytics_reader;
    GRANT SELECT ON "rudder_analytics"."product_analytics_collector_privacy_aggregates" TO rudder_analytics_reader;
    REVOKE ALL ON "rudder_analytics"."product_analytics_collector_events" FROM rudder_analytics_reader;
    REVOKE ALL ON "rudder_analytics"."product_analytics_collector_installations" FROM rudder_analytics_reader;
    REVOKE ALL ON "rudder_analytics"."product_analytics_collector_subjects" FROM rudder_analytics_reader;
    REVOKE ALL ON "rudder_analytics"."product_analytics_collector_work_loop_revisions" FROM rudder_analytics_reader;
  END IF;
END
$$;
