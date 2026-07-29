ALTER TABLE "rudder_identity"."device_refresh_credential"
  ADD COLUMN "client_id" text;

-- Existing refresh tokens predate client binding. Marking them with an
-- impossible client deliberately requires one fresh interactive sign-in.
UPDATE "rudder_identity"."device_refresh_credential"
  SET "client_id" = '__legacy_unbound__'
  WHERE "client_id" IS NULL;

ALTER TABLE "rudder_identity"."device_refresh_credential"
  ALTER COLUMN "client_id" SET NOT NULL;
