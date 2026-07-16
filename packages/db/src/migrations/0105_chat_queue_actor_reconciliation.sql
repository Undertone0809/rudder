UPDATE "chat_queued_messages" AS "queue"
SET
	"request_actor" = (
		SELECT CASE
			WHEN "activity"."actor_type" = 'agent' AND "activity"."agent_id" IS NOT NULL THEN
				jsonb_strip_nulls(jsonb_build_object(
					'type', 'agent',
					'source', 'agent_key',
					'orgId', "queue"."org_id"::text,
					'agentId', "activity"."agent_id"::text,
					'runId', "activity"."run_id"::text
				))
			WHEN "activity"."actor_type" = 'user' THEN
				jsonb_strip_nulls(jsonb_build_object(
					'type', 'board',
					'source', 'session',
					'userId', "activity"."actor_id",
					'orgIds', jsonb_build_array("queue"."org_id"::text),
					'isInstanceAdmin', false,
					'runId', "activity"."run_id"::text
				))
			ELSE NULL
		END
		FROM "activity_log" AS "activity"
		WHERE "activity"."org_id" = "queue"."org_id"
			AND "activity"."action" = 'chat.queue.created'
			AND "activity"."entity_type" = 'chat'
			AND "activity"."entity_id" = "queue"."conversation_id"::text
			AND "activity"."details"->>'queuedMessageId' = "queue"."id"::text
			AND (
				"activity"."actor_type" = 'user'
				OR ("activity"."actor_type" = 'agent' AND "activity"."agent_id" IS NOT NULL)
			)
		ORDER BY "activity"."created_at" DESC, "activity"."id" DESC
		LIMIT 1
	),
	"updated_at" = now()
WHERE ("queue"."request_actor" IS NULL OR "queue"."request_actor" = 'null'::jsonb)
	AND "queue"."status" IN ('queued', 'steer_pending', 'continuation_pending', 'dequeue_claimed');--> statement-breakpoint
UPDATE "chat_queued_messages"
SET
	"status" = 'queued',
	"delivery_intent" = 'queue',
	"delivery_disposition" = NULL,
	"control_action_id" = NULL,
	"delivery_lease_token" = NULL,
	"delivery_lease_owner" = NULL,
	"delivery_lease_expires_at" = NULL,
	"reconciliation_reason" = 'legacy_request_actor_unavailable',
	"last_delivery_reason" = 'legacy_request_actor_unavailable',
	"version" = "version" + 1,
	"updated_at" = now()
WHERE ("request_actor" IS NULL OR "request_actor" = 'null'::jsonb)
	AND "status" IN ('queued', 'steer_pending', 'continuation_pending', 'dequeue_claimed');
