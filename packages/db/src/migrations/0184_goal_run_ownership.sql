ALTER TABLE "heartbeat_runs" DROP CONSTRAINT "heartbeat_runs_native_authority_shape_check";--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "execution_authority" text DEFAULT 'legacy_ts' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD CONSTRAINT "agent_wakeup_requests_execution_authority_check" CHECK ("agent_wakeup_requests"."execution_authority" in ('legacy_ts', 'native_rust'));--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_native_authority_shape_check" CHECK ((
        ("heartbeat_runs"."execution_authority" = 'legacy_ts' and "heartbeat_runs"."chat_generation_id" is null
          and "heartbeat_runs"."native_admission_hold" = false)
        or
        ("heartbeat_runs"."execution_authority" = 'native_rust' and "heartbeat_runs"."chat_generation_id" is not null
          and "heartbeat_runs"."chat_conversation_id" is not null and "heartbeat_runs"."scene" = 'chat'
          and "heartbeat_runs"."target_type" = 'chat_conversation'
          and "heartbeat_runs"."target_id" = "heartbeat_runs"."chat_conversation_id"::text)
        or
        ("heartbeat_runs"."execution_authority" = 'native_rust' and "heartbeat_runs"."chat_generation_id" is null
          and "heartbeat_runs"."chat_conversation_id" is null and "heartbeat_runs"."native_admission_hold" = false
          and "heartbeat_runs"."scene" = 'heartbeat' and "heartbeat_runs"."target_type" = 'wakeup_request'
          and "heartbeat_runs"."wakeup_request_id" is not null
          and "heartbeat_runs"."target_id" = "heartbeat_runs"."wakeup_request_id"::text
          and "heartbeat_runs"."goal_id" is not null)
      ));
--> statement-breakpoint
-- Native Chat attempts require their protocol phase. Native Goal wakeup Runs
-- share the durable Run/Attempt tables, but have no Chat Generation or Chat
-- protocol phase; retain Rust-write fencing for both authorities.
CREATE OR REPLACE FUNCTION rudder_guard_native_chat_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  native_row boolean := false;
  marked boolean := COALESCE(current_setting('rudder.native_chat_write', true), '') LIKE 'native_chat:%';
BEGIN
  IF TG_TABLE_NAME = 'heartbeat_run_attempts' AND TG_OP <> 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM heartbeat_runs r
      WHERE r.org_id = NEW.org_id AND r.id = NEW.run_id
        AND r.execution_authority = 'native_rust' AND r.chat_generation_id IS NOT NULL
    ) AND NEW.protocol_phase IS NULL THEN
      RAISE EXCEPTION 'Native Chat Attempts require a protocol phase'
        USING ERRCODE = '23514', CONSTRAINT = 'heartbeat_run_attempts_native_chat_protocol_phase_check';
    ELSIF NOT EXISTS (
      SELECT 1 FROM heartbeat_runs r
      WHERE r.org_id = NEW.org_id AND r.id = NEW.run_id
        AND r.execution_authority = 'native_rust' AND r.chat_generation_id IS NOT NULL
    ) AND NEW.protocol_phase IS NOT NULL THEN
      RAISE EXCEPTION 'Legacy and non-Chat native Attempts cannot carry a Native Chat protocol phase'
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
