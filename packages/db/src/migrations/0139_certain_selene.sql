CREATE TABLE "product_analytics_collector_daily_rollups" (
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
CREATE TABLE "product_analytics_collector_privacy_aggregates" (
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
CREATE TABLE "product_analytics_collector_work_loop_revisions" (
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
CREATE UNIQUE INDEX "product_analytics_collector_daily_rollup_uq" ON "product_analytics_collector_daily_rollups" USING btree ("day","installation_id","event_name","origin","dimension_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "product_analytics_collector_privacy_aggregate_uq" ON "product_analytics_collector_privacy_aggregates" USING btree ("day","metric_name","dimension_set_version","dimension_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "product_analytics_collector_work_loop_revision_uq" ON "product_analytics_collector_work_loop_revisions" USING btree ("installation_id","pseudonymous_work_cycle_id","completion_revision");