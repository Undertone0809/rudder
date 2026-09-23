-- Scalar organization.brandColor authority is isolated from the existing
-- organization-wide D1 fence. Node remains the owner until an explicit Rust
-- handoff advances the branding epoch.
CREATE TABLE "organization_branding_mutation_state" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"mutation_version" bigint DEFAULT 0 NOT NULL,
	"fence_epoch" bigint DEFAULT 0 NOT NULL,
	"fence_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner" text DEFAULT 'node' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_branding_mutation_state_version_ck" CHECK ("organization_branding_mutation_state"."mutation_version" >= 0),
	CONSTRAINT "organization_branding_mutation_state_fence_ck" CHECK ("organization_branding_mutation_state"."fence_epoch" >= 0),
	CONSTRAINT "organization_branding_mutation_state_owner_ck" CHECK ("organization_branding_mutation_state"."owner" in ('node', 'rust') and ("organization_branding_mutation_state"."owner" = 'node' or "organization_branding_mutation_state"."fence_epoch" > 0))
);
--> statement-breakpoint
ALTER TABLE "organization_branding_mutation_state"
  ADD CONSTRAINT "organization_branding_mutation_state_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Provision historical organizations before enabling the insert trigger.
INSERT INTO "organization_branding_mutation_state" ("org_id")
SELECT "id"
FROM "organizations"
ON CONFLICT ("org_id") DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION "provision_organization_branding_mutation_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "organization_branding_mutation_state" ("org_id")
  VALUES (NEW."id")
  ON CONFLICT ("org_id") DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "organizations_branding_mutation_state_provisioning"
AFTER INSERT ON "organizations"
FOR EACH ROW EXECUTE FUNCTION "provision_organization_branding_mutation_state"();
--> statement-breakpoint
CREATE FUNCTION "guard_organization_branding_mutation_state"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) THEN
      RAISE EXCEPTION 'cannot reset live organization branding authority' USING ERRCODE = '23514';
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
    RAISE EXCEPTION 'organization branding mutation version or ownership fence regressed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "organization_branding_mutation_state_guard"
BEFORE UPDATE OR DELETE ON "organization_branding_mutation_state"
FOR EACH ROW EXECUTE FUNCTION "guard_organization_branding_mutation_state"();
--> statement-breakpoint
CREATE TABLE "organization_branding_mutation_receipts" (
	"org_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_fingerprint" text NOT NULL,
	"receipt_format" integer DEFAULT 1 NOT NULL,
	"outcome" text NOT NULL,
	"resulting_version" bigint NOT NULL,
	"fence_epoch" bigint NOT NULL,
	"activity_id" uuid NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_branding_mutation_receipts_org_id_idempotency_key_pk" PRIMARY KEY("org_id", "idempotency_key"),
	CONSTRAINT "organization_branding_mutation_receipts_activity_uq" UNIQUE("activity_id"),
	CONSTRAINT "organization_branding_mutation_receipts_key_ck" CHECK (octet_length("organization_branding_mutation_receipts"."idempotency_key") between 1 and 256),
	CONSTRAINT "organization_branding_mutation_receipts_fingerprint_ck" CHECK ("organization_branding_mutation_receipts"."command_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "organization_branding_mutation_receipts_outcome_ck" CHECK ("organization_branding_mutation_receipts"."outcome" in ('applied', 'noop')),
	CONSTRAINT "organization_branding_mutation_receipts_version_ck" CHECK ("organization_branding_mutation_receipts"."resulting_version" >= 0 and "organization_branding_mutation_receipts"."fence_epoch" >= 0 and "organization_branding_mutation_receipts"."receipt_format" > 0),
	CONSTRAINT "organization_branding_mutation_receipts_result_ck" CHECK (coalesce(
      jsonb_typeof("organization_branding_mutation_receipts"."result") = 'object'
      and "organization_branding_mutation_receipts"."result"->>'organization_id' = "organization_branding_mutation_receipts"."org_id"::text
      and "organization_branding_mutation_receipts"."result"->>'version' = "organization_branding_mutation_receipts"."resulting_version"::text
      and "organization_branding_mutation_receipts"."result"->>'fence_epoch' = "organization_branding_mutation_receipts"."fence_epoch"::text, false))
);
--> statement-breakpoint
ALTER TABLE "organization_branding_mutation_receipts"
  ADD CONSTRAINT "organization_branding_mutation_receipts_org_id_state_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organization_branding_mutation_state"("org_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organization_branding_mutation_receipts"
  ADD CONSTRAINT "organization_branding_mutation_receipts_activity_fk"
  FOREIGN KEY ("org_id", "activity_id") REFERENCES "public"."activity_log"("org_id", "id") ON DELETE no action ON UPDATE no action
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION "guard_organization_branding_mutation_receipt"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) THEN
    RAISE EXCEPTION 'organization branding mutation receipts are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "organization_branding_mutation_receipts_guard"
BEFORE UPDATE OR DELETE ON "organization_branding_mutation_receipts"
FOR EACH ROW EXECUTE FUNCTION "guard_organization_branding_mutation_receipt"();
--> statement-breakpoint
CREATE TABLE "organization_mutation_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_mutation_outbox_activity_uq" UNIQUE("activity_id"),
	CONSTRAINT "organization_mutation_outbox_state_ck" CHECK ("organization_mutation_outbox"."state" in ('pending', 'published') and "organization_mutation_outbox"."attempts" >= 0),
	CONSTRAINT "organization_mutation_outbox_payload_ck" CHECK (jsonb_typeof("organization_mutation_outbox"."payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "organization_mutation_outbox"
  ADD CONSTRAINT "organization_mutation_outbox_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organization_mutation_outbox"
  ADD CONSTRAINT "organization_mutation_outbox_activity_fk"
  FOREIGN KEY ("org_id", "activity_id") REFERENCES "public"."activity_log"("org_id", "id") ON DELETE no action ON UPDATE no action
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE INDEX "organization_mutation_outbox_claim_idx"
  ON "organization_mutation_outbox" ("state", "next_attempt_at", "created_at");
