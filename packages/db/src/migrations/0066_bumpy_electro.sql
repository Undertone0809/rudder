CREATE TABLE "workspace_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger_source" text DEFAULT 'manual' NOT NULL,
	"artifact_provider" text DEFAULT 'local_file' NOT NULL,
	"artifact_ref" text NOT NULL,
	"archive_sha256" text,
	"tree_sha256" text,
	"file_count" integer DEFAULT 0 NOT NULL,
	"byte_size" bigint DEFAULT 0 NOT NULL,
	"compressed_size" bigint DEFAULT 0 NOT NULL,
	"manifest" jsonb,
	"warnings" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"restored_from_backup_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_backups" ADD CONSTRAINT "workspace_backups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_backups" ADD CONSTRAINT "workspace_backups_restored_from_backup_id_workspace_backups_id_fk" FOREIGN KEY ("restored_from_backup_id") REFERENCES "public"."workspace_backups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_backups" ADD CONSTRAINT "workspace_backups_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_backups_org_created_idx" ON "workspace_backups" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_backups_org_status_idx" ON "workspace_backups" USING btree ("org_id","status");