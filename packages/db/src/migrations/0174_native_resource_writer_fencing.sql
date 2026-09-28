ALTER TABLE "run_runtime_spans"
  ADD COLUMN "writer_binding_ref" text,
  ADD COLUMN "writer_resource_ref" text,
  ADD COLUMN "writer_lease_released_at" timestamp with time zone;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rudder_native_writer_binding_ref(p_org_id uuid, p_binding_id uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT md5(jsonb_build_array('binding-v1', binding.org_id::text, binding.id::text)::text)
  FROM runtime_bindings AS binding
  WHERE binding.org_id = p_org_id AND binding.id = p_binding_id
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rudder_native_writer_resource_ref(
  p_org_id uuid,
  p_binding_id uuid,
  p_segment_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN segment.native_session_id IS NULL THEN NULL
    ELSE md5(jsonb_build_array(
      'native-resource-v1',
      binding.runtime_type,
      binding.host_id,
      binding.profile_id,
      COALESCE(binding.workspace_binding_id, ''),
      segment.native_session_id
    )::text)
  END
  FROM runtime_bindings AS binding
  JOIN native_segments AS segment
    ON segment.org_id = p_org_id
    AND segment.binding_id = p_binding_id
    AND segment.id = p_segment_id
  WHERE binding.org_id = p_org_id AND binding.id = p_binding_id
$$;
--> statement-breakpoint

-- Legacy sealing records transcript closure, not proof that the provider stopped writing.
-- Keep historical spans fenced until runtime recovery verifies writer quiescence.
--> statement-breakpoint

WITH active_refs AS (
  SELECT
    span.id,
    rudder_native_writer_binding_ref(span.org_id, span.binding_id) AS binding_ref,
    rudder_native_writer_resource_ref(span.org_id, span.binding_id, span.segment_id) AS resource_ref
  FROM run_runtime_spans AS span
  WHERE span.writer_lease_released_at IS NULL
), duplicate_binding_refs AS (
  SELECT binding_ref FROM active_refs GROUP BY binding_ref HAVING COUNT(*) > 1
), duplicate_resource_refs AS (
  SELECT resource_ref
  FROM active_refs
  WHERE resource_ref IS NOT NULL
  GROUP BY resource_ref
  HAVING COUNT(*) > 1
)
UPDATE run_runtime_spans AS span
SET
  writer_binding_ref = CASE
    WHEN active.binding_ref IN (SELECT binding_ref FROM duplicate_binding_refs) THEN NULL
    ELSE active.binding_ref
  END,
  writer_resource_ref = CASE
    WHEN active.resource_ref IN (SELECT resource_ref FROM duplicate_resource_refs) THEN NULL
    ELSE active.resource_ref
  END
FROM active_refs AS active
WHERE span.id = active.id;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rudder_guard_native_resource_writer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  binding_ref text;
  resource_ref text;
  lock_ref text;
BEGIN
  binding_ref := rudder_native_writer_binding_ref(NEW.org_id, NEW.binding_id);
  resource_ref := rudder_native_writer_resource_ref(NEW.org_id, NEW.binding_id, NEW.segment_id);

  IF binding_ref IS NULL THEN
    RAISE EXCEPTION 'native writer binding identity is not durable'
      USING ERRCODE = '23503', CONSTRAINT = 'run_runtime_spans_active_native_writer_uq';
  END IF;

  NEW.writer_binding_ref := binding_ref;
  NEW.writer_resource_ref := resource_ref;

  IF TG_OP = 'UPDATE'
    AND OLD.writer_lease_released_at IS NULL
    AND NEW.writer_lease_released_at IS NOT NULL
    AND (NEW.closed_at IS NULL OR NEW.state NOT IN ('sealed', 'unresolved')) THEN
    RAISE EXCEPTION 'native writer lease release must close its Run span'
      USING ERRCODE = '23514', CONSTRAINT = 'run_runtime_spans_writer_release_check';
  END IF;

  IF NEW.writer_lease_released_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  FOR lock_ref IN
    SELECT DISTINCT candidate.ref
    FROM unnest(ARRAY[binding_ref, resource_ref]) AS candidate(ref)
    WHERE candidate.ref IS NOT NULL
    ORDER BY candidate.ref
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(lock_ref, 0));
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM run_runtime_spans AS active
    WHERE active.writer_lease_released_at IS NULL
      AND (TG_OP = 'INSERT' OR active.id <> NEW.id)
      AND (
        COALESCE(
          active.writer_binding_ref,
          rudder_native_writer_binding_ref(active.org_id, active.binding_id)
        ) = binding_ref
        OR (
          resource_ref IS NOT NULL
          AND COALESCE(
            active.writer_resource_ref,
            rudder_native_writer_resource_ref(active.org_id, active.binding_id, active.segment_id)
          ) = resource_ref
        )
      )
  ) THEN
    RAISE EXCEPTION 'native resource already has an active Run writer'
      USING ERRCODE = '23505', CONSTRAINT = 'run_runtime_spans_active_native_writer_uq';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER run_runtime_spans_native_writer_guard
BEFORE INSERT OR UPDATE OF
  org_id,
  binding_id,
  segment_id,
  state,
  closed_at,
  writer_binding_ref,
  writer_resource_ref,
  writer_lease_released_at
ON run_runtime_spans
FOR EACH ROW
EXECUTE FUNCTION rudder_guard_native_resource_writer();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rudder_prevent_active_native_writer_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.writer_lease_released_at IS NULL THEN
    RAISE EXCEPTION 'cannot delete a Run span while its native writer lease is active'
      USING ERRCODE = '23514', CONSTRAINT = 'run_runtime_spans_active_writer_delete_check';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER run_runtime_spans_active_writer_delete_guard
BEFORE DELETE ON run_runtime_spans
FOR EACH ROW
EXECUTE FUNCTION rudder_prevent_active_native_writer_delete();
--> statement-breakpoint

CREATE UNIQUE INDEX "run_runtime_spans_active_writer_binding_uq"
  ON "run_runtime_spans" USING btree ("writer_binding_ref")
  WHERE "writer_lease_released_at" IS NULL AND "writer_binding_ref" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX "run_runtime_spans_active_writer_resource_uq"
  ON "run_runtime_spans" USING btree ("writer_resource_ref")
  WHERE "writer_lease_released_at" IS NULL AND "writer_resource_ref" IS NOT NULL;
