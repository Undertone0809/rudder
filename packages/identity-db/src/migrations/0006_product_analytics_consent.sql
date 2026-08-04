CREATE TABLE IF NOT EXISTS "rudder_identity"."product_analytics_consent" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "rudder_identity"."user"("id") ON DELETE CASCADE,
  "installation_id" text NOT NULL,
  "mode" text NOT NULL,
  "decision" text NOT NULL,
  "consent_version" text NOT NULL,
  "consent_epoch" integer NOT NULL,
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "product_analytics_consent_mode_check" CHECK ("mode" IN ('anonymous', 'account_linked')),
  CONSTRAINT "product_analytics_consent_decision_check" CHECK ("decision" IN ('granted', 'revoked')),
  CONSTRAINT "product_analytics_consent_epoch_check" CHECK ("consent_epoch" > 0)
);
CREATE INDEX IF NOT EXISTS "identity_product_analytics_consent_lookup_idx"
  ON "rudder_identity"."product_analytics_consent" ("user_id", "installation_id", "mode", "consent_epoch");
REVOKE ALL ON TABLE "rudder_identity"."product_analytics_consent" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rudder_identity_app') THEN
    GRANT SELECT, INSERT ON TABLE "rudder_identity"."product_analytics_consent" TO rudder_identity_app;
  END IF;
END
$$;
