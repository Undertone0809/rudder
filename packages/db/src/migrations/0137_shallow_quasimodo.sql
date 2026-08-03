CREATE TABLE "product_analytics_collector_events" (
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
CREATE TABLE "product_analytics_collector_installations" (
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
CREATE TABLE "product_analytics_collector_subjects" (
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
CREATE INDEX "product_analytics_collector_events_installation_occurred_idx" ON "product_analytics_collector_events" USING btree ("installation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "product_analytics_collector_events_event_occurred_idx" ON "product_analytics_collector_events" USING btree ("event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "product_analytics_collector_events_subject_occurred_idx" ON "product_analytics_collector_events" USING btree ("analytics_subject","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_analytics_collector_installation_uq" ON "product_analytics_collector_installations" USING btree ("installation_id");