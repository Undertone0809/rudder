ALTER TABLE "heartbeat_runs" ADD COLUMN "scene" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "target_type" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "target_id" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "session_intent_json" jsonb;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_common_run_identity_check"
	CHECK (
		("scene" IS NULL AND "target_type" IS NULL AND "target_id" IS NULL
			AND "idempotency_key" IS NULL AND "session_intent_json" IS NULL)
		OR
		("scene" IS NOT NULL AND "target_type" IS NOT NULL AND "target_id" IS NOT NULL
			AND "idempotency_key" IS NOT NULL AND "session_intent_json" IS NOT NULL)
	);
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_scene_check"
	CHECK ("scene" IS NULL OR "scene" IN ('chat', 'side_chat', 'issue', 'review', 'automation', 'heartbeat'));
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_target_check"
	CHECK (
		("target_type" IS NULL AND "target_id" IS NULL)
		OR
		("target_type" IS NOT NULL AND "target_type" IN ('issue', 'chat_conversation', 'chat_message', 'automation_run', 'wakeup_request', 'manual', 'review')
			AND "target_id" IS NOT NULL AND "target_id" = btrim("target_id") AND btrim("target_id") <> '')
	);
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_idempotency_key_check"
	CHECK ("idempotency_key" IS NULL OR ("idempotency_key" = btrim("idempotency_key") AND octet_length("idempotency_key") BETWEEN 1 AND 512));
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_session_intent_shape_check"
	CHECK (
		"session_intent_json" IS NULL
		OR (
			jsonb_typeof("session_intent_json") = 'object'
			AND "session_intent_json" ?& ARRAY['kind', 'reuseScope', 'sourceRunId', 'sessionId', 'sessionParams']
			AND jsonb_typeof("session_intent_json"->'kind') = 'string'
			AND jsonb_typeof("session_intent_json"->'reuseScope') = 'string'
			AND "session_intent_json"->>'kind' IN ('fresh', 'resume', 'fork')
			AND (
				(
					"session_intent_json"->>'kind' = 'fresh'
					AND "session_intent_json"->>'reuseScope' = 'none'
					AND jsonb_typeof("session_intent_json"->'sourceRunId') = 'null'
					AND jsonb_typeof("session_intent_json"->'sessionId') = 'null'
					AND jsonb_typeof("session_intent_json"->'sessionParams') = 'null'
					AND NOT ("session_intent_json" ? 'sourceBoundaryRef')
				)
				OR
				(
					"session_intent_json"->>'kind' = 'resume'
					AND "session_intent_json"->>'reuseScope' IN ('explicit', 'task')
					AND (
						jsonb_typeof("session_intent_json"->'sourceRunId') = 'null'
						OR (jsonb_typeof("session_intent_json"->'sourceRunId') = 'string' AND "session_intent_json"->>'sourceRunId' = btrim("session_intent_json"->>'sourceRunId') AND btrim("session_intent_json"->>'sourceRunId') <> '')
					)
					AND (
						jsonb_typeof("session_intent_json"->'sessionId') = 'null'
						OR (jsonb_typeof("session_intent_json"->'sessionId') = 'string' AND "session_intent_json"->>'sessionId' = btrim("session_intent_json"->>'sessionId') AND btrim("session_intent_json"->>'sessionId') <> '')
					)
					AND jsonb_typeof("session_intent_json"->'sessionParams') IN ('null', 'object')
					AND NOT ("session_intent_json" ? 'sourceBoundaryRef')
				)
				OR
				(
					"session_intent_json"->>'kind' = 'fork'
					AND "session_intent_json"->>'reuseScope' = 'explicit'
					AND jsonb_typeof("session_intent_json"->'sourceRunId') = 'string'
					AND "session_intent_json"->>'sourceRunId' = btrim("session_intent_json"->>'sourceRunId')
					AND btrim("session_intent_json"->>'sourceRunId') <> ''
					AND "session_intent_json" ? 'sourceBoundaryRef'
					AND jsonb_typeof("session_intent_json"->'sourceBoundaryRef') = 'string'
					AND "session_intent_json"->>'sourceBoundaryRef' = btrim("session_intent_json"->>'sourceBoundaryRef')
					AND btrim("session_intent_json"->>'sourceBoundaryRef') <> ''
					AND (
						jsonb_typeof("session_intent_json"->'sessionId') = 'null'
						OR (jsonb_typeof("session_intent_json"->'sessionId') = 'string' AND "session_intent_json"->>'sessionId' = btrim("session_intent_json"->>'sessionId') AND btrim("session_intent_json"->>'sessionId') <> '')
					)
					AND jsonb_typeof("session_intent_json"->'sessionParams') IN ('null', 'object')
				)
			)
		)
	);
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_org_idempotency_key_uq" ON "heartbeat_runs" USING btree ("org_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "runtime_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"principal_scope_ref" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"runtime_type" text NOT NULL,
	"host_id" text DEFAULT 'local' NOT NULL,
	"profile_id" text DEFAULT 'default' NOT NULL,
	"workspace_binding_id" text,
	"instructions_revision" text DEFAULT 'unknown' NOT NULL,
	"capability_revision" text DEFAULT 'unknown' NOT NULL,
	"continuity" text DEFAULT 'native' NOT NULL,
	"parent_binding_id" uuid,
	"source_boundary_ref" text,
	"binding_epoch" integer DEFAULT 0 NOT NULL,
	"current_segment_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_bindings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "runtime_bindings_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "runtime_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "runtime_bindings_parent_binding_id_fk" FOREIGN KEY ("parent_binding_id") REFERENCES "public"."runtime_bindings"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "runtime_bindings_continuity_check" CHECK ("continuity" in ('native', 'context_handoff', 'legacy')),
	CONSTRAINT "runtime_bindings_status_check" CHECK ("status" in ('active', 'closed', 'superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_bindings_org_conversation_uq" ON "runtime_bindings" USING btree ("org_id","conversation_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_bindings_org_conversation_epoch_uq" ON "runtime_bindings" USING btree ("org_id","conversation_id","binding_epoch");
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_bindings_org_id_uq" ON "runtime_bindings" USING btree ("org_id","id");
--> statement-breakpoint
CREATE INDEX "runtime_bindings_org_agent_updated_idx" ON "runtime_bindings" USING btree ("org_id","agent_id","updated_at");
--> statement-breakpoint
CREATE INDEX "runtime_bindings_org_current_segment_idx" ON "runtime_bindings" USING btree ("org_id","current_segment_id");
--> statement-breakpoint
ALTER TABLE "runtime_bindings" ADD CONSTRAINT "runtime_bindings_binding_epoch_check"
	CHECK ("binding_epoch" >= 0);
--> statement-breakpoint
ALTER TABLE "runtime_bindings" ADD CONSTRAINT "runtime_bindings_parent_binding_not_self_check"
	CHECK ("parent_binding_id" IS NULL OR "parent_binding_id" <> "id");
--> statement-breakpoint
CREATE TABLE "native_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"runtime_type" text NOT NULL,
	"segment_ordinal" integer DEFAULT 0 NOT NULL,
	"native_session_id" text,
	"root_session_id" text,
	"parent_segment_id" uuid,
	"leaf_id" text,
	"provider_state_json" jsonb,
	"source_boundary_ref" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_segments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "native_segments_binding_id_runtime_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."runtime_bindings"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "native_segments_parent_segment_id_fk" FOREIGN KEY ("parent_segment_id") REFERENCES "public"."native_segments"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "native_segments_state_check" CHECK ("state" in ('pending', 'open', 'sealed', 'superseded'))
);
--> statement-breakpoint
CREATE INDEX "native_segments_binding_created_idx" ON "native_segments" USING btree ("binding_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "native_segments_binding_ordinal_uq" ON "native_segments" USING btree ("binding_id","segment_ordinal");
--> statement-breakpoint
CREATE UNIQUE INDEX "native_segments_org_id_uq" ON "native_segments" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "native_segments_org_binding_id_uq" ON "native_segments" USING btree ("org_id","binding_id","id");
--> statement-breakpoint
CREATE INDEX "native_segments_org_native_session_idx" ON "native_segments" USING btree ("org_id","native_session_id");
--> statement-breakpoint
CREATE INDEX "native_segments_binding_leaf_idx" ON "native_segments" USING btree ("binding_id","leaf_id");
--> statement-breakpoint
ALTER TABLE "native_segments" ADD CONSTRAINT "native_segments_segment_ordinal_check"
	CHECK ("segment_ordinal" >= 0);
--> statement-breakpoint
ALTER TABLE "native_segments" ADD CONSTRAINT "native_segments_parent_segment_not_self_check"
	CHECK ("parent_segment_id" IS NULL OR "parent_segment_id" <> "id");
--> statement-breakpoint
ALTER TABLE "native_segments" ADD CONSTRAINT "native_segments_sealed_lifecycle_check"
	CHECK (
		("state" IN ('pending', 'open') AND "sealed_at" IS NULL)
		OR ("state" IN ('sealed', 'superseded') AND "sealed_at" IS NOT NULL)
	);
--> statement-breakpoint
ALTER TABLE "native_segments" ADD CONSTRAINT "native_segments_sealed_after_create_check"
	CHECK ("sealed_at" IS NULL OR "sealed_at" >= "created_at");
--> statement-breakpoint
CREATE TABLE "run_runtime_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"attempt_id" uuid,
	"attempt_ref" text NOT NULL,
	"attempt_epoch" integer DEFAULT 1 NOT NULL,
	"owner_token" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"relation" text DEFAULT 'primary' NOT NULL,
	"native_execution_ref" text,
	"input_correlation_ref" text,
	"selector_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_revision" text,
	"state" text DEFAULT 'open' NOT NULL,
	"completeness" text DEFAULT 'unknown' NOT NULL,
	"visibility_cutoff_ref" text,
	"supplemental_object_ref" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_runtime_spans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "run_runtime_spans_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "run_runtime_spans_binding_id_runtime_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."runtime_bindings"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "run_runtime_spans_segment_id_native_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."native_segments"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "run_runtime_spans_attempt_id_heartbeat_run_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."heartbeat_run_attempts"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "run_runtime_spans_state_check" CHECK ("state" in ('open', 'sealed', 'unresolved')),
	CONSTRAINT "run_runtime_spans_completeness_check" CHECK ("completeness" in ('complete', 'partial', 'terminal_only', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "run_runtime_spans" ADD CONSTRAINT "run_runtime_spans_attempt_epoch_check"
	CHECK ("attempt_epoch" > 0);
--> statement-breakpoint
ALTER TABLE "run_runtime_spans" ADD CONSTRAINT "run_runtime_spans_ordinal_check"
	CHECK ("ordinal" >= 0);
--> statement-breakpoint
ALTER TABLE "run_runtime_spans" ADD CONSTRAINT "run_runtime_spans_relation_check"
	CHECK ("relation" IN ('primary', 'continuation', 'native_subagent'));
--> statement-breakpoint
ALTER TABLE "run_runtime_spans" ADD CONSTRAINT "run_runtime_spans_closed_lifecycle_check"
	CHECK (
		("state" = 'open' AND "closed_at" IS NULL)
		OR ("state" IN ('sealed', 'unresolved') AND "closed_at" IS NOT NULL)
	);
--> statement-breakpoint
ALTER TABLE "run_runtime_spans" ADD CONSTRAINT "run_runtime_spans_closed_after_open_check"
	CHECK ("closed_at" IS NULL OR "closed_at" >= "opened_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "run_runtime_spans_org_run_ordinal_uq" ON "run_runtime_spans" USING btree ("org_id","run_id","ordinal");
--> statement-breakpoint
CREATE INDEX "run_runtime_spans_org_run_idx" ON "run_runtime_spans" USING btree ("org_id","run_id","opened_at");
--> statement-breakpoint
CREATE INDEX "run_runtime_spans_binding_segment_idx" ON "run_runtime_spans" USING btree ("binding_id","segment_id","opened_at");
--> statement-breakpoint
CREATE INDEX "run_runtime_spans_open_idx" ON "run_runtime_spans" USING btree ("state","updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_org_id_uq" ON "chat_conversations" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_org_id_uq" ON "heartbeat_runs" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_attempts_org_id_uq" ON "heartbeat_run_attempts" USING btree ("org_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_attempts_org_run_id_uq" ON "heartbeat_run_attempts" USING btree ("org_id","run_id","id");
--> statement-breakpoint
ALTER TABLE "runtime_bindings" ADD CONSTRAINT "runtime_bindings_org_conversation_fk"
	FOREIGN KEY ("org_id", "conversation_id") REFERENCES "public"."chat_conversations"("org_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "runtime_bindings" ADD CONSTRAINT "runtime_bindings_org_agent_fk"
	FOREIGN KEY ("org_id", "agent_id") REFERENCES "public"."agents"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "runtime_bindings" ADD CONSTRAINT "runtime_bindings_parent_binding_org_fk"
	FOREIGN KEY ("org_id", "parent_binding_id") REFERENCES "public"."runtime_bindings"("org_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "runtime_bindings" ADD CONSTRAINT "runtime_bindings_current_segment_fk"
	FOREIGN KEY ("current_segment_id") REFERENCES "public"."native_segments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "runtime_bindings" ADD CONSTRAINT "runtime_bindings_current_segment_binding_fk"
	FOREIGN KEY ("org_id", "id", "current_segment_id") REFERENCES "public"."native_segments"("org_id", "binding_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "native_segments" ADD CONSTRAINT "native_segments_org_binding_fk"
	FOREIGN KEY ("org_id", "binding_id") REFERENCES "public"."runtime_bindings"("org_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "native_segments" ADD CONSTRAINT "native_segments_parent_segment_binding_fk"
	FOREIGN KEY ("org_id", "binding_id", "parent_segment_id") REFERENCES "public"."native_segments"("org_id", "binding_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_runtime_spans" ADD CONSTRAINT "run_runtime_spans_org_run_fk"
	FOREIGN KEY ("org_id", "run_id") REFERENCES "public"."heartbeat_runs"("org_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_runtime_spans" ADD CONSTRAINT "run_runtime_spans_org_binding_fk"
	FOREIGN KEY ("org_id", "binding_id") REFERENCES "public"."runtime_bindings"("org_id", "id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_runtime_spans" ADD CONSTRAINT "run_runtime_spans_org_segment_fk"
	FOREIGN KEY ("org_id", "segment_id") REFERENCES "public"."native_segments"("org_id", "id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_runtime_spans" ADD CONSTRAINT "run_runtime_spans_org_attempt_fk"
	FOREIGN KEY ("org_id", "attempt_id") REFERENCES "public"."heartbeat_run_attempts"("org_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_runtime_spans" ADD CONSTRAINT "run_runtime_spans_binding_segment_fk"
	FOREIGN KEY ("org_id", "binding_id", "segment_id") REFERENCES "public"."native_segments"("org_id", "binding_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_runtime_spans" ADD CONSTRAINT "run_runtime_spans_run_attempt_fk"
	FOREIGN KEY ("org_id", "run_id", "attempt_id") REFERENCES "public"."heartbeat_run_attempts"("org_id", "run_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "runtime_retention_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"binding_id" uuid,
	"segment_id" uuid,
	"resource_ref" text NOT NULL,
	"purpose" text NOT NULL,
	"principal_scope_ref" text NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"lifecycle_version" integer DEFAULT 1 NOT NULL,
	"cleanup_epoch" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_retention_claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "runtime_retention_claims_binding_id_runtime_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."runtime_bindings"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "runtime_retention_claims_segment_id_native_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."native_segments"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "runtime_retention_claims_status_check" CHECK ("status" in ('active', 'released', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_retention_claims_org_resource_purpose_uq" ON "runtime_retention_claims" USING btree ("org_id","resource_ref","purpose") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "runtime_retention_claims_org_resource_idx" ON "runtime_retention_claims" USING btree ("org_id","resource_ref");
--> statement-breakpoint
CREATE INDEX "runtime_retention_claims_expiry_idx" ON "runtime_retention_claims" USING btree ("status","expires_at","cleanup_epoch");
--> statement-breakpoint
ALTER TABLE "runtime_retention_claims" ADD CONSTRAINT "runtime_retention_claims_lifecycle_version_check"
	CHECK ("lifecycle_version" > 0 AND "cleanup_epoch" >= 0);
--> statement-breakpoint
ALTER TABLE "runtime_retention_claims" ADD CONSTRAINT "runtime_retention_claims_lifecycle_check"
	CHECK (
		("status" = 'active' AND "released_at" IS NULL)
		OR ("status" = 'released' AND "released_at" IS NOT NULL)
		OR ("status" = 'expired' AND "expires_at" IS NOT NULL AND "released_at" IS NULL)
	);
--> statement-breakpoint
ALTER TABLE "runtime_retention_claims" ADD CONSTRAINT "runtime_retention_claims_timestamp_order_check"
	CHECK (
		("expires_at" IS NULL OR "expires_at" >= "created_at")
		AND ("released_at" IS NULL OR "released_at" >= "created_at")
	);
--> statement-breakpoint
ALTER TABLE "runtime_retention_claims" ADD CONSTRAINT "runtime_retention_claims_org_binding_fk"
	FOREIGN KEY ("org_id", "binding_id") REFERENCES "public"."runtime_bindings"("org_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "runtime_retention_claims" ADD CONSTRAINT "runtime_retention_claims_org_segment_fk"
	FOREIGN KEY ("org_id", "segment_id") REFERENCES "public"."native_segments"("org_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "runtime_source_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid,
	"run_id" uuid,
	"binding_id" uuid,
	"segment_id" uuid,
	"source_kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_range_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_sha256" text,
	"principal_scope_ref" text NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"lifecycle_version" integer DEFAULT 1 NOT NULL,
	"cleanup_epoch" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_source_aliases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "runtime_source_aliases_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "runtime_source_aliases_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "runtime_source_aliases_binding_id_runtime_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."runtime_bindings"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "runtime_source_aliases_segment_id_native_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."native_segments"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "runtime_source_aliases_org_source_idx" ON "runtime_source_aliases" USING btree ("org_id","source_kind","source_ref");
--> statement-breakpoint
CREATE INDEX "runtime_source_aliases_org_conversation_idx" ON "runtime_source_aliases" USING btree ("org_id","conversation_id");
--> statement-breakpoint
CREATE INDEX "runtime_source_aliases_org_run_idx" ON "runtime_source_aliases" USING btree ("org_id","run_id");
--> statement-breakpoint
CREATE INDEX "runtime_source_aliases_cleanup_idx" ON "runtime_source_aliases" USING btree ("org_id","cleanup_epoch","released_at");
--> statement-breakpoint
ALTER TABLE "runtime_source_aliases" ADD CONSTRAINT "runtime_source_aliases_lifecycle_version_check"
	CHECK ("lifecycle_version" > 0 AND "cleanup_epoch" >= 0);
--> statement-breakpoint
ALTER TABLE "runtime_source_aliases" ADD CONSTRAINT "runtime_source_aliases_timestamp_order_check"
	CHECK (
		("expires_at" IS NULL OR "expires_at" >= "created_at")
		AND ("released_at" IS NULL OR "released_at" >= "created_at")
	);
--> statement-breakpoint
ALTER TABLE "runtime_source_aliases" ADD CONSTRAINT "runtime_source_aliases_read_only_check"
	CHECK ("read_only" = true);
--> statement-breakpoint
ALTER TABLE "runtime_source_aliases" ADD CONSTRAINT "runtime_source_aliases_org_conversation_fk"
	FOREIGN KEY ("org_id", "conversation_id") REFERENCES "public"."chat_conversations"("org_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "runtime_source_aliases" ADD CONSTRAINT "runtime_source_aliases_org_run_fk"
	FOREIGN KEY ("org_id", "run_id") REFERENCES "public"."heartbeat_runs"("org_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "runtime_source_aliases" ADD CONSTRAINT "runtime_source_aliases_org_binding_fk"
	FOREIGN KEY ("org_id", "binding_id") REFERENCES "public"."runtime_bindings"("org_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "runtime_source_aliases" ADD CONSTRAINT "runtime_source_aliases_org_segment_fk"
	FOREIGN KEY ("org_id", "segment_id") REFERENCES "public"."native_segments"("org_id", "id") ON DELETE no action ON UPDATE no action;
