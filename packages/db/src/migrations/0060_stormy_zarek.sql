CREATE TABLE "organization_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"locator" text NOT NULL,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_resource_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"role" text DEFAULT 'reference' NOT NULL,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_resources" ADD CONSTRAINT "organization_resources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_resource_attachments" ADD CONSTRAINT "project_resource_attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_resource_attachments" ADD CONSTRAINT "project_resource_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_resource_attachments" ADD CONSTRAINT "project_resource_attachments_resource_id_organization_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."organization_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_resources_org_idx" ON "organization_resources" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "organization_resources_org_kind_idx" ON "organization_resources" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "project_resource_attachments_org_project_idx" ON "project_resource_attachments" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "project_resource_attachments_resource_idx" ON "project_resource_attachments" USING btree ("resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_resource_attachments_project_resource_idx" ON "project_resource_attachments" USING btree ("project_id","resource_id");