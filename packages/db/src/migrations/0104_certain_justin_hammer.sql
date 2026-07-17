CREATE TABLE "entity_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"title" text NOT NULL,
	"issue_number" integer,
	"deleted_by_actor_type" text NOT NULL,
	"deleted_by_actor_id" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entity_tombstones" ADD CONSTRAINT "entity_tombstones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_tombstones_entity_uq" ON "entity_tombstones" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "entity_tombstones_org_deleted_idx" ON "entity_tombstones" USING btree ("org_id","deleted_at");--> statement-breakpoint
CREATE INDEX "entity_tombstones_issue_number_idx" ON "entity_tombstones" USING btree ("org_id","entity_type","issue_number");--> statement-breakpoint
CREATE INDEX "issues_company_archived_idx" ON "issues" USING btree ("org_id","archived_at");
