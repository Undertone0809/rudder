CREATE TABLE "plugin_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"label" text NOT NULL,
	"locator" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_sources_type_check" CHECK ("plugin_sources"."source_type" in ('local_upload', 'marketplace', 'git', 'package'))
);
--> statement-breakpoint
CREATE TABLE "plugin_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"digest" text NOT NULL,
	"raw_manifest" jsonb NOT NULL,
	"normalized_manifest" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"compatibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installed_plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"previous_package_id" uuid,
	"source_id" uuid,
	"package_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"lifecycle_state" text DEFAULT 'installed' NOT NULL,
	"setup_state" text DEFAULT 'not_required' NOT NULL,
	"health_state" text DEFAULT 'unknown' NOT NULL,
	"update_state" text DEFAULT 'none' NOT NULL,
	"last_operation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installed_plugins_lifecycle_check" CHECK ("installed_plugins"."lifecycle_state" in ('installed', 'uninstalling', 'uninstalled')),
	CONSTRAINT "installed_plugins_setup_check" CHECK ("installed_plugins"."setup_state" in ('not_required', 'setup_required', 'configuring', 'ready', 'blocked')),
	CONSTRAINT "installed_plugins_health_check" CHECK ("installed_plugins"."health_state" in ('unknown', 'healthy', 'degraded', 'unavailable')),
	CONSTRAINT "installed_plugins_update_check" CHECK ("installed_plugins"."update_state" in ('none', 'available', 'review_required', 'applying', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "plugin_component_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"installed_plugin_id" uuid NOT NULL,
	"component_type" text NOT NULL,
	"component_key" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text NOT NULL,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_component_links_type_check" CHECK ("plugin_component_links"."component_type" in ('skill', 'mcp', 'app', 'unsupported')),
	CONSTRAINT "plugin_component_links_status_check" CHECK ("plugin_component_links"."status" in ('ready', 'setup_required', 'unsupported', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "plugin_import_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"package_id" uuid,
	"source_id" uuid,
	"source_type" text NOT NULL,
	"source_label" text NOT NULL,
	"status" text NOT NULL,
	"digest" text,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_import_reports_status_check" CHECK ("plugin_import_reports"."status" in ('review_required', 'accepted', 'rejected', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "plugin_sources" ADD CONSTRAINT "plugin_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_packages" ADD CONSTRAINT "plugin_packages_source_id_plugin_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."plugin_sources"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "installed_plugins" ADD CONSTRAINT "installed_plugins_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "installed_plugins" ADD CONSTRAINT "installed_plugins_package_id_plugin_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."plugin_packages"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "installed_plugins" ADD CONSTRAINT "installed_plugins_previous_package_id_plugin_packages_id_fk" FOREIGN KEY ("previous_package_id") REFERENCES "public"."plugin_packages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "installed_plugins" ADD CONSTRAINT "installed_plugins_source_id_plugin_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."plugin_sources"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_component_links" ADD CONSTRAINT "plugin_component_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_component_links" ADD CONSTRAINT "plugin_component_links_installed_plugin_id_installed_plugins_id_fk" FOREIGN KEY ("installed_plugin_id") REFERENCES "public"."installed_plugins"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_import_reports" ADD CONSTRAINT "plugin_import_reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_import_reports" ADD CONSTRAINT "plugin_import_reports_package_id_plugin_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."plugin_packages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_import_reports" ADD CONSTRAINT "plugin_import_reports_source_id_plugin_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."plugin_sources"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "plugin_sources_org_idx" ON "plugin_sources" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_packages_digest_uq" ON "plugin_packages" USING btree ("digest");
--> statement-breakpoint
CREATE INDEX "plugin_packages_identity_idx" ON "plugin_packages" USING btree ("name", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX "installed_plugins_org_package_name_uq" ON "installed_plugins" USING btree ("org_id", "package_name") WHERE "installed_plugins"."lifecycle_state" <> 'uninstalled';
--> statement-breakpoint
CREATE INDEX "installed_plugins_org_lifecycle_idx" ON "installed_plugins" USING btree ("org_id", "lifecycle_state");
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_component_links_plugin_key_uq" ON "plugin_component_links" USING btree ("installed_plugin_id", "component_type", "component_key");
--> statement-breakpoint
CREATE INDEX "plugin_component_links_org_target_idx" ON "plugin_component_links" USING btree ("org_id", "target_id");
--> statement-breakpoint
CREATE INDEX "plugin_import_reports_org_created_idx" ON "plugin_import_reports" USING btree ("org_id", "created_at");
