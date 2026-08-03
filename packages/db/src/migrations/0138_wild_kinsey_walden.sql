CREATE TABLE "product_analytics_work_cycle_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"work_cycle_id" text NOT NULL,
	"completion_revision" integer NOT NULL,
	"completion_event_id" uuid NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason_code" text,
	"invalidation_event_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_analytics_work_cycle_revisions" ADD CONSTRAINT "product_analytics_work_cycle_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_analytics_work_cycle_revision_uq" ON "product_analytics_work_cycle_revisions" USING btree ("org_id","work_cycle_id","completion_revision");--> statement-breakpoint
CREATE INDEX "product_analytics_work_cycle_revision_completed_idx" ON "product_analytics_work_cycle_revisions" USING btree ("org_id","completed_at");