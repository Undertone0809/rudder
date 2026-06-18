CREATE TABLE "agent_integration_binding_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"external_open_id" text NOT NULL,
	"external_union_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_integration_chat_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"external_chat_id" text NOT NULL,
	"external_chat_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_integration_inbound_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"integration_id" uuid,
	"provider" text NOT NULL,
	"external_chat_id" text,
	"external_chat_type" text,
	"external_event_id" text,
	"external_message_id" text,
	"sender_open_id" text,
	"drop_reason" text NOT NULL,
	"body_persisted" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_integration_inbound_dedup" (
	"org_id" uuid,
	"integration_id" uuid,
	"provider" text NOT NULL,
	"external_message_id" text NOT NULL,
	"external_event_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_integration_inbound_dedup_pk" PRIMARY KEY("provider","external_message_id")
);
--> statement-breakpoint
CREATE TABLE "agent_integration_outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"conversation_id" uuid,
	"chat_message_id" uuid,
	"issue_id" uuid,
	"run_id" uuid,
	"external_chat_id" text NOT NULL,
	"external_message_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_patched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_integration_user_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"external_open_id" text NOT NULL,
	"external_union_id" text,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"transport" text DEFAULT 'long_connection' NOT NULL,
	"provider_region" text DEFAULT 'feishu_cn' NOT NULL,
	"app_credential_secret_id" uuid NOT NULL,
	"external_app_id" text NOT NULL,
	"external_bot_open_id" text,
	"external_tenant_key" text,
	"installer_user_id" text,
	"manage_url" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_integration_binding_tokens" ADD CONSTRAINT "agent_integration_binding_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_binding_tokens" ADD CONSTRAINT "agent_integration_binding_tokens_integration_id_agent_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."agent_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_chat_bindings" ADD CONSTRAINT "agent_integration_chat_bindings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_chat_bindings" ADD CONSTRAINT "agent_integration_chat_bindings_integration_id_agent_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."agent_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_chat_bindings" ADD CONSTRAINT "agent_integration_chat_bindings_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_inbound_audit" ADD CONSTRAINT "agent_integration_inbound_audit_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_inbound_audit" ADD CONSTRAINT "agent_integration_inbound_audit_integration_id_agent_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."agent_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_inbound_dedup" ADD CONSTRAINT "agent_integration_inbound_dedup_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_inbound_dedup" ADD CONSTRAINT "agent_integration_inbound_dedup_integration_id_agent_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."agent_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_outbound_messages" ADD CONSTRAINT "agent_integration_outbound_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_outbound_messages" ADD CONSTRAINT "agent_integration_outbound_messages_integration_id_agent_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."agent_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_outbound_messages" ADD CONSTRAINT "agent_integration_outbound_messages_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_outbound_messages" ADD CONSTRAINT "agent_integration_outbound_messages_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_outbound_messages" ADD CONSTRAINT "agent_integration_outbound_messages_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_outbound_messages" ADD CONSTRAINT "agent_integration_outbound_messages_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_user_bindings" ADD CONSTRAINT "agent_integration_user_bindings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integration_user_bindings" ADD CONSTRAINT "agent_integration_user_bindings_integration_id_agent_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."agent_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integrations" ADD CONSTRAINT "agent_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integrations" ADD CONSTRAINT "agent_integrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_integrations" ADD CONSTRAINT "agent_integrations_app_credential_secret_id_organization_secrets_id_fk" FOREIGN KEY ("app_credential_secret_id") REFERENCES "public"."organization_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_integration_binding_tokens_token_hash_uq" ON "agent_integration_binding_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_integration_binding_tokens_integration_open_id_idx" ON "agent_integration_binding_tokens" USING btree ("integration_id","external_open_id");--> statement-breakpoint
CREATE INDEX "agent_integration_binding_tokens_expiry_idx" ON "agent_integration_binding_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_integration_chat_bindings_org_conversation_idx" ON "agent_integration_chat_bindings" USING btree ("org_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_integration_chat_bindings_integration_external_chat_uq" ON "agent_integration_chat_bindings" USING btree ("integration_id","external_chat_id");--> statement-breakpoint
CREATE INDEX "agent_integration_inbound_audit_org_reason_received_idx" ON "agent_integration_inbound_audit" USING btree ("org_id","drop_reason","received_at");--> statement-breakpoint
CREATE INDEX "agent_integration_inbound_audit_integration_received_idx" ON "agent_integration_inbound_audit" USING btree ("integration_id","received_at");--> statement-breakpoint
CREATE INDEX "agent_integration_inbound_audit_message_idx" ON "agent_integration_inbound_audit" USING btree ("provider","external_message_id");--> statement-breakpoint
CREATE INDEX "agent_integration_inbound_dedup_org_received_idx" ON "agent_integration_inbound_dedup" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "agent_integration_inbound_dedup_integration_received_idx" ON "agent_integration_inbound_dedup" USING btree ("integration_id","received_at");--> statement-breakpoint
CREATE INDEX "agent_integration_outbound_messages_org_status_idx" ON "agent_integration_outbound_messages" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "agent_integration_outbound_messages_run_idx" ON "agent_integration_outbound_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_integration_outbound_messages_issue_idx" ON "agent_integration_outbound_messages" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_integration_outbound_messages_integration_external_message_uq" ON "agent_integration_outbound_messages" USING btree ("integration_id","external_message_id");--> statement-breakpoint
CREATE INDEX "agent_integration_user_bindings_org_user_idx" ON "agent_integration_user_bindings" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_integration_user_bindings_integration_open_id_uq" ON "agent_integration_user_bindings" USING btree ("integration_id","external_open_id");--> statement-breakpoint
CREATE INDEX "agent_integration_user_bindings_integration_union_id_idx" ON "agent_integration_user_bindings" USING btree ("integration_id","external_union_id");--> statement-breakpoint
CREATE INDEX "agent_integrations_org_provider_idx" ON "agent_integrations" USING btree ("org_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_integrations_org_agent_provider_uq" ON "agent_integrations" USING btree ("org_id","agent_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_integrations_org_provider_external_app_uq" ON "agent_integrations" USING btree ("org_id","provider","external_app_id");--> statement-breakpoint
CREATE INDEX "agent_integrations_secret_idx" ON "agent_integrations" USING btree ("app_credential_secret_id");