CREATE TABLE "chat_control_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"expected_generation_id" uuid,
	"expected_attempt_epoch" integer,
	"expected_control_version" integer,
	"applied_control_version" integer,
	"action_kind" text NOT NULL,
	"local_disposition" text DEFAULT 'pending' NOT NULL,
	"provider_disposition" text,
	"control_owner_token" text,
	"provider_client_message_id" text,
	"provider_thread_id" text,
	"provider_turn_id" text,
	"provider_evidence" jsonb,
	"requested_render_seq" integer,
	"requested_body_hash" text,
	"accepted_through_seq" integer,
	"frozen_body_hash" text,
	"last_error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_sent_at" timestamp with time zone,
	"provider_acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_generation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"generation_seq" integer NOT NULL,
	"attempt_epoch" integer NOT NULL,
	"event_kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_offset" integer,
	"body_length" integer,
	"assistant_message_id" uuid,
	"run_id" uuid,
	"control_action_id" uuid,
	"queue_item_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_generation_terminal_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"projection_version" integer NOT NULL,
	"projector_version" integer DEFAULT 1 NOT NULL,
	"expected_control_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"claim_token" text,
	"claim_epoch" integer DEFAULT 0 NOT NULL,
	"claim_owner" text,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"replay_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"projected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "attempt_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "control_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "control_state" text DEFAULT 'unregistered' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "control_runtime_type" text;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "control_owner_token" text;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "control_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "provider_thread_id" text;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "provider_turn_id" text;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "accepted_through_seq" integer;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "last_client_checkpoint_seq" integer;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "last_client_checkpoint_hash" text;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "frozen_body_hash" text;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "stop_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "runtime_terminal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "late_events_dropped" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "late_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "request_actor" jsonb;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "delivery_intent" text DEFAULT 'queue' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "delivery_disposition" text;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "control_action_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "attempt_epoch" integer;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "provider_client_message_id" text;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "provider_thread_id" text;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "provider_turn_id" text;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "provider_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "continuation_generation_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "continuation_message_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "delivery_lease_token" text;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "delivery_lease_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "delivery_lease_owner" text;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "delivery_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "reconciliation_reason" text;--> statement-breakpoint
