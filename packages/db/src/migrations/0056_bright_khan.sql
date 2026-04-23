CREATE TABLE "agent_enabled_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"skill_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_enabled_skills" ADD CONSTRAINT "agent_enabled_skills_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_enabled_skills" ADD CONSTRAINT "agent_enabled_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_enabled_skills_agent_idx" ON "agent_enabled_skills" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_enabled_skills_org_idx" ON "agent_enabled_skills" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_enabled_skills_agent_skill_idx" ON "agent_enabled_skills" USING btree ("agent_id","skill_key");