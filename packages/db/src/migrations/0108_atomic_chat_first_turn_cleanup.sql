CREATE TEMP TABLE "_rudder_empty_chat_recovery" ON COMMIT DROP AS
SELECT
	conversation."id",
	conversation."org_id",
	EXISTS (SELECT 1 FROM "automation_runs" run WHERE run."linked_chat_conversation_id" = conversation."id")
		OR EXISTS (SELECT 1 FROM "automations" automation WHERE automation."chat_conversation_id" = conversation."id") AS "automation_bound",
	EXISTS (SELECT 1 FROM "agent_integration_chat_bindings" binding WHERE binding."conversation_id" = conversation."id") AS "integration_bound",
	EXISTS (SELECT 1 FROM "heartbeat_runs" run WHERE run."chat_conversation_id" = conversation."id")
		OR EXISTS (SELECT 1 FROM "agent_integration_outbound_messages" outbound WHERE outbound."conversation_id" = conversation."id")
		OR EXISTS (SELECT 1 FROM "chat_generations" generation WHERE generation."conversation_id" = conversation."id")
		OR EXISTS (SELECT 1 FROM "chat_queued_messages" queued WHERE queued."conversation_id" = conversation."id")
		OR EXISTS (SELECT 1 FROM "chat_work_manifest_items" manifest WHERE manifest."conversation_id" = conversation."id")
		OR conversation."primary_issue_id" IS NOT NULL
		OR EXISTS (
			SELECT 1 FROM "chat_conversations" fork
			WHERE fork."forked_from_conversation_id" = conversation."id"
				OR fork."fork_root_conversation_id" = conversation."id"
		) AS "other_business_bound"
FROM "chat_conversations" conversation
WHERE NOT EXISTS (SELECT 1 FROM "chat_messages" message WHERE message."conversation_id" = conversation."id");
--> statement-breakpoint
DELETE FROM "chat_conversations" conversation
USING "_rudder_empty_chat_recovery" recovery
WHERE conversation."id" = recovery."id"
	AND NOT recovery."automation_bound"
	AND NOT recovery."integration_bound"
	AND NOT recovery."other_business_bound";
--> statement-breakpoint
DELETE FROM "agent_integration_chat_bindings" binding
USING "_rudder_empty_chat_recovery" recovery
WHERE binding."conversation_id" = recovery."id" AND recovery."integration_bound";
--> statement-breakpoint
INSERT INTO "chat_messages" ("org_id", "conversation_id", "role", "kind", "status", "body", "structured_payload")
SELECT
	recovery."org_id",
	recovery."id",
	'system',
	'system_event',
	'completed',
	'This legacy empty chat was recovered and archived during the atomic first-turn migration.',
	jsonb_build_object(
		'eventType', 'legacy_empty_chat_recovered',
		'migration', '0108_atomic_chat_first_turn_cleanup',
		'reason', 'legacy_empty_conversation',
		'automationBound', recovery."automation_bound",
		'integrationBound', recovery."integration_bound",
		'otherBusinessBound', recovery."other_business_bound"
	)
FROM "_rudder_empty_chat_recovery" recovery
WHERE recovery."automation_bound" OR recovery."integration_bound" OR recovery."other_business_bound";
--> statement-breakpoint
UPDATE "chat_conversations" conversation
SET
	"status" = 'archived',
	"messenger_visible" = false,
	"last_message_at" = recovered_message."created_at",
	"updated_at" = recovered_message."created_at"
FROM (
	SELECT DISTINCT ON (message."conversation_id") message."conversation_id", message."created_at"
	FROM "chat_messages" message
	INNER JOIN "_rudder_empty_chat_recovery" recovery ON recovery."id" = message."conversation_id"
	ORDER BY message."conversation_id", message."created_at" DESC, message."id" DESC
) recovered_message
WHERE conversation."id" = recovered_message."conversation_id";
--> statement-breakpoint
UPDATE "chat_conversations" conversation
SET "last_message_at" = latest_message."created_at"
FROM (
	SELECT DISTINCT ON (message."conversation_id") message."conversation_id", message."created_at"
	FROM "chat_messages" message
	ORDER BY message."conversation_id", message."created_at" DESC, message."id" DESC
) latest_message
WHERE conversation."id" = latest_message."conversation_id"
	AND conversation."last_message_at" IS DISTINCT FROM latest_message."created_at";
