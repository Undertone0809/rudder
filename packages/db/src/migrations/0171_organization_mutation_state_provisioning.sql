-- Provision the Node-owned mutation baseline in the same transaction as every
-- organization insert, including compatibility and import creation paths.
CREATE FUNCTION "provision_organization_mutation_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "organization_mutation_state" ("org_id")
  VALUES (NEW."id")
  ON CONFLICT ("org_id") DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "organizations_mutation_state_provisioning"
AFTER INSERT ON "organizations"
FOR EACH ROW EXECUTE FUNCTION "provision_organization_mutation_state"();
