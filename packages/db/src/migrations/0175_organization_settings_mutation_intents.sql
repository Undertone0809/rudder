-- Durable transitional coordinator input for Chat organization settings.
-- The source and command payload are immutable; only claim, receipt, retry,
-- and downstream progress fields may advance after insertion.
-- Source UUIDs are retained as immutable recovery/audit identities. They do
-- not own the lifetime of Chat rows: the validation trigger enforces the
-- organization boundary while a source exists, and Chat cleanup may proceed.
ALTER TABLE "organization_mutation_receipts"
  DROP CONSTRAINT "organization_mutation_receipts_kind_ck";
--> statement-breakpoint
ALTER TABLE "organization_mutation_receipts"
  ADD CONSTRAINT "organization_mutation_receipts_kind_ck"
  CHECK ("command_kind" in ('organization_branding', 'organization_settings', 'project_goal_link', 'project_goal_set_replacement'));
--> statement-breakpoint
CREATE TABLE "organization_mutation_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"command_kind" text DEFAULT 'organization_settings' NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"approval_id" uuid,
	"conversation_id" uuid NOT NULL,
	"proposal_message_id" uuid,
	"actor_user_id" text,
	"actor_principal" text NOT NULL,
	"decided_by_user_id" text,
	"decision_note" text,
	"generation" bigint NOT NULL,
	"patch" jsonb NOT NULL,
	"patch_fingerprint" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"rust_idempotency_key" text NOT NULL,
	"phase" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"claim_owner" text,
	"lease_expires_at" timestamp with time zone,
	"rust_receipt" jsonb,
	"rust_committed_at" timestamp with time zone,
	"downstream_targets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"downstream_progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"downstream_attempts" integer DEFAULT 0 NOT NULL,
	"downstream_next_attempt_at" timestamp with time zone,
	"downstream_claim_token" uuid,
	"downstream_claim_owner" text,
	"downstream_lease_expires_at" timestamp with time zone,
	"downstream_completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_mutation_intents_org_key_uq" UNIQUE("org_id","rust_idempotency_key"),
	CONSTRAINT "organization_mutation_intents_source_generation_uq" UNIQUE("org_id","source_kind","source_id","generation"),
	CONSTRAINT "organization_mutation_intents_kind_ck" CHECK ("command_kind" = 'organization_settings'),
	CONSTRAINT "organization_mutation_intents_source_kind_ck" CHECK ("source_kind" in ('chat_lightweight', 'chat_approval')),
	CONSTRAINT "organization_mutation_intents_source_shape_ck" CHECK ((
        ("source_kind" = 'chat_lightweight'
          and "approval_id" is null
          and "proposal_message_id" is not null
          and "source_id" = "proposal_message_id")
        or
        ("source_kind" = 'chat_approval'
          and "approval_id" is not null
          and "source_id" = "approval_id")
      )),
	CONSTRAINT "organization_mutation_intents_phase_ck" CHECK ("phase" in ('pending', 'claimed', 'rust_committed', 'downstream_pending', 'effects_claimed', 'completed', 'rejected', 'cancelled', 'failed')),
	CONSTRAINT "organization_mutation_intents_claim_ck" CHECK (("phase" = 'claimed'
        and "claim_token" is not null
        and "claim_owner" is not null
        and "lease_expires_at" is not null)
      or ("phase" <> 'claimed'
        and "claim_token" is null
        and "claim_owner" is null
        and "lease_expires_at" is null)),
	CONSTRAINT "organization_mutation_intents_downstream_claim_ck" CHECK (("phase" = 'effects_claimed'
        and "downstream_claim_token" is not null
        and "downstream_claim_owner" is not null
        and "downstream_lease_expires_at" is not null)
      or ("phase" <> 'effects_claimed'
        and "downstream_claim_token" is null
        and "downstream_claim_owner" is null
        and "downstream_lease_expires_at" is null)),
	CONSTRAINT "organization_mutation_intents_counter_ck" CHECK ("generation" >= 1 and "attempts" >= 0 and "downstream_attempts" >= 0),
	CONSTRAINT "organization_mutation_intents_patch_ck" CHECK (jsonb_typeof("patch") = 'object' and "patch" <> '{}'::jsonb),
	CONSTRAINT "organization_mutation_intents_fingerprint_ck" CHECK ("patch_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "organization_mutation_intents_intent_fingerprint_ck" CHECK ("intent_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "organization_mutation_intents_key_ck" CHECK (octet_length("rust_idempotency_key") between 1 and 256),
	CONSTRAINT "organization_mutation_intents_actor_ck" CHECK (octet_length(btrim("actor_principal")) between 1 and 256
        and ("actor_user_id" is null or octet_length(btrim("actor_user_id")) between 1 and 256)
        and ("decided_by_user_id" is null or octet_length(btrim("decided_by_user_id")) between 1 and 256)),
	CONSTRAINT "organization_mutation_intents_post_rust_ck" CHECK (("phase" not in ('rust_committed', 'downstream_pending', 'effects_claimed', 'completed')
        or ("rust_receipt" is not null and "rust_committed_at" is not null))
        and ("phase" <> 'completed' or "downstream_completed_at" is not null)),
	CONSTRAINT "organization_mutation_intents_targets_ck" CHECK (jsonb_typeof("downstream_targets") = 'object'),
	CONSTRAINT "organization_mutation_intents_progress_ck" CHECK (jsonb_typeof("downstream_progress") = 'object')
);
--> statement-breakpoint
ALTER TABLE "organization_mutation_intents"
  ADD CONSTRAINT "organization_mutation_intents_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "organization_mutation_intents_claim_idx"
  ON "organization_mutation_intents" USING btree ("phase", "next_attempt_at", "created_at");
