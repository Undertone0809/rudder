-- Existing generations historically had independent organization and conversation FKs.
-- Refuse migration before DDL if any row has a cross-organization pairing.
DO $$
DECLARE
  mismatched_rows bigint;
BEGIN
  SELECT count(*) INTO mismatched_rows
  FROM chat_generations generation
  JOIN chat_conversations conversation ON conversation.id = generation.conversation_id
  WHERE generation.org_id <> conversation.org_id;

  IF mismatched_rows > 0 THEN
    RAISE EXCEPTION 'Native Chat migration refused: % existing chat_generations rows pair an organization with a conversation from another organization; reconcile these rows before retrying', mismatched_rows
      USING ERRCODE = '23514', CONSTRAINT = 'chat_generations_org_conversation_fk';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" DROP CONSTRAINT "heartbeat_runs_session_intent_shape_check";--> statement-breakpoint
DROP INDEX "chat_generations_active_conversation_uq";--> statement-breakpoint
DROP INDEX "heartbeat_runs_active_chat_conversation_uq";--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "execution_authority" text DEFAULT 'legacy_ts' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "source_message_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "source_turn_variant" integer;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD COLUMN "native_admission_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_run_attempts" ADD COLUMN "generation_attempt_epoch" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_run_attempts" ADD COLUMN "connection_epoch" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_run_attempts" ADD COLUMN "protocol_phase" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "chat_generation_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "execution_authority" text DEFAULT 'legacy_ts' NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "native_admission_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_generations_org_id_conversation_authority_hold_uq" ON "chat_generations" USING btree ("org_id","id","conversation_id","execution_authority","native_admission_hold");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_generations_native_source_identity_uq" ON "chat_generations" USING btree ("org_id","source_message_id","source_turn_variant") WHERE "chat_generations"."source_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_org_id_conversation_variant_uq" ON "chat_messages" USING btree ("org_id","id","conversation_id","turn_variant");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_native_generation_uq" ON "heartbeat_runs" USING btree ("org_id","chat_generation_id") WHERE "heartbeat_runs"."chat_generation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_generations_active_conversation_uq" ON "chat_generations" USING btree ("org_id","conversation_id") WHERE "chat_generations"."status" in ('starting', 'active', 'running', 'waiting_for_network', 'tool_busy', 'closing', 'stop_requested', 'stopping') or "chat_generations"."native_admission_hold" = true;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD CONSTRAINT "chat_generations_org_conversation_fk" FOREIGN KEY ("org_id","conversation_id") REFERENCES "public"."chat_conversations"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD CONSTRAINT "chat_generations_native_source_message_fk" FOREIGN KEY ("org_id","source_message_id","conversation_id","source_turn_variant") REFERENCES "public"."chat_messages"("org_id","id","conversation_id","turn_variant") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_native_generation_fk" FOREIGN KEY ("org_id","chat_generation_id","chat_conversation_id","execution_authority","native_admission_hold") REFERENCES "public"."chat_generations"("org_id","id","conversation_id","execution_authority","native_admission_hold") ON DELETE restrict ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_active_chat_conversation_uq" ON "heartbeat_runs" USING btree ("org_id","chat_conversation_id") WHERE "heartbeat_runs"."chat_conversation_id" is not null and ("heartbeat_runs"."status" in ('queued', 'running') or "heartbeat_runs"."terminal_effects_pending" = true or "heartbeat_runs"."native_admission_hold" = true);--> statement-breakpoint
ALTER TABLE "chat_generations" ADD CONSTRAINT "chat_generations_native_authority_shape_check" CHECK ((
        ("chat_generations"."execution_authority" = 'legacy_ts' and "chat_generations"."source_message_id" is null
          and "chat_generations"."source_turn_variant" is null and "chat_generations"."native_admission_hold" = false)
        or
        ("chat_generations"."execution_authority" = 'native_rust' and "chat_generations"."source_message_id" is not null
          and "chat_generations"."source_turn_variant" is not null and "chat_generations"."source_turn_variant" >= 0)
      ));--> statement-breakpoint
