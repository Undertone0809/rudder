CREATE TABLE "rudder_identity"."supabase_auth_user_binding" (
  "auth_user_id" uuid PRIMARY KEY NOT NULL,
  "rudder_user_id" text NOT NULL
    REFERENCES "rudder_identity"."user"("id") ON DELETE restrict,
  "normalized_email" text NOT NULL,
  "migration_batch" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "supabase_auth_binding_rudder_user_uidx"
  ON "rudder_identity"."supabase_auth_user_binding" ("rudder_user_id");
CREATE UNIQUE INDEX "supabase_auth_binding_normalized_email_uidx"
  ON "rudder_identity"."supabase_auth_user_binding" ("normalized_email");
CREATE INDEX "supabase_auth_binding_batch_idx"
  ON "rudder_identity"."supabase_auth_user_binding" ("migration_batch");
ALTER TABLE "rudder_identity"."supabase_auth_user_binding"
  ADD CONSTRAINT "supabase_auth_binding_normalized_email_check"
  CHECK (
    "normalized_email" <> '' AND
    "normalized_email" = lower(btrim("normalized_email"))
  ) NOT VALID;

CREATE TABLE "rudder_identity"."supabase_auth_migration_ledger" (
  "id" text PRIMARY KEY NOT NULL,
  "migration_batch" text NOT NULL,
  "rudder_user_id" text NOT NULL
    REFERENCES "rudder_identity"."user"("id") ON DELETE restrict,
  "normalized_email" text NOT NULL,
  "auth_user_id" uuid,
  "state" text NOT NULL,
  "resume_state" text,
  "attempt_count" integer DEFAULT 1 NOT NULL,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "supabase_auth_migration_state_check"
    CHECK ("state" IN (
      'pending',
      'auth_user_created',
      'bound',
      'linked',
      'verified',
      'failed'
    )),
  CONSTRAINT "supabase_auth_migration_resume_state_check"
    CHECK (
      "resume_state" IS NULL OR
      "resume_state" IN ('pending', 'auth_user_created', 'bound', 'linked', 'verified')
    ),
  CONSTRAINT "supabase_auth_migration_failure_shape_check"
    CHECK (
      (
        "state" = 'failed' AND
        "resume_state" IS NOT NULL AND
        "last_error" IS NOT NULL
      ) OR (
        "state" <> 'failed' AND
        "resume_state" IS NULL
      )
    ),
  CONSTRAINT "supabase_auth_migration_auth_user_shape_check"
    CHECK (
      ("state" = 'pending' AND "auth_user_id" IS NULL) OR
      (
        "state" IN ('auth_user_created', 'bound', 'linked', 'verified') AND
        "auth_user_id" IS NOT NULL
      ) OR
      (
        "state" = 'failed' AND (
          ("resume_state" = 'pending' AND "auth_user_id" IS NULL) OR
          ("resume_state" <> 'pending' AND "auth_user_id" IS NOT NULL)
        )
      )
    )
);
CREATE UNIQUE INDEX "supabase_auth_migration_rudder_user_uidx"
  ON "rudder_identity"."supabase_auth_migration_ledger" ("rudder_user_id");
CREATE UNIQUE INDEX "supabase_auth_migration_normalized_email_uidx"
  ON "rudder_identity"."supabase_auth_migration_ledger" ("normalized_email");
CREATE UNIQUE INDEX "supabase_auth_migration_auth_user_uidx"
  ON "rudder_identity"."supabase_auth_migration_ledger" ("auth_user_id");
CREATE INDEX "supabase_auth_migration_batch_state_idx"
  ON "rudder_identity"."supabase_auth_migration_ledger" ("migration_batch", "state");
ALTER TABLE "rudder_identity"."supabase_auth_migration_ledger"
  ADD CONSTRAINT "supabase_auth_migration_normalized_email_check"
  CHECK (
    "normalized_email" <> '' AND
    "normalized_email" = lower(btrim("normalized_email"))
  ) NOT VALID;

-- Offline grants are invalidated by server-owned epochs. These additions are
-- deliberately additive so the Better Auth rollback tables remain readable.
ALTER TABLE "rudder_identity"."user"
  ADD COLUMN "auth_epoch" integer DEFAULT 0 NOT NULL;
ALTER TABLE "rudder_identity"."identity_device"
  ADD COLUMN "auth_epoch" integer DEFAULT 0 NOT NULL;

CREATE TABLE "rudder_identity"."auth_state" (
  "id" text PRIMARY KEY NOT NULL,
  "offline_grant_schema_epoch" integer DEFAULT 2 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "auth_state_schema_epoch_check"
    CHECK ("offline_grant_schema_epoch" >= 2)
);
INSERT INTO "rudder_identity"."auth_state"
  ("id", "offline_grant_schema_epoch")
VALUES ('global', 2)
ON CONFLICT ("id") DO NOTHING;

-- Do not persist newly issued RFC 8628 bearer secrets in plaintext. The old
-- column remains nullable during rollback; existing short-lived rows expire.
ALTER TABLE "rudder_identity"."device_code"
  ALTER COLUMN "device_code" DROP NOT NULL,
  ADD COLUMN "device_code_hash" text,
  ADD COLUMN "consumed_at" timestamptz;
CREATE UNIQUE INDEX "identity_device_code_hash_uidx"
  ON "rudder_identity"."device_code" ("device_code_hash");
ALTER TABLE "rudder_identity"."device_code"
  ADD CONSTRAINT "identity_device_code_secret_shape_check"
  CHECK ("device_code_hash" IS NOT NULL OR "device_code" IS NOT NULL) NOT VALID;

ALTER TABLE "rudder_identity"."account_email"
  ADD CONSTRAINT "account_email_normalized_shape_check"
  CHECK (
    "normalized_email" <> '' AND
    "normalized_email" = lower(btrim("normalized_email"))
  ) NOT VALID;

DO $$
BEGIN
  IF
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rudder_identity_app') AND
    to_regclass('auth.sessions') IS NOT NULL
  THEN
    -- Sensitive Identity mutations must distinguish a still-valid JWT from an
    -- active Supabase session. Restrict the runtime role to the two columns
    -- needed for that online check; it must not read refresh-token material or
    -- mutate the managed Auth schema.
    GRANT USAGE ON SCHEMA auth TO rudder_identity_app;
    GRANT SELECT (id, user_id, not_after) ON auth.sessions TO rudder_identity_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "rudder_identity"."supabase_auth_user_binding" FROM anon;
    REVOKE ALL ON "rudder_identity"."supabase_auth_migration_ledger" FROM anon;
    REVOKE ALL ON "rudder_identity"."auth_state" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "rudder_identity"."supabase_auth_user_binding" FROM authenticated;
    REVOKE ALL ON "rudder_identity"."supabase_auth_migration_ledger" FROM authenticated;
    REVOKE ALL ON "rudder_identity"."auth_state" FROM authenticated;
  END IF;
END
$$;