--> statement-breakpoint
CREATE INDEX "organization_mutation_intents_lease_idx"
  ON "organization_mutation_intents" USING btree ("phase", "lease_expires_at", "next_attempt_at", "created_at");
--> statement-breakpoint
CREATE INDEX "organization_mutation_intents_downstream_claim_idx"
  ON "organization_mutation_intents" USING btree ("phase", "downstream_next_attempt_at", "created_at");
--> statement-breakpoint
CREATE INDEX "organization_mutation_intents_approval_generation_idx"
  ON "organization_mutation_intents" USING btree ("org_id", "approval_id", "generation");
--> statement-breakpoint
CREATE FUNCTION "validate_organization_mutation_intent"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  patch_key text;
BEGIN
  IF NEW.command_kind <> 'organization_settings' THEN
    RAISE EXCEPTION 'unsupported organization mutation intent command kind' USING ERRCODE = '23514';
  END IF;

  IF NOT (jsonb_typeof(NEW.patch) = 'object' AND NEW.patch <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'organization settings intent patch must be a non-empty object' USING ERRCODE = '23514';
  END IF;

  FOR patch_key IN SELECT jsonb_object_keys(NEW.patch) LOOP
    IF patch_key NOT IN (
      'name', 'description', 'status', 'budgetMonthlyCents',
      'spentMonthlyCents', 'defaultChatIssueCreationMode',
      'requireBoardApprovalForNewAgents', 'issuePrefix', 'brandColor',
      'logoAssetId'
    ) THEN
      RAISE EXCEPTION 'organization settings intent contains an unsupported patch field: %', patch_key USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF NEW.patch ? 'name' AND jsonb_typeof(NEW.patch->'name') <> 'string' THEN
    RAISE EXCEPTION 'organization settings name patch must be a string' USING ERRCODE = '23514';
  END IF;
  IF NEW.patch ? 'description' AND jsonb_typeof(NEW.patch->'description') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'organization settings description patch must be a string or null' USING ERRCODE = '23514';
  END IF;
  IF NEW.patch ? 'status' AND jsonb_typeof(NEW.patch->'status') <> 'string' THEN
    RAISE EXCEPTION 'organization settings status patch must be a string' USING ERRCODE = '23514';
  END IF;
  IF NEW.patch ? 'budgetMonthlyCents' AND jsonb_typeof(NEW.patch->'budgetMonthlyCents') <> 'number' THEN
    RAISE EXCEPTION 'organization settings budgetMonthlyCents patch must be a number' USING ERRCODE = '23514';
  END IF;
  IF NEW.patch ? 'spentMonthlyCents' AND jsonb_typeof(NEW.patch->'spentMonthlyCents') <> 'number' THEN
    RAISE EXCEPTION 'organization settings spentMonthlyCents patch must be a number' USING ERRCODE = '23514';
  END IF;
  IF NEW.patch ? 'defaultChatIssueCreationMode' AND jsonb_typeof(NEW.patch->'defaultChatIssueCreationMode') <> 'string' THEN
    RAISE EXCEPTION 'organization settings defaultChatIssueCreationMode patch must be a string' USING ERRCODE = '23514';
  END IF;
  IF NEW.patch ? 'requireBoardApprovalForNewAgents' AND jsonb_typeof(NEW.patch->'requireBoardApprovalForNewAgents') <> 'boolean' THEN
    RAISE EXCEPTION 'organization settings requireBoardApprovalForNewAgents patch must be a boolean' USING ERRCODE = '23514';
  END IF;
  IF NEW.patch ? 'issuePrefix' AND jsonb_typeof(NEW.patch->'issuePrefix') <> 'string' THEN
    RAISE EXCEPTION 'organization settings issuePrefix patch must be a string' USING ERRCODE = '23514';
  END IF;
  IF NEW.patch ? 'brandColor' AND jsonb_typeof(NEW.patch->'brandColor') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'organization settings brandColor patch must be a string or null' USING ERRCODE = '23514';
  END IF;
  IF NEW.patch ? 'logoAssetId' AND jsonb_typeof(NEW.patch->'logoAssetId') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'organization settings logoAssetId patch must be a string or null' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' OR EXISTS (
    SELECT 1 FROM chat_conversations
    WHERE id = NEW.conversation_id
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM chat_conversations
      WHERE id = NEW.conversation_id AND org_id = NEW.org_id
    ) THEN
      RAISE EXCEPTION 'organization mutation intent conversation is outside its organization' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.source_kind = 'chat_approval' THEN
    IF TG_OP = 'INSERT' OR EXISTS (
      SELECT 1 FROM approvals
      WHERE id = NEW.approval_id
    ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM approvals
        WHERE id = NEW.approval_id AND org_id = NEW.org_id
      ) THEN
        RAISE EXCEPTION 'organization mutation intent approval is outside its organization' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'INSERT' OR EXISTS (
      SELECT 1 FROM chat_messages
      WHERE id = NEW.proposal_message_id
    ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM chat_messages
        WHERE id = NEW.proposal_message_id
          AND org_id = NEW.org_id
          AND conversation_id = NEW.conversation_id
      ) THEN
        RAISE EXCEPTION 'organization lightweight mutation intent proposal message is outside its conversation' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.proposal_message_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR EXISTS (
      SELECT 1 FROM chat_messages
      WHERE id = NEW.proposal_message_id
    ))
    AND NOT EXISTS (
      SELECT 1 FROM chat_messages
      WHERE id = NEW.proposal_message_id
        AND org_id = NEW.org_id
        AND conversation_id = NEW.conversation_id
    ) THEN
    RAISE EXCEPTION 'organization mutation intent proposal message is outside its conversation' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "organization_mutation_intents_validation"