ALTER TABLE "chat_generations" ADD CONSTRAINT "chat_generations_execution_authority_check" CHECK ("chat_generations"."execution_authority" in ('legacy_ts', 'native_rust'));--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_turn_variant_check" CHECK ("chat_messages"."turn_variant" >= 0);--> statement-breakpoint
ALTER TABLE "heartbeat_run_attempts" ADD CONSTRAINT "heartbeat_run_attempts_native_chat_epoch_shape_check" CHECK (((
        ("heartbeat_run_attempts"."generation_attempt_epoch" is null and "heartbeat_run_attempts"."connection_epoch" is null)
        or
        ("heartbeat_run_attempts"."generation_attempt_epoch" > 0 and "heartbeat_run_attempts"."connection_epoch" > 0
          and "heartbeat_run_attempts"."attempt_epoch" > 0 and "heartbeat_run_attempts"."owner_token" is not null)
      ) is true));--> statement-breakpoint
ALTER TABLE "heartbeat_run_attempts" ADD CONSTRAINT "heartbeat_run_attempts_resume_source_check" CHECK ("heartbeat_run_attempts"."resume_source" in ('fresh', 'same_session', 'pristine_replay'));--> statement-breakpoint
ALTER TABLE "heartbeat_run_attempts" ADD CONSTRAINT "heartbeat_run_attempts_native_chat_protocol_phase_check" CHECK (((
        ("heartbeat_run_attempts"."protocol_phase" is null and "heartbeat_run_attempts"."generation_attempt_epoch" is null and "heartbeat_run_attempts"."connection_epoch" is null)
        or
        ("heartbeat_run_attempts"."protocol_phase" in ('no_thread_request', 'thread_start_indeterminate', 'thread_known', 'input_pre_submission', 'input_indeterminate', 'turn_known', 'provider_terminal_observed', 'execution_terminal_committed')
          and "heartbeat_run_attempts"."generation_attempt_epoch" > 0 and "heartbeat_run_attempts"."connection_epoch" > 0
          and jsonb_typeof("heartbeat_run_attempts"."checkpoint_json") = 'object'
          and "heartbeat_run_attempts"."checkpoint_json"->>'phase' = "heartbeat_run_attempts"."protocol_phase")
      ) is true));--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_native_authority_shape_check" CHECK ((
        ("heartbeat_runs"."execution_authority" = 'legacy_ts' and "heartbeat_runs"."chat_generation_id" is null
          and "heartbeat_runs"."native_admission_hold" = false)
        or
        ("heartbeat_runs"."execution_authority" = 'native_rust' and "heartbeat_runs"."chat_generation_id" is not null
          and "heartbeat_runs"."chat_conversation_id" is not null and "heartbeat_runs"."scene" = 'chat'
          and "heartbeat_runs"."target_type" = 'chat_conversation'
          and "heartbeat_runs"."target_id" = "heartbeat_runs"."chat_conversation_id"::text)
      ));--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_execution_authority_check" CHECK ("heartbeat_runs"."execution_authority" in ('legacy_ts', 'native_rust'));--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_session_intent_shape_check" CHECK ((
        "heartbeat_runs"."session_intent_json" is null
        or (
          jsonb_typeof("heartbeat_runs"."session_intent_json") = 'object'
          and "heartbeat_runs"."session_intent_json" ?& array['kind', 'reuseScope', 'sourceRunId', 'sessionId', 'sessionParams']
          and jsonb_typeof("heartbeat_runs"."session_intent_json"->'kind') = 'string'
          and jsonb_typeof("heartbeat_runs"."session_intent_json"->'reuseScope') = 'string'
          and "heartbeat_runs"."session_intent_json"->>'kind' in ('fresh', 'resume', 'fork')
          and (
            (
              "heartbeat_runs"."session_intent_json"->>'kind' = 'fresh'
              and "heartbeat_runs"."session_intent_json"->>'reuseScope' = 'none'
              and jsonb_typeof("heartbeat_runs"."session_intent_json"->'sourceRunId') = 'null'
              and jsonb_typeof("heartbeat_runs"."session_intent_json"->'sessionId') = 'null'
              and jsonb_typeof("heartbeat_runs"."session_intent_json"->'sessionParams') = 'null'
              and not ("heartbeat_runs"."session_intent_json" ? 'sourceBoundaryRef')
            )
            or
            (
              "heartbeat_runs"."session_intent_json"->>'kind' = 'resume'
              and "heartbeat_runs"."session_intent_json"->>'reuseScope' in ('explicit', 'task')
              and (
                jsonb_typeof("heartbeat_runs"."session_intent_json"->'sourceRunId') = 'null'
                or (jsonb_typeof("heartbeat_runs"."session_intent_json"->'sourceRunId') = 'string' and "heartbeat_runs"."session_intent_json"->>'sourceRunId' = btrim("heartbeat_runs"."session_intent_json"->>'sourceRunId') and btrim("heartbeat_runs"."session_intent_json"->>'sourceRunId') <> '')
              )
              and (
                jsonb_typeof("heartbeat_runs"."session_intent_json"->'sessionId') = 'null'
                or (jsonb_typeof("heartbeat_runs"."session_intent_json"->'sessionId') = 'string' and (
                  ("heartbeat_runs"."execution_authority" = 'native_rust' and btrim("heartbeat_runs"."session_intent_json"->>'sessionId') <> '' and octet_length("heartbeat_runs"."session_intent_json"->>'sessionId') <= 4096)
                  or ("heartbeat_runs"."execution_authority" = 'legacy_ts' and "heartbeat_runs"."session_intent_json"->>'sessionId' = btrim("heartbeat_runs"."session_intent_json"->>'sessionId') and btrim("heartbeat_runs"."session_intent_json"->>'sessionId') <> '')
                ))
              )
              and jsonb_typeof("heartbeat_runs"."session_intent_json"->'sessionParams') in ('null', 'object')
              and not ("heartbeat_runs"."session_intent_json" ? 'sourceBoundaryRef')
            )
            or
            (
              "heartbeat_runs"."session_intent_json"->>'kind' = 'fork'
              and "heartbeat_runs"."session_intent_json"->>'reuseScope' = 'explicit'
              and jsonb_typeof("heartbeat_runs"."session_intent_json"->'sourceRunId') = 'string'
              and "heartbeat_runs"."session_intent_json"->>'sourceRunId' = btrim("heartbeat_runs"."session_intent_json"->>'sourceRunId')
              and btrim("heartbeat_runs"."session_intent_json"->>'sourceRunId') <> ''
              and "heartbeat_runs"."session_intent_json" ? 'sourceBoundaryRef'
              and jsonb_typeof("heartbeat_runs"."session_intent_json"->'sourceBoundaryRef') = 'string'
              and "heartbeat_runs"."session_intent_json"->>'sourceBoundaryRef' = btrim("heartbeat_runs"."session_intent_json"->>'sourceBoundaryRef')
              and btrim("heartbeat_runs"."session_intent_json"->>'sourceBoundaryRef') <> ''
              and (
                jsonb_typeof("heartbeat_runs"."session_intent_json"->'sessionId') = 'null'
                or (jsonb_typeof("heartbeat_runs"."session_intent_json"->'sessionId') = 'string' and (
                  ("heartbeat_runs"."execution_authority" = 'native_rust' and btrim("heartbeat_runs"."session_intent_json"->>'sessionId') <> '' and octet_length("heartbeat_runs"."session_intent_json"->>'sessionId') <= 4096)
                  or ("heartbeat_runs"."execution_authority" = 'legacy_ts' and "heartbeat_runs"."session_intent_json"->>'sessionId' = btrim("heartbeat_runs"."session_intent_json"->>'sessionId') and btrim("heartbeat_runs"."session_intent_json"->>'sessionId') <> '')
                ))
              )
              and jsonb_typeof("heartbeat_runs"."session_intent_json"->'sessionParams') in ('null', 'object')
            )
          )
        )
      ));
