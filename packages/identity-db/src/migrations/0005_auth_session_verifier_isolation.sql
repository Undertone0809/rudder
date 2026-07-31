DO $migration$
BEGIN
  IF to_regclass('auth.sessions') IS NULL THEN
    -- Keep the runtime contract fail-closed in embedded or misconfigured
    -- environments that do not expose the managed Supabase Auth schema.
    EXECUTE $function$
      CREATE OR REPLACE FUNCTION "rudder_identity"."is_active_auth_session"(
        "candidate_session_id" uuid,
        "candidate_user_id" uuid
      )
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = ''
      AS $body$
        SELECT false
      $body$
    $function$;
  ELSE
    EXECUTE $function$
      CREATE OR REPLACE FUNCTION "rudder_identity"."is_active_auth_session"(
        "candidate_session_id" uuid,
        "candidate_user_id" uuid
      )
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = ''
      AS $body$
        SELECT EXISTS (
          SELECT 1
          FROM auth.sessions
          WHERE id = "candidate_session_id"
            AND user_id = "candidate_user_id"
            AND (not_after IS NULL OR not_after > now())
        )
      $body$
    $function$;
  END IF;
END
$migration$;

REVOKE ALL ON FUNCTION "rudder_identity"."is_active_auth_session"(uuid, uuid)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL
      ON FUNCTION "rudder_identity"."is_active_auth_session"(uuid, uuid)
      FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL
      ON FUNCTION "rudder_identity"."is_active_auth_session"(uuid, uuid)
      FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rudder_identity_app') THEN
    -- Migration 0002 temporarily granted a narrow direct read. The runtime
    -- must cross only this boolean SECURITY DEFINER boundary after cutover.
    IF to_regclass('auth.sessions') IS NOT NULL THEN
      REVOKE SELECT (id, user_id, not_after)
        ON auth.sessions
        FROM rudder_identity_app;
      REVOKE USAGE ON SCHEMA auth FROM rudder_identity_app;
    END IF;
    GRANT EXECUTE
      ON FUNCTION "rudder_identity"."is_active_auth_session"(uuid, uuid)
      TO rudder_identity_app;
  END IF;
END
$$;
