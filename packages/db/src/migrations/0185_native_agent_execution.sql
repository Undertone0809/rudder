ALTER TABLE "heartbeat_runs" DROP CONSTRAINT "heartbeat_runs_native_authority_shape_check";--> statement-breakpoint
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
          and "heartbeat_runs"."target_id" = "heartbeat_runs"."wakeup_request_id"::text)
      ));
--> statement-breakpoint
-- Native Chat provider locators stay private. Generic Agent heartbeats retain
-- the existing public task-session resume columns; their owner is still fenced
-- by the native execution transaction marker.
CREATE OR REPLACE FUNCTION rudder_guard_native_chat_public_session_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_authority='native_rust'
     AND NEW.chat_generation_id IS NOT NULL
     AND (NEW.session_id_before IS NOT NULL OR NEW.session_id_after IS NOT NULL) THEN
    RAISE EXCEPTION 'Native Chat provider locators require private Attempt or Segment storage'
      USING ERRCODE='23514', CONSTRAINT='native_chat_private_session_locator_required';
  END IF;
  RETURN NEW;
END;
$$;
