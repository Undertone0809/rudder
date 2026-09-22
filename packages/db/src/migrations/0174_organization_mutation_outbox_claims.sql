ALTER TABLE "organization_mutation_outbox"
  ADD COLUMN "claim_token" uuid,
  ADD COLUMN "claim_owner" text,
  ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organization_mutation_outbox"
  DROP CONSTRAINT "organization_mutation_outbox_state_ck";
--> statement-breakpoint
ALTER TABLE "organization_mutation_outbox"
  ADD CONSTRAINT "organization_mutation_outbox_state_ck"
  CHECK ("state" in ('pending', 'claimed', 'published') and "attempts" >= 0);
--> statement-breakpoint
ALTER TABLE "organization_mutation_outbox"
  ADD CONSTRAINT "organization_mutation_outbox_claim_ck"
  CHECK (("state" = 'claimed' AND "claim_token" IS NOT NULL AND "claim_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    OR ("state" <> 'claimed' AND "claim_token" IS NULL AND "claim_owner" IS NULL AND "lease_expires_at" IS NULL));
--> statement-breakpoint
CREATE INDEX "organization_mutation_outbox_lease_idx"
  ON "organization_mutation_outbox" ("state", "lease_expires_at", "next_attempt_at", "created_at");
