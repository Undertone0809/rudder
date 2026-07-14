ALTER TABLE "heartbeat_runs" ADD COLUMN "result_summary_json" jsonb;--> statement-breakpoint
CREATE FUNCTION "rudder_backfill_run_result_summary"("input" jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  "summary" jsonb;
  "line" text;
  "event" jsonb;
  "event_type" text;
  "candidate" text;
  "message" jsonb;
BEGIN
  IF "input" IS NULL OR jsonb_typeof("input") <> 'object' THEN
    RETURN NULL;
  END IF;

  "summary" := jsonb_strip_nulls(jsonb_build_object(
    'summary', CASE WHEN jsonb_typeof("input" -> 'summary') = 'string' THEN left("input" ->> 'summary', 500) END,
    'result', CASE
      WHEN jsonb_typeof("input" -> 'result') = 'string' THEN left("input" ->> 'result', 500)
      WHEN jsonb_typeof("input" -> 'body') = 'string' THEN left("input" ->> 'body', 500)
    END,
    'message', CASE WHEN jsonb_typeof("input" -> 'message') = 'string' THEN left("input" ->> 'message', 500) END,
    'error', CASE WHEN jsonb_typeof("input" -> 'error') = 'string' THEN left("input" ->> 'error', 500) END,
    'userMessage', CASE WHEN jsonb_typeof("input" -> 'userMessage') = 'string' THEN left("input" ->> 'userMessage', 500) END,
    'total_cost_usd', CASE
      WHEN jsonb_typeof("input" -> 'total_cost_usd') = 'number' THEN "input" -> 'total_cost_usd'
    END,
    'cost_usd', CASE
      WHEN jsonb_typeof("input" -> 'cost_usd') = 'number' THEN "input" -> 'cost_usd'
    END,
    'costUsd', CASE
      WHEN jsonb_typeof("input" -> 'costUsd') = 'number' THEN "input" -> 'costUsd'
    END
  ));

  IF "summary" ?| array['summary', 'result', 'message', 'userMessage']
    OR jsonb_typeof("input" -> 'stdout') <> 'string' THEN
    RETURN NULLIF("summary", '{}'::jsonb);
  END IF;

  FOR "line" IN SELECT regexp_split_to_table("input" ->> 'stdout', E'\\r?\\n') LOOP
    BEGIN
      "event" := "line"::jsonb;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;
    IF jsonb_typeof("event") <> 'object' THEN
      CONTINUE;
    END IF;

    "event_type" := "event" ->> 'type';
    "candidate" := NULL;
    IF "event_type" = 'result' THEN
      "candidate" := coalesce("event" ->> 'result', "event" ->> 'text', "event" ->> 'response');
    ELSIF "event_type" = 'item.completed' AND "event" #>> '{item,type}' = 'agent_message' THEN
      "candidate" := "event" #>> '{item,text}';
    ELSIF "event_type" IN ('assistant', 'turn_end') THEN
      "message" := "event" -> 'message';
      IF jsonb_typeof("message") = 'string' THEN
        "candidate" := "message" #>> '{}';
      ELSIF jsonb_typeof("message") = 'object' THEN
        "candidate" := coalesce("message" ->> 'text',
          CASE WHEN jsonb_typeof("message" -> 'content') = 'string' THEN "message" ->> 'content' END);
        IF "candidate" IS NULL AND jsonb_typeof("message" -> 'content') = 'array' THEN
          SELECT string_agg("piece", E'\n\n' ORDER BY "ordinality") INTO "candidate"
          FROM (
            SELECT "ordinality", CASE
              WHEN jsonb_typeof("part") = 'string' THEN "part" #>> '{}'
              WHEN jsonb_typeof("part") = 'object' THEN coalesce("part" ->> 'text', "part" ->> 'content')
            END AS "piece"
            FROM jsonb_array_elements("message" -> 'content') WITH ORDINALITY AS "parts"("part", "ordinality")
          ) AS "message_parts"
          WHERE "piece" IS NOT NULL AND btrim("piece") <> '';
        END IF;
      END IF;
    ELSIF "event_type" = 'agent_end' AND jsonb_typeof("event" -> 'messages') = 'array' THEN
      SELECT "assistant_message" INTO "message"
      FROM jsonb_array_elements("event" -> 'messages') WITH ORDINALITY AS "messages"("assistant_message", "ordinality")
      WHERE "assistant_message" ->> 'role' = 'assistant'
      ORDER BY "ordinality" DESC
      LIMIT 1;
      IF jsonb_typeof("message" -> 'content') = 'string' THEN
        "candidate" := "message" ->> 'content';
      ELSIF jsonb_typeof("message" -> 'content') = 'array' THEN
        SELECT string_agg("piece", E'\n\n' ORDER BY "ordinality") INTO "candidate"
        FROM (
          SELECT "ordinality", CASE
            WHEN jsonb_typeof("part") = 'string' THEN "part" #>> '{}'
            WHEN jsonb_typeof("part") = 'object' THEN coalesce("part" ->> 'text', "part" ->> 'content')
          END AS "piece"
          FROM jsonb_array_elements("message" -> 'content') WITH ORDINALITY AS "parts"("part", "ordinality")
        ) AS "message_parts"
        WHERE "piece" IS NOT NULL AND btrim("piece") <> '';
      END IF;
    END IF;

    IF "candidate" IS NOT NULL AND btrim("candidate") <> '' THEN
      "summary" := "summary" || jsonb_build_object('result', left(btrim("candidate"), 500));
    END IF;
  END LOOP;

  RETURN NULLIF("summary", '{}'::jsonb);
END;
$$;--> statement-breakpoint
UPDATE "heartbeat_runs"
SET "result_summary_json" = "rudder_backfill_run_result_summary"("result_json")
WHERE "result_json" IS NOT NULL;--> statement-breakpoint
DROP FUNCTION "rudder_backfill_run_result_summary"(jsonb);--> statement-breakpoint
CREATE INDEX "heartbeat_runs_org_created_id_idx" ON "heartbeat_runs" USING btree ("org_id","created_at","id");
