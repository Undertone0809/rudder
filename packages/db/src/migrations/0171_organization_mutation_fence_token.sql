-- Persist an opaque token for every ownership epoch. The token is deliberately
-- separate from the public version and epoch so stale processes cannot reuse a
-- previously observed ownership boundary after a handoff.
ALTER TABLE "organization_mutation_state"
  ADD COLUMN "fence_token" uuid;
--> statement-breakpoint
UPDATE "organization_mutation_state"
SET "fence_token" = gen_random_uuid()
WHERE "fence_token" IS NULL;
--> statement-breakpoint
ALTER TABLE "organization_mutation_state"
  ALTER COLUMN "fence_token" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "fence_token" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_mutation_state_fence_token_uq"
  ON "organization_mutation_state" ("fence_token");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_organization_mutation_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) THEN
      RAISE EXCEPTION 'cannot reset live organization mutation authority' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.org_id <> OLD.org_id
    OR NEW.mutation_version < OLD.mutation_version
    OR NEW.fence_epoch < OLD.fence_epoch
    OR NEW.fence_token IS NULL
    OR (NEW.fence_epoch > OLD.fence_epoch AND NEW.fence_token = OLD.fence_token)
    OR (NEW.fence_token <> OLD.fence_token AND NEW.fence_epoch <= OLD.fence_epoch)
    OR (NEW.owner <> OLD.owner
      AND (NEW.fence_epoch <= OLD.fence_epoch OR NEW.fence_token = OLD.fence_token)) THEN
    RAISE EXCEPTION 'organization mutation version or ownership fence regressed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