BEFORE INSERT OR UPDATE ON "organization_mutation_intents"
FOR EACH ROW EXECUTE FUNCTION "validate_organization_mutation_intent"();
--> statement-breakpoint
CREATE FUNCTION "guard_organization_mutation_intent"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) THEN
      RAISE EXCEPTION 'organization mutation intents are durable and cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.command_kind IS DISTINCT FROM OLD.command_kind
    OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.proposal_message_id IS DISTINCT FROM OLD.proposal_message_id
    OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
    OR NEW.actor_principal IS DISTINCT FROM OLD.actor_principal
    OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id
    OR NEW.decision_note IS DISTINCT FROM OLD.decision_note
    OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.patch IS DISTINCT FROM OLD.patch
    OR NEW.patch_fingerprint IS DISTINCT FROM OLD.patch_fingerprint
    OR NEW.intent_fingerprint IS DISTINCT FROM OLD.intent_fingerprint
    OR NEW.rust_idempotency_key IS DISTINCT FROM OLD.rust_idempotency_key THEN
    RAISE EXCEPTION 'organization mutation intent source or command identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.downstream_targets <> '{}'::jsonb
    AND NEW.downstream_targets IS DISTINCT FROM OLD.downstream_targets THEN
    RAISE EXCEPTION 'organization mutation intent downstream targets are immutable once bound' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "organization_mutation_intents_guard"
BEFORE UPDATE OR DELETE ON "organization_mutation_intents"
FOR EACH ROW EXECUTE FUNCTION "guard_organization_mutation_intent"();
