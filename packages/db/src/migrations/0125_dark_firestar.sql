CREATE TABLE "app_builder_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"conversation_id" uuid,
	"name" text NOT NULL,
	"source_root" text NOT NULL,
	"scaffold_version" text NOT NULL,
	"build_status" text DEFAULT 'preparing' NOT NULL,
	"latest_build_run_id" uuid,
	"latest_verification_run_id" uuid,
	"desktop_installation_id" text,
	"app_public_id" text,
	"local_binding_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_builder_apps_build_status_check" CHECK ("app_builder_apps"."build_status" in ('preparing', 'building', 'verifying', 'ready', 'failed')),
	CONSTRAINT "app_builder_apps_source_root_check" CHECK ("app_builder_apps"."source_root" ~ '^apps/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "app_builder_apps_binding_all_or_none_check" CHECK ((
        ("app_builder_apps"."desktop_installation_id" is null and "app_builder_apps"."app_public_id" is null and "app_builder_apps"."local_binding_id" is null)
        or
        ("app_builder_apps"."desktop_installation_id" is not null and "app_builder_apps"."app_public_id" is not null and "app_builder_apps"."local_binding_id" is not null)
      ))
);
--> statement-breakpoint
ALTER TABLE "app_builder_apps" ADD CONSTRAINT "app_builder_apps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_builder_apps" ADD CONSTRAINT "app_builder_apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_builder_apps" ADD CONSTRAINT "app_builder_apps_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_builder_apps" ADD CONSTRAINT "app_builder_apps_latest_build_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("latest_build_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_builder_apps" ADD CONSTRAINT "app_builder_apps_latest_verification_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("latest_verification_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_builder_apps_project_uq" ON "app_builder_apps" USING btree ("project_id") WHERE "app_builder_apps"."project_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "app_builder_apps_org_source_root_uq" ON "app_builder_apps" USING btree ("org_id","source_root");--> statement-breakpoint
CREATE INDEX "app_builder_apps_org_status_updated_idx" ON "app_builder_apps" USING btree ("org_id","build_status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_builder_apps_installation_public_uq" ON "app_builder_apps" USING btree ("desktop_installation_id","app_public_id") WHERE "app_builder_apps"."desktop_installation_id" is not null and "app_builder_apps"."app_public_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "app_builder_apps_installation_binding_uq" ON "app_builder_apps" USING btree ("desktop_installation_id","local_binding_id") WHERE "app_builder_apps"."desktop_installation_id" is not null and "app_builder_apps"."local_binding_id" is not null;
