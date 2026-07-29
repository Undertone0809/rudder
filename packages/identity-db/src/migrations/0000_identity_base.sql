CREATE SCHEMA IF NOT EXISTS "rudder_identity";

CREATE TABLE "rudder_identity"."user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "identity_user_normalized_email_uidx"
  ON "rudder_identity"."user" ("email");

CREATE TABLE "rudder_identity"."session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "token" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "rudder_identity"."user"("id") ON DELETE cascade
);
CREATE UNIQUE INDEX "identity_session_token_uidx" ON "rudder_identity"."session" ("token");
CREATE INDEX "identity_session_user_idx" ON "rudder_identity"."session" ("user_id");

CREATE TABLE "rudder_identity"."account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "rudder_identity"."user"("id") ON DELETE cascade,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope" text,
  "password" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "identity_account_provider_subject_uidx"
  ON "rudder_identity"."account" ("provider_id", "account_id");
CREATE INDEX "identity_account_user_idx" ON "rudder_identity"."account" ("user_id");

CREATE TABLE "rudder_identity"."verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);
CREATE INDEX "identity_verification_identifier_idx" ON "rudder_identity"."verification" ("identifier");
CREATE INDEX "identity_verification_expiry_idx" ON "rudder_identity"."verification" ("expires_at");

CREATE TABLE "rudder_identity"."device_code" (
  "id" text PRIMARY KEY NOT NULL,
  "device_code" text NOT NULL,
  "user_code" text NOT NULL,
  "user_id" text REFERENCES "rudder_identity"."user"("id") ON DELETE cascade,
  "expires_at" timestamptz NOT NULL,
  "status" text NOT NULL,
  "last_polled_at" timestamptz,
  "polling_interval" integer,
  "client_id" text,
  "scope" text
);
CREATE UNIQUE INDEX "identity_device_code_uidx" ON "rudder_identity"."device_code" ("device_code");
CREATE UNIQUE INDEX "identity_device_user_code_uidx" ON "rudder_identity"."device_code" ("user_code");
CREATE INDEX "identity_device_code_expiry_idx" ON "rudder_identity"."device_code" ("expires_at");

CREATE TABLE "rudder_identity"."rate_limit" (
  "id" text PRIMARY KEY NOT NULL,
  "key" text NOT NULL,
  "count" integer NOT NULL,
  "last_request" bigint NOT NULL
);
CREATE UNIQUE INDEX "identity_rate_limit_key_uidx" ON "rudder_identity"."rate_limit" ("key");

CREATE TABLE "rudder_identity"."account_email" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "rudder_identity"."user"("id") ON DELETE cascade,
  "email" text NOT NULL,
  "normalized_email" text NOT NULL,
  "verified_at" timestamptz NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "account_email_normalized_uidx"
  ON "rudder_identity"."account_email" ("normalized_email");
CREATE INDEX "account_email_user_idx" ON "rudder_identity"."account_email" ("user_id");

CREATE TABLE "rudder_identity"."identity_device" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "rudder_identity"."user"("id") ON DELETE cascade,
  "installation_id" text NOT NULL,
  "display_name" text NOT NULL,
  "public_key_thumbprint" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz
);
CREATE UNIQUE INDEX "identity_device_installation_uidx"
  ON "rudder_identity"."identity_device" ("user_id", "installation_id");
CREATE INDEX "identity_device_user_idx" ON "rudder_identity"."identity_device" ("user_id");

CREATE TABLE "rudder_identity"."device_refresh_credential" (
  "id" text PRIMARY KEY NOT NULL,
  "device_id" text NOT NULL REFERENCES "rudder_identity"."identity_device"("id") ON DELETE cascade,
  "secret_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "rotated_at" timestamptz,
  "revoked_at" timestamptz
);
CREATE UNIQUE INDEX "device_refresh_secret_hash_uidx"
  ON "rudder_identity"."device_refresh_credential" ("secret_hash");
CREATE INDEX "device_refresh_device_idx"
  ON "rudder_identity"."device_refresh_credential" ("device_id");

CREATE TABLE "rudder_identity"."device_access_credential" (
  "id" text PRIMARY KEY NOT NULL,
  "device_id" text NOT NULL REFERENCES "rudder_identity"."identity_device"("id") ON DELETE cascade,
  "secret_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz
);
CREATE UNIQUE INDEX "device_access_secret_hash_uidx"
  ON "rudder_identity"."device_access_credential" ("secret_hash");
CREATE INDEX "device_access_device_idx"
  ON "rudder_identity"."device_access_credential" ("device_id");

CREATE TABLE "rudder_identity"."authorization_code" (
  "id" text PRIMARY KEY NOT NULL,
  "code_hash" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "rudder_identity"."user"("id") ON DELETE cascade,
  "client_id" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "code_challenge_method" text NOT NULL,
  "audience" text NOT NULL,
  "jti" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "identity_authorization_code_hash_uidx"
  ON "rudder_identity"."authorization_code" ("code_hash");
CREATE UNIQUE INDEX "identity_authorization_code_jti_uidx"
  ON "rudder_identity"."authorization_code" ("jti");
CREATE INDEX "identity_authorization_code_expiry_idx"
  ON "rudder_identity"."authorization_code" ("expires_at");

CREATE TABLE "rudder_identity"."server_exchange_code" (
  "id" text PRIMARY KEY NOT NULL,
  "code_hash" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "rudder_identity"."user"("id") ON DELETE cascade,
  "device_id" text NOT NULL REFERENCES "rudder_identity"."identity_device"("id") ON DELETE cascade,
  "installation_id" text NOT NULL,
  "audience" text NOT NULL,
  "jti" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "server_exchange_code_hash_uidx"
  ON "rudder_identity"."server_exchange_code" ("code_hash");
CREATE UNIQUE INDEX "server_exchange_jti_uidx"
  ON "rudder_identity"."server_exchange_code" ("jti");
CREATE INDEX "server_exchange_expiry_idx"
  ON "rudder_identity"."server_exchange_code" ("expires_at");

CREATE TABLE "rudder_identity"."security_event" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text REFERENCES "rudder_identity"."user"("id") ON DELETE set null,
  "event_type" text NOT NULL,
  "device_id" text REFERENCES "rudder_identity"."identity_device"("id") ON DELETE set null,
  "ip_hash" text,
  "user_agent" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "security_event_user_created_idx"
  ON "rudder_identity"."security_event" ("user_id", "created_at");
CREATE INDEX "security_event_type_created_idx"
  ON "rudder_identity"."security_event" ("event_type", "created_at");

CREATE TABLE "rudder_identity"."email_rate_limit" (
  "bucket_key_hash" text NOT NULL,
  "action" text NOT NULL,
  "window_started_at" timestamptz NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "blocked_until" timestamptz,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("bucket_key_hash", "action")
);
CREATE INDEX "email_rate_limit_blocked_idx"
  ON "rudder_identity"."email_rate_limit" ("blocked_until");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA "rudder_identity" FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA "rudder_identity" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA "rudder_identity" FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA "rudder_identity" FROM authenticated;
  END IF;
END
$$;
