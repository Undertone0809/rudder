CREATE TABLE "organization_resource_mutation_state" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"owner" text DEFAULT 'node' NOT NULL,
	"mutation_version" bigint DEFAULT 0 NOT NULL,
	"fence_epoch" bigint DEFAULT 0 NOT NULL,
	"fence_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_resource_mutation_state_version_ck" CHECK ("organization_resource_mutation_state"."mutation_version" >= 0),
	CONSTRAINT "organization_resource_mutation_state_fence_ck" CHECK ("organization_resource_mutation_state"."fence_epoch" >= 0),
	CONSTRAINT "organization_resource_mutation_state_owner_ck" CHECK ("organization_resource_mutation_state"."owner" in ('node', 'rust') and ("organization_resource_mutation_state"."owner" = 'node' or "organization_resource_mutation_state"."fence_epoch" > 0))
);
--> statement-breakpoint
ALTER TABLE "organization_mutation_receipts" DROP CONSTRAINT "organization_mutation_receipts_kind_ck";--> statement-breakpoint
ALTER TABLE "organization_resource_mutation_state" ADD CONSTRAINT "organization_resource_mutation_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_mutation_receipts" ADD CONSTRAINT "organization_mutation_receipts_kind_ck" CHECK ("organization_mutation_receipts"."command_kind" in ('organization_branding', 'project_goal_link', 'project_goal_set_replacement', 'project_delete', 'project_create', 'organization_resource'));
--> statement-breakpoint
-- Existing catalog rows begin under the legacy Node writer. New canonical
-- resource writers provision their owner row in the same transaction.
INSERT INTO "organization_resource_mutation_state" ("resource_id", "org_id")
SELECT "id", "org_id"
FROM "organization_resources"
ON CONFLICT ("resource_id") DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION "guard_organization_resource_mutation_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."org_id") THEN
      RAISE EXCEPTION 'cannot reset live organization resource authority' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "organization_resources"
      WHERE "id" = NEW."resource_id" AND "org_id" = NEW."org_id"
    ) THEN
      RAISE EXCEPTION 'organization resource mutation state has an invalid scope' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."resource_id" <> OLD."resource_id"
    OR NEW."org_id" <> OLD."org_id"
    OR NEW."mutation_version" < OLD."mutation_version"
    OR NEW."fence_epoch" < OLD."fence_epoch"
    OR NEW."fence_token" IS NULL
    OR (NEW."fence_epoch" > OLD."fence_epoch" AND NEW."fence_token" = OLD."fence_token")
    OR (NEW."fence_token" <> OLD."fence_token" AND NEW."fence_epoch" <= OLD."fence_epoch")
    OR (NEW."owner" <> OLD."owner"
      AND (NEW."fence_epoch" <= OLD."fence_epoch" OR NEW."fence_token" = OLD."fence_token")) THEN
    RAISE EXCEPTION 'organization resource mutation version or ownership fence regressed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "organization_resource_mutation_state_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "organization_resource_mutation_state"
FOR EACH ROW EXECUTE FUNCTION "guard_organization_resource_mutation_state"();
