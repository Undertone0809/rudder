-- Append this fragment to the newly generated D1 migration. Drizzle snapshots
-- describe the tables/indexes; these transition and deferred-FK invariants must
-- remain explicit because they are not represented by the schema DSL.
-- No historical SQL, existing writer, or migration-runner authority is changed.
ALTER TABLE "organization_mutation_receipts"
  ALTER CONSTRAINT "org_mutation_receipts_org_activity_fk"
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION "rudder_d1_authority_monotonic_v1"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.mutation_version < OLD.mutation_version
     OR NEW.fence_epoch < OLD.fence_epoch
     OR (NEW.writer_owner IS DISTINCT FROM OLD.writer_owner
         AND NEW.fence_epoch <= OLD.fence_epoch) THEN
    RAISE EXCEPTION 'D1 authority transition must preserve scope and advance its ownership fence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "org_mutation_authority_monotonic"
BEFORE UPDATE ON "organization_mutation_authorities"
FOR EACH ROW EXECUTE FUNCTION "rudder_d1_authority_monotonic_v1"();
--> statement-breakpoint
CREATE FUNCTION "rudder_d1_receipt_immutable_v1"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'D1 original mutation receipts cannot be rewritten'
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "org_mutation_receipt_immutable"
BEFORE UPDATE ON "organization_mutation_receipts"
FOR EACH ROW EXECUTE FUNCTION "rudder_d1_receipt_immutable_v1"();