ALTER TABLE "chat_control_actions" ADD CONSTRAINT "chat_control_actions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_control_actions" ADD CONSTRAINT "chat_control_actions_expected_generation_id_chat_generations_id_fk" FOREIGN KEY ("expected_generation_id") REFERENCES "public"."chat_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_generation_events" ADD CONSTRAINT "chat_generation_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_generation_events" ADD CONSTRAINT "chat_generation_events_generation_id_chat_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."chat_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_generation_events" ADD CONSTRAINT "chat_generation_events_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_generation_events" ADD CONSTRAINT "chat_generation_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_generation_events" ADD CONSTRAINT "chat_generation_events_control_action_id_chat_control_actions_id_fk" FOREIGN KEY ("control_action_id") REFERENCES "public"."chat_control_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_generation_events" ADD CONSTRAINT "chat_generation_events_queue_item_id_chat_queued_messages_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."chat_queued_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_generation_terminal_outbox" ADD CONSTRAINT "chat_generation_terminal_outbox_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_generation_terminal_outbox" ADD CONSTRAINT "chat_generation_terminal_outbox_generation_id_chat_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."chat_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_generation_terminal_outbox" ADD CONSTRAINT "chat_generation_terminal_outbox_source_event_id_chat_generation_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."chat_generation_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_control_actions_org_action_uq" ON "chat_control_actions" USING btree ("org_id","id");--> statement-breakpoint
CREATE INDEX "chat_control_actions_generation_requested_idx" ON "chat_control_actions" USING btree ("expected_generation_id","requested_at");--> statement-breakpoint
CREATE INDEX "chat_control_actions_org_disposition_idx" ON "chat_control_actions" USING btree ("org_id","local_disposition","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_generation_events_generation_seq_uq" ON "chat_generation_events" USING btree ("generation_id","generation_seq");--> statement-breakpoint
CREATE INDEX "chat_generation_events_org_generation_seq_idx" ON "chat_generation_events" USING btree ("org_id","generation_id","generation_seq");--> statement-breakpoint
CREATE INDEX "chat_generation_events_assistant_message_idx" ON "chat_generation_events" USING btree ("assistant_message_id");--> statement-breakpoint
CREATE INDEX "chat_generation_events_run_idx" ON "chat_generation_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "chat_generation_events_control_action_idx" ON "chat_generation_events" USING btree ("control_action_id");--> statement-breakpoint
CREATE INDEX "chat_generation_events_queue_item_idx" ON "chat_generation_events" USING btree ("queue_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_generation_terminal_outbox_generation_projection_uq" ON "chat_generation_terminal_outbox" USING btree ("generation_id","projection_version");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_generation_terminal_outbox_source_event_uq" ON "chat_generation_terminal_outbox" USING btree ("source_event_id");--> statement-breakpoint
CREATE INDEX "chat_generation_terminal_outbox_claim_idx" ON "chat_generation_terminal_outbox" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "chat_generation_terminal_outbox_org_generation_idx" ON "chat_generation_terminal_outbox" USING btree ("org_id","generation_id");--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_control_action_id_chat_control_actions_id_fk" FOREIGN KEY ("control_action_id") REFERENCES "public"."chat_control_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_continuation_generation_id_chat_generations_id_fk" FOREIGN KEY ("continuation_generation_id") REFERENCES "public"."chat_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_continuation_message_id_chat_messages_id_fk" FOREIGN KEY ("continuation_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "chat_generations" AS "generation"
SET
	"status" = 'aborted',
	"terminal_reason" = coalesce("generation"."terminal_reason", 'ownerless_during_durable_control_migration'),
	"control_state" = 'terminal',
	"runtime_terminal_at" = coalesce("generation"."runtime_terminal_at", now()),
	"completed_at" = coalesce("generation"."completed_at", now()),
	"updated_at" = now()
WHERE "generation"."status" IN ('starting', 'active', 'running', 'tool_busy', 'closing', 'stop_requested', 'stopping')
	AND "generation"."control_owner_token" IS NULL;--> statement-breakpoint
UPDATE "chat_queued_messages"
SET
	"status" = 'continuation_pending',
	"delivery_intent" = 'steer',
	"delivery_disposition" = 'continuation_pending',
	"reconciliation_reason" = 'legacy_steer_recovered_on_upgrade',
	"last_delivery_reason" = NULL,
	"updated_at" = now()
WHERE "status" = 'steer_pending';--> statement-breakpoint
UPDATE "chat_queued_messages"
SET
	"status" = 'queued',
	"delivery_lease_token" = NULL,
	"delivery_lease_owner" = NULL,
	"delivery_lease_expires_at" = NULL,
	"reconciliation_reason" = 'legacy_claim_released_on_upgrade',
	"last_delivery_reason" = 'legacy_claim_released_on_upgrade',
	"updated_at" = now()
WHERE "status" = 'dequeue_claimed';--> statement-breakpoint
UPDATE "chat_queued_messages"
SET
	"status" = 'failed_actionable',
	"delivery_disposition" = 'failed_actionable',
	"reconciliation_reason" = 'legacy_running_delivery_unconfirmed_on_upgrade',
	"last_delivery_reason" = 'legacy_running_delivery_unconfirmed_on_upgrade',
	"updated_at" = now()
WHERE "status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "chat_generations_active_conversation_uq" ON "chat_generations" USING btree ("org_id","conversation_id") WHERE "chat_generations"."status" in ('starting', 'active', 'running', 'tool_busy', 'closing', 'stop_requested', 'stopping');--> statement-breakpoint
CREATE INDEX "chat_generations_control_lease_idx" ON "chat_generations" USING btree ("control_state","control_lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_queued_messages_control_action_uq" ON "chat_queued_messages" USING btree ("control_action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_queued_messages_continuation_generation_uq" ON "chat_queued_messages" USING btree ("continuation_generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_queued_messages_continuation_message_uq" ON "chat_queued_messages" USING btree ("continuation_message_id");--> statement-breakpoint
CREATE INDEX "chat_queued_messages_delivery_claim_idx" ON "chat_queued_messages" USING btree ("org_id","status","delivery_lease_expires_at");--> statement-breakpoint
CREATE INDEX "chat_queued_messages_intent_position_idx" ON "chat_queued_messages" USING btree ("org_id","conversation_id","delivery_intent","status","position");
