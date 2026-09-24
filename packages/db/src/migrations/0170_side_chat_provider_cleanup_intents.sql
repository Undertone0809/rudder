CREATE TABLE "side_chat_provider_cleanup_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"principal_scope_ref" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_epoch" integer NOT NULL,
	"segment_id" uuid NOT NULL,
	"fork_run_id" uuid,
	"agent_id" uuid NOT NULL,
	"runtime_type" text NOT NULL,
	"host_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"workspace_binding_id" text,
	"capability_revision" text,
	"parent_binding_id" uuid,
	"parent_session_id" text,
	"source_boundary_ref" text,
	"native_session_id" text NOT NULL,
	"session_params_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"profile_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"state_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"lease_owner" text,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "side_chat_provider_cleanup_intents_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "side_chat_provider_cleanup_state_check"
		CHECK ("state" IN ('pending', 'claimed', 'retry_wait', 'review_required', 'completed')),
	CONSTRAINT "side_chat_provider_cleanup_identity_check"
		CHECK ("binding_epoch" >= 0 AND "lease_epoch" >= 0 AND "attempt_count" >= 0
			AND btrim("principal_scope_ref") <> ''
			AND btrim("runtime_type") <> ''
			AND btrim("host_id") <> ''
			AND btrim("profile_id") <> ''
			AND btrim("native_session_id") <> ''),
	CONSTRAINT "side_chat_provider_cleanup_lease_check"
		CHECK (
			("state" = 'claimed' AND "lease_owner" IS NOT NULL AND btrim("lease_owner") <> '' AND "lease_expires_at" IS NOT NULL)
			OR
			("state" <> 'claimed' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL)
		),
	CONSTRAINT "side_chat_provider_cleanup_completion_check"
		CHECK (("state" = 'completed') = ("completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "side_chat_provider_cleanup_resource_uq"
	ON "side_chat_provider_cleanup_intents" USING btree
	("org_id", "conversation_id", "binding_id", "binding_epoch", "segment_id", "native_session_id");
--> statement-breakpoint
CREATE INDEX "side_chat_provider_cleanup_claim_idx"
	ON "side_chat_provider_cleanup_intents" USING btree
	("state", "next_attempt_at", "lease_expires_at", "created_at");
--> statement-breakpoint
CREATE INDEX "side_chat_provider_cleanup_scope_idx"
	ON "side_chat_provider_cleanup_intents" USING btree
	("org_id", "runtime_type", "host_id", "profile_id", "native_session_id");
