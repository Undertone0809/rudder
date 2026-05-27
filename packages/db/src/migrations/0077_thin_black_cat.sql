CREATE TABLE "cost_monthly_spend_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"month_start" timestamp with time zone NOT NULL,
	"spend_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_monthly_spend_rollups" ADD CONSTRAINT "cost_monthly_spend_rollups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_monthly_spend_rollups_scope_month_uq" ON "cost_monthly_spend_rollups" USING btree ("org_id","scope_type","scope_id","month_start");--> statement-breakpoint
CREATE INDEX "cost_monthly_spend_rollups_org_month_idx" ON "cost_monthly_spend_rollups" USING btree ("org_id","month_start");--> statement-breakpoint
INSERT INTO "cost_monthly_spend_rollups" (
	"org_id",
	"scope_type",
	"scope_id",
	"month_start",
	"spend_cents",
	"created_at",
	"updated_at"
)
SELECT
	"cost_events"."org_id",
	'organization',
	"cost_events"."org_id"::text,
	(date_trunc('month', "cost_events"."occurred_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS "month_start",
	coalesce(sum("cost_events"."cost_cents"), 0)::int,
	now(),
	now()
FROM "cost_events"
GROUP BY "cost_events"."org_id", (date_trunc('month', "cost_events"."occurred_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
ON CONFLICT ("org_id", "scope_type", "scope_id", "month_start") DO NOTHING;--> statement-breakpoint
INSERT INTO "cost_monthly_spend_rollups" (
	"org_id",
	"scope_type",
	"scope_id",
	"month_start",
	"spend_cents",
	"created_at",
	"updated_at"
)
SELECT
	"cost_events"."org_id",
	'agent',
	"cost_events"."agent_id"::text,
	(date_trunc('month', "cost_events"."occurred_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS "month_start",
	coalesce(sum("cost_events"."cost_cents"), 0)::int,
	now(),
	now()
FROM "cost_events"
GROUP BY "cost_events"."org_id", "cost_events"."agent_id", (date_trunc('month', "cost_events"."occurred_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
ON CONFLICT ("org_id", "scope_type", "scope_id", "month_start") DO NOTHING;
