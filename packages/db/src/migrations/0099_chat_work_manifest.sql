CREATE TABLE "chat_work_manifest_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"project_id" uuid,
	"message_id" uuid,
	"run_id" uuid,
	"category" text NOT NULL,
	"target_type" text NOT NULL,
	"target_key" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"source_role" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_work_manifest_items" ADD CONSTRAINT "chat_work_manifest_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_work_manifest_items" ADD CONSTRAINT "chat_work_manifest_items_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_work_manifest_items" ADD CONSTRAINT "chat_work_manifest_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_work_manifest_items" ADD CONSTRAINT "chat_work_manifest_items_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_work_manifest_items" ADD CONSTRAINT "chat_work_manifest_items_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_work_manifest_items" ADD CONSTRAINT "chat_work_manifest_items_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_work_manifest_items_conversation_target_uq" ON "chat_work_manifest_items" USING btree ("conversation_id","target_key");--> statement-breakpoint
CREATE INDEX "chat_work_manifest_items_org_conversation_category_idx" ON "chat_work_manifest_items" USING btree ("org_id","conversation_id","category");--> statement-breakpoint
CREATE INDEX "chat_work_manifest_items_org_project_category_idx" ON "chat_work_manifest_items" USING btree ("org_id","project_id","category");