CREATE TABLE "organization_intelligence_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"agent_runtime_type" text NOT NULL,
	"agent_runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'configured' NOT NULL,
	"last_error" text,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_intelligence_profiles" ADD CONSTRAINT "organization_intelligence_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_intelligence_profiles_org_purpose_idx" ON "organization_intelligence_profiles" USING btree ("org_id","purpose");--> statement-breakpoint
CREATE INDEX "organization_intelligence_profiles_org_idx" ON "organization_intelligence_profiles" USING btree ("org_id");