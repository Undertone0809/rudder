CREATE OR REPLACE FUNCTION "rudder_identity"."is_active_auth_session"(
  "candidate_session_id" uuid,
  "candidate_user_id" uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.sessions
    WHERE id = "candidate_session_id"
      AND user_id = "candidate_user_id"
      AND (not_after IS NULL OR not_after > now())
  )
$$;

REVOKE ALL ON FUNCTION "rudder_identity"."is_active_auth_session"(uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION "rudder_identity"."is_active_auth_session"(uuid, uuid)
  FROM anon;
REVOKE ALL ON FUNCTION "rudder_identity"."is_active_auth_session"(uuid, uuid)
  FROM authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rudder_identity_app') THEN
    GRANT EXECUTE
      ON FUNCTION "rudder_identity"."is_active_auth_session"(uuid, uuid)
      TO rudder_identity_app;
  END IF;
END
$$;