-- Same-role accidental-writer guard. It is a transaction marker, not a
-- security boundary against SQL issued with the same database role.
CREATE OR REPLACE FUNCTION rudder_guard_native_chat_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  native_row boolean := false;
  marked boolean := COALESCE(current_setting('rudder.native_chat_write', true), '') LIKE 'native_chat:%';
BEGIN
  IF TG_TABLE_NAME = 'heartbeat_run_attempts' AND TG_OP <> 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM heartbeat_runs r WHERE r.org_id = NEW.org_id AND r.id = NEW.run_id AND r.execution_authority = 'native_rust')
       AND NEW.protocol_phase IS NULL THEN
      RAISE EXCEPTION 'Native Chat Attempts require a protocol phase'
        USING ERRCODE = '23514', CONSTRAINT = 'heartbeat_run_attempts_native_chat_protocol_phase_check';
    ELSIF NOT EXISTS (SELECT 1 FROM heartbeat_runs r WHERE r.org_id = NEW.org_id AND r.id = NEW.run_id AND r.execution_authority = 'native_rust')
       AND NEW.protocol_phase IS NOT NULL THEN
      RAISE EXCEPTION 'Legacy Attempts cannot carry a Native Chat protocol phase'
        USING ERRCODE = '23514', CONSTRAINT = 'heartbeat_run_attempts_native_chat_protocol_phase_check';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'chat_generations' THEN
    IF TG_OP <> 'INSERT' THEN
      native_row := native_row OR OLD.execution_authority = 'native_rust';
    END IF;
    IF TG_OP <> 'DELETE' THEN
      native_row := native_row OR NEW.execution_authority = 'native_rust';
    END IF;
  ELSIF TG_TABLE_NAME = 'heartbeat_runs' THEN
    IF TG_OP <> 'INSERT' THEN
      native_row := native_row OR OLD.execution_authority = 'native_rust' OR OLD.chat_generation_id IS NOT NULL;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      native_row := native_row OR NEW.execution_authority = 'native_rust' OR NEW.chat_generation_id IS NOT NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'heartbeat_run_attempts' THEN
    IF TG_OP <> 'INSERT' THEN
      native_row := native_row OR EXISTS (
        SELECT 1 FROM heartbeat_runs r WHERE r.id = OLD.run_id AND r.execution_authority = 'native_rust'
      );
    END IF;
    IF TG_OP <> 'DELETE' THEN
      native_row := native_row OR EXISTS (
        SELECT 1 FROM heartbeat_runs r WHERE r.id = NEW.run_id AND r.execution_authority = 'native_rust'
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'chat_messages' THEN
    IF TG_OP <> 'INSERT' THEN
      native_row := native_row OR EXISTS (
        SELECT 1 FROM chat_generations g WHERE g.execution_authority = 'native_rust'
          AND g.source_message_id = OLD.id
      ) OR EXISTS (
        SELECT 1 FROM heartbeat_runs r WHERE r.execution_authority = 'native_rust'
          AND r.chat_generation_id IS NOT NULL AND r.id = OLD.run_id
      );
    END IF;
    IF TG_OP <> 'DELETE' THEN
      native_row := native_row OR EXISTS (
        SELECT 1 FROM chat_generations g WHERE g.execution_authority = 'native_rust'
          AND g.source_message_id = NEW.id
      ) OR EXISTS (
        SELECT 1 FROM heartbeat_runs r WHERE r.execution_authority = 'native_rust'
          AND r.chat_generation_id IS NOT NULL AND r.id = NEW.run_id
      );
    END IF;
  END IF;

  IF native_row AND NOT marked THEN
    RAISE EXCEPTION 'Native Chat rows require a Rust transaction marker'
      USING ERRCODE = '42501', CONSTRAINT = 'native_chat_authority_write_required';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER chat_generations_native_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON chat_generations
  FOR EACH ROW EXECUTE FUNCTION rudder_guard_native_chat_mutation();
CREATE TRIGGER heartbeat_runs_native_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON heartbeat_runs
  FOR EACH ROW EXECUTE FUNCTION rudder_guard_native_chat_mutation();
CREATE TRIGGER heartbeat_run_attempts_native_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON heartbeat_run_attempts
  FOR EACH ROW EXECUTE FUNCTION rudder_guard_native_chat_mutation();
CREATE TRIGGER chat_messages_native_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION rudder_guard_native_chat_mutation();
