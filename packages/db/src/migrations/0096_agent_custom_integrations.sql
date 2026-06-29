CREATE TABLE "custom_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_agent_id" uuid,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_secret_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "custom_integration_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"external_tool_name" text NOT NULL,
	"rudder_tool_name" text NOT NULL,
	"description" text,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_custom_integration_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"enabled_tool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "custom_integration_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"conversation_id" uuid,
	"issue_id" uuid,
	"status" text NOT NULL,
	"sanitized_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sanitized_result" jsonb,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_integrations" ADD CONSTRAINT "custom_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integrations" ADD CONSTRAINT "custom_integrations_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integrations" ADD CONSTRAINT "custom_integrations_credential_secret_id_organization_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."organization_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD CONSTRAINT "custom_integration_tools_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD CONSTRAINT "custom_integration_tools_integration_id_custom_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."custom_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_custom_integration_bindings" ADD CONSTRAINT "agent_custom_integration_bindings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_custom_integration_bindings" ADD CONSTRAINT "agent_custom_integration_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_custom_integration_bindings" ADD CONSTRAINT "agent_custom_integration_bindings_integration_id_custom_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."custom_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integration_tool_calls" ADD CONSTRAINT "custom_integration_tool_calls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integration_tool_calls" ADD CONSTRAINT "custom_integration_tool_calls_integration_id_custom_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."custom_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integration_tool_calls" ADD CONSTRAINT "custom_integration_tool_calls_tool_id_custom_integration_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."custom_integration_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integration_tool_calls" ADD CONSTRAINT "custom_integration_tool_calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_integrations_org_scope_idx" ON "custom_integrations" USING btree ("org_id","scope");--> statement-breakpoint
CREATE INDEX "custom_integrations_org_kind_idx" ON "custom_integrations" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "custom_integrations_owner_agent_idx" ON "custom_integrations" USING btree ("owner_agent_id");--> statement-breakpoint
CREATE INDEX "custom_integrations_secret_idx" ON "custom_integrations" USING btree ("credential_secret_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_integrations_org_slug_uq" ON "custom_integrations" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "custom_integration_tools_org_integration_idx" ON "custom_integration_tools" USING btree ("org_id","integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_integration_tools_org_tool_name_uq" ON "custom_integration_tools" USING btree ("org_id","rudder_tool_name");--> statement-breakpoint
CREATE INDEX "agent_custom_integration_bindings_org_agent_idx" ON "agent_custom_integration_bindings" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_custom_integration_bindings_org_integration_idx" ON "agent_custom_integration_bindings" USING btree ("org_id","integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_custom_integration_bindings_agent_integration_uq" ON "agent_custom_integration_bindings" USING btree ("org_id","agent_id","integration_id");--> statement-breakpoint
CREATE INDEX "custom_integration_tool_calls_org_agent_started_idx" ON "custom_integration_tool_calls" USING btree ("org_id","agent_id","started_at");--> statement-breakpoint
CREATE INDEX "custom_integration_tool_calls_org_integration_started_idx" ON "custom_integration_tool_calls" USING btree ("org_id","integration_id","started_at");
