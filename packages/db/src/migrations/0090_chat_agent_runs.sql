ALTER TABLE "heartbeat_runs" ADD COLUMN "chat_conversation_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "run_id" uuid;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_chat_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("chat_conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_chat_conversation_status_updated_idx" ON "heartbeat_runs" USING btree ("org_id","chat_conversation_id","status","updated_at");
--> statement-breakpoint
CREATE INDEX "chat_messages_run_idx" ON "chat_messages" USING btree ("run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_active_chat_conversation_uq" ON "heartbeat_runs" USING btree ("org_id","chat_conversation_id") WHERE "chat_conversation_id" IS NOT NULL AND "status" IN ('queued','running');
--> statement-breakpoint
DO $$
DECLARE
  batch_size integer := 1000;
  processed integer := 0;
  total_processed integer := 0;
BEGIN
  LOOP
    WITH candidates AS (
      SELECT
        m.id AS message_id,
        gen_random_uuid() AS run_id,
        m.org_id,
        m.replying_agent_id AS agent_id,
        m.conversation_id AS chat_conversation_id,
        c.primary_issue_id,
        c.plan_mode,
        m.chat_turn_id,
        m.turn_variant,
        m.created_at,
        m.updated_at
      FROM "chat_messages" m
      INNER JOIN "chat_conversations" c ON c.id = m.conversation_id
      WHERE m.run_id IS NULL
        AND m.role = 'assistant'
        AND m.replying_agent_id IS NOT NULL
      ORDER BY m.created_at, m.id
      LIMIT batch_size
    ),
    inserted AS (
      INSERT INTO "heartbeat_runs" (
        "id",
        "org_id",
        "agent_id",
        "invocation_source",
        "trigger_detail",
        "status",
        "started_at",
        "finished_at",
        "chat_conversation_id",
        "context_snapshot",
        "result_json",
        "created_at",
        "updated_at"
      )
      SELECT
        run_id,
        org_id,
        agent_id,
        'chat',
        'chat_assistant_reply',
        'succeeded',
        created_at,
        updated_at,
        chat_conversation_id,
        jsonb_build_object(
          'scene', 'chat',
          'conversationId', chat_conversation_id,
          'assistantMessageId', message_id,
          'chatTurnId', chat_turn_id,
          'turnVariant', coalesce(turn_variant, 0),
          'issueId', primary_issue_id,
          'linkedIssueIds', CASE
            WHEN primary_issue_id IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(primary_issue_id)
          END,
          'projectId', NULL,
          'planMode', plan_mode,
          'stream', false,
          'controlIntent', 'backfill'
        ),
        jsonb_build_object(
          'outcome', 'completed',
          'backfilled', true,
          'assistantMessageId', message_id
        ),
        created_at,
        updated_at
      FROM candidates
      RETURNING id
    ),
    updated AS (
      UPDATE "chat_messages" m
      SET "run_id" = c.run_id
      FROM candidates c
      WHERE m.id = c.message_id
        AND m.run_id IS NULL
        AND EXISTS (SELECT 1 FROM inserted i WHERE i.id = c.run_id)
      RETURNING m.id
    )
    SELECT count(*) INTO processed FROM updated;

    total_processed := total_processed + processed;
    RAISE NOTICE '0090_chat_agent_runs backfilled % chat assistant message run links (% total)', processed, total_processed;
    EXIT WHEN processed < batch_size;
  END LOOP;
END $$;
