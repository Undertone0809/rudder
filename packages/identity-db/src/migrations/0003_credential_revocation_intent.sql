CREATE TABLE "rudder_identity"."credential_revocation_intent" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL
    REFERENCES "rudder_identity"."user"("id") ON DELETE restrict,
  "root_identity_user_id" uuid NOT NULL,
  "operation" text NOT NULL,
  "device_scope" text NOT NULL,
  "state" text NOT NULL,
  "attempt_count" integer DEFAULT 1 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "claim_owner" text,
  "claimed_at" timestamptz,
  "provider_completed_at" timestamptz,
  "rudder_completed_at" timestamptz,
  "manual_repair_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "credential_revocation_operation_check"
    CHECK ("operation" IN ('password-change', 'password-reset', 'global-sign-out')),
  CONSTRAINT "credential_revocation_device_scope_check"
    CHECK ("device_scope" IN ('none', 'all')),
  CONSTRAINT "credential_revocation_state_check"
    CHECK ("state" IN ('pending-provider', 'pending-rudder', 'manual-repair', 'completed')),
  CONSTRAINT "credential_revocation_completion_shape_check"
    CHECK (
      ("state" = 'pending-provider' AND "provider_completed_at" IS NULL AND "rudder_completed_at" IS NULL AND "manual_repair_at" IS NULL) OR
      ("state" = 'pending-rudder' AND "provider_completed_at" IS NOT NULL AND "rudder_completed_at" IS NULL AND "manual_repair_at" IS NULL) OR
      ("state" = 'manual-repair' AND "rudder_completed_at" IS NULL AND "manual_repair_at" IS NOT NULL) OR
      ("state" = 'completed' AND "provider_completed_at" IS NOT NULL AND "rudder_completed_at" IS NOT NULL AND "manual_repair_at" IS NULL)
    ),
  CONSTRAINT "credential_revocation_claim_shape_check"
    CHECK (
      ("claim_owner" IS NULL AND "claimed_at" IS NULL) OR
      ("claim_owner" IS NOT NULL AND "claimed_at" IS NOT NULL)
    )
);
CREATE INDEX "credential_revocation_user_state_idx"
  ON "rudder_identity"."credential_revocation_intent" ("user_id", "state");
CREATE UNIQUE INDEX "credential_revocation_one_pending_user_uidx"
  ON "rudder_identity"."credential_revocation_intent" ("user_id")
  WHERE "state" <> 'completed';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "rudder_identity"."credential_revocation_intent" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "rudder_identity"."credential_revocation_intent" FROM authenticated;
  END IF;
END
$$;
