-- Provider locators belong to private Attempts/Segments. Legacy Run readers
-- publish the session columns, so never mirror native Chat locators there.
-- Refuse cleanup if an old mirror has no private authoritative copy.
DO $$
DECLARE previous_marker text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM heartbeat_runs r
    CROSS JOIN LATERAL (VALUES (r.session_id_before),(r.session_id_after)) mirror(locator)
    WHERE r.execution_authority='native_rust' AND mirror.locator IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM heartbeat_run_attempts a
        WHERE a.org_id=r.org_id AND a.run_id=r.id AND a.provider_thread_id=mirror.locator)
  ) THEN
    RAISE EXCEPTION 'Native Chat session mirror has no private Attempt locator; reconcile before migration'
      USING ERRCODE='23514';
  END IF;
  previous_marker := COALESCE(current_setting('rudder.native_chat_write',true),'');
  PERFORM set_config('rudder.native_chat_write','native_chat:migrate_private_locators',true);
  UPDATE heartbeat_runs SET session_id_before=NULL,session_id_after=NULL
    WHERE execution_authority='native_rust'
      AND (session_id_before IS NOT NULL OR session_id_after IS NOT NULL);
  PERFORM set_config('rudder.native_chat_write',previous_marker,true);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION rudder_guard_native_chat_public_session_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_authority='native_rust'
     AND (NEW.session_id_before IS NOT NULL OR NEW.session_id_after IS NOT NULL) THEN
    RAISE EXCEPTION 'Native Chat provider locators require private Attempt or Segment storage'
      USING ERRCODE='23514', CONSTRAINT='native_chat_private_session_locator_required';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER heartbeat_runs_native_private_session_guard BEFORE INSERT OR UPDATE ON heartbeat_runs
  FOR EACH ROW EXECUTE FUNCTION rudder_guard_native_chat_public_session_columns();
--> statement-breakpoint
-- Keep legacy event/cost writers from projecting a second outcome for a Rust
-- execution. This is an accidental-writer guard, not a same-role SQL boundary.
CREATE FUNCTION rudder_guard_native_chat_effect_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_json jsonb;
  run_ref text;
  generation_ref text;
BEGIN
  IF COALESCE(current_setting('rudder.native_chat_write', true), '') LIKE 'native_chat:%' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  FOR row_json IN SELECT value FROM jsonb_array_elements(
    CASE WHEN TG_OP = 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
         WHEN TG_OP = 'DELETE' THEN jsonb_build_array(to_jsonb(OLD))
         ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END
  ) LOOP
    run_ref := COALESCE(row_json->>'run_id',row_json->>'heartbeat_run_id');
    generation_ref := row_json->>'generation_id';
    IF EXISTS (SELECT 1 FROM heartbeat_runs WHERE id=run_ref::uuid AND execution_authority='native_rust')
       OR EXISTS (SELECT 1 FROM chat_generations WHERE id=generation_ref::uuid AND execution_authority='native_rust') THEN
      RAISE EXCEPTION 'Native Chat effects require a Rust transaction marker'
        USING ERRCODE='42501', CONSTRAINT='native_chat_effect_authority_write_required';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chat_generation_events_native_write_guard BEFORE INSERT OR UPDATE OR DELETE ON chat_generation_events
  FOR EACH ROW EXECUTE FUNCTION rudder_guard_native_chat_effect_mutation();
CREATE TRIGGER heartbeat_run_events_native_write_guard BEFORE INSERT OR UPDATE OR DELETE ON heartbeat_run_events
  FOR EACH ROW EXECUTE FUNCTION rudder_guard_native_chat_effect_mutation();
CREATE TRIGGER cost_events_native_write_guard BEFORE INSERT OR UPDATE OR DELETE ON cost_events
  FOR EACH ROW EXECUTE FUNCTION rudder_guard_native_chat_effect_mutation();
--> statement-breakpoint
-- A stable lock also covers absence of a matching policy. All writers,
-- including compatibility clients, serialize with native unknown-cost gates.
CREATE FUNCTION rudder_serialize_native_chat_budget_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE organization_ref text;
BEGIN
  FOR organization_ref IN
    SELECT DISTINCT value FROM jsonb_array_elements_text(
      CASE WHEN TG_OP = 'INSERT' THEN jsonb_build_array(NEW.org_id::text)
           WHEN TG_OP = 'DELETE' THEN jsonb_build_array(OLD.org_id::text)
           ELSE jsonb_build_array(OLD.org_id::text,NEW.org_id::text) END
    ) ORDER BY value
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('rudder:native-chat:budget:' || organization_ref,0));
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER budget_policies_native_chat_serialization BEFORE INSERT OR UPDATE OR DELETE ON budget_policies
  FOR EACH ROW EXECUTE FUNCTION rudder_serialize_native_chat_budget_policy();
