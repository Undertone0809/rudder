-- Project-Goal has its own ownership boundary. It must not share the
-- organization-wide D1 fence with unrelated first-party writers.
CREATE TABLE "project_goal_mutation_state" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"mutation_version" bigint DEFAULT 0 NOT NULL,
	"fence_epoch" bigint DEFAULT 0 NOT NULL,
	"fence_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner" text DEFAULT 'node' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_goal_mutation_state_version_ck" CHECK ("project_goal_mutation_state"."mutation_version" >= 0),
	CONSTRAINT "project_goal_mutation_state_fence_ck" CHECK ("project_goal_mutation_state"."fence_epoch" >= 0),
	CONSTRAINT "project_goal_mutation_state_owner_ck" CHECK ("project_goal_mutation_state"."owner" in ('node', 'rust') and ("project_goal_mutation_state"."owner" = 'node' or "project_goal_mutation_state"."fence_epoch" > 0))
);
--> statement-breakpoint
ALTER TABLE "project_goal_mutation_state"
  ADD CONSTRAINT "project_goal_mutation_state_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_goal_mutation_state"
  ADD CONSTRAINT "project_goal_mutation_state_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "project_goal_mutation_state_org_project_uq"
  ON "project_goal_mutation_state" ("org_id", "project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_goal_mutation_state_fence_token_uq"
  ON "project_goal_mutation_state" ("fence_token");
--> statement-breakpoint
INSERT INTO "project_goal_mutation_state" ("project_id", "org_id")
SELECT "id", "org_id"
FROM "projects"
ON CONFLICT ("project_id") DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION "provision_project_goal_mutation_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "project_goal_mutation_state" ("project_id", "org_id")
  VALUES (NEW."id", NEW."org_id")
  ON CONFLICT ("project_id") DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projects_goal_mutation_state_provisioning"
AFTER INSERT ON "projects"
FOR EACH ROW EXECUTE FUNCTION "provision_project_goal_mutation_state"();
--> statement-breakpoint
CREATE FUNCTION "guard_project_goal_mutation_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "projects"
    WHERE "id" = NEW."project_id" AND "org_id" = NEW."org_id"
  ) THEN
    RAISE EXCEPTION 'project goal mutation state has an invalid project organization' USING ERRCODE = '23514';
  END IF;
  IF NEW."project_id" <> OLD."project_id"
    OR NEW."org_id" <> OLD."org_id"
    OR NEW."mutation_version" < OLD."mutation_version"
    OR NEW."fence_epoch" < OLD."fence_epoch"
    OR NEW."fence_token" IS NULL
    OR (NEW."fence_epoch" > OLD."fence_epoch" AND NEW."fence_token" = OLD."fence_token")
    OR (NEW."fence_token" <> OLD."fence_token" AND NEW."fence_epoch" <= OLD."fence_epoch")
    OR (NEW."owner" <> OLD."owner"
      AND (NEW."fence_epoch" <= OLD."fence_epoch" OR NEW."fence_token" = OLD."fence_token")) THEN
    RAISE EXCEPTION 'project goal mutation version or ownership fence regressed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_goal_mutation_state_guard"
BEFORE UPDATE ON "project_goal_mutation_state"
FOR EACH ROW EXECUTE FUNCTION "guard_project_goal_mutation_state"();
