DO $migration$
BEGIN
  IF to_regclass('auth.sessions') IS NULL THEN
    -- Embedded development has no managed Supabase Auth schema. Keep the
    -- verifier available but fail closed until a managed session exists.
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
    REVOKE ALL ON FUNCTION "rudder_identity"."is_active_auth_session"(uuid, uuid)
      FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION "rudder_identity"."is_active_auth_session"(uuid, uuid)
      FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rudder_identity_app') THEN
    GRANT EXECUTE
      ON FUNCTION "rudder_identity"."is_active_auth_session"(uuid, uuid)
      TO rudder_identity_app;
  END IF;
END
$$;
