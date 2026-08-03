CREATE TABLE "product_analytics_consent_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" text NOT NULL,
	"scope" text NOT NULL,
	"local_user_id" text,
	"decision" text NOT NULL,
	"policy_version" text NOT NULL,
	"consent_epoch" integer NOT NULL,
	"decided_by_local_user_id" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"upload_from_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_analytics_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" text NOT NULL,
	"installation_secret_hash" text NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_analytics_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "product_analytics_outbox" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"delivery_mode" text NOT NULL,
	"consent_scope" text NOT NULL,
	"consented_local_user_id" text,
	"consent_version" text NOT NULL,
	"consent_epoch" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_analytics_work_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"work_surface" text NOT NULL,
	"work_id" text NOT NULL,
	"work_cycle_id" text NOT NULL,
	"origin" text DEFAULT 'human' NOT NULL,
	"actor_id" text,
	"state" text DEFAULT 'open' NOT NULL,
	"completion_revision" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"output_ready_at" timestamp with time zone,
	"review_decision" text,
	"root_run_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_analytics_events" DROP CONSTRAINT "product_analytics_events_org_id_organizations_id_fk";
--> statement-breakpoint
DROP INDEX "product_analytics_events_org_dedupe_key_uq";--> statement-breakpoint
ALTER TABLE "product_analytics_events" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "local_user_id" text;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "environment" text DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "app_version" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "release_channel" text DEFAULT 'stable' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "deployment_mode" text DEFAULT 'self_hosted' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "origin" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "work_surface" text;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "work_id" text;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "work_cycle_id" text;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "root_run_id" uuid;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "completion_revision" integer;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "is_backfill" text DEFAULT 'false' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_analytics_outbox" ADD CONSTRAINT "product_analytics_outbox_event_id_product_analytics_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."product_analytics_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_analytics_work_cycles" ADD CONSTRAINT "product_analytics_work_cycles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_analytics_consent_lookup_idx" ON "product_analytics_consent_ledger" USING btree ("installation_id","scope","local_user_id","decided_at");--> statement-breakpoint
CREATE INDEX "product_analytics_outbox_claim_idx" ON "product_analytics_outbox" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "product_analytics_outbox_consent_idx" ON "product_analytics_outbox" USING btree ("delivery_mode","consented_local_user_id","consent_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "product_analytics_work_cycles_org_cycle_uq" ON "product_analytics_work_cycles" USING btree ("org_id","work_cycle_id");--> statement-breakpoint
CREATE INDEX "product_analytics_work_cycles_org_state_idx" ON "product_analytics_work_cycles" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "product_analytics_work_cycles_org_started_idx" ON "product_analytics_work_cycles" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_analytics_events_dedupe_key_uq" ON "product_analytics_events" USING btree ("dedupe_key");