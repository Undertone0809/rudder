CREATE TABLE "side_chat_first_inputs" (
	"org_id" uuid NOT NULL,
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text,
	"creation_mutation_id" text NOT NULL,
	"source_conversation_id" uuid,
	"source_message_id" uuid,
	"preferred_agent_id" uuid,
	"status" text DEFAULT 'awaiting' NOT NULL,
	"request_client_mutation_id" text,
	"request_fingerprint" text,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"user_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "side_chat_first_inputs_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
	CONSTRAINT "side_chat_first_inputs_conversation_id_chat_conversations_id_fk"
		FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE,
	CONSTRAINT "side_chat_first_inputs_preferred_agent_id_agents_id_fk"
		FOREIGN KEY ("preferred_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL,
	CONSTRAINT "side_chat_first_inputs_status_check"
		CHECK ("status" IN ('awaiting', 'pending', 'accepted')),
	CONSTRAINT "side_chat_first_inputs_claim_check"
		CHECK (("status" = 'pending' AND "claim_token" IS NOT NULL
			AND "claim_expires_at" IS NOT NULL AND "request_fingerprint" IS NOT NULL)
			OR ("status" <> 'pending' AND "claim_token" IS NULL
			AND "claim_expires_at" IS NULL)),
	CONSTRAINT "side_chat_first_inputs_accepted_message_check"
		CHECK ("status" <> 'accepted' OR "user_message_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "side_chat_first_inputs_org_status_idx"
	ON "side_chat_first_inputs" USING btree ("org_id", "status");
--> statement-breakpoint
CREATE INDEX "side_chat_first_inputs_user_message_idx"
	ON "side_chat_first_inputs" USING btree ("user_message_id");
--> statement-breakpoint
INSERT INTO "side_chat_first_inputs" (
	"org_id", "conversation_id", "owner_user_id", "creation_mutation_id",
	"source_conversation_id", "source_message_id", "preferred_agent_id", "status",
	"request_client_mutation_id", "request_fingerprint", "user_message_id", "created_at", "updated_at"
)
SELECT
	conversation."org_id",
	conversation."id",
	conversation."created_by_user_id",
	COALESCE(conversation."side_chat_client_mutation_id", 'legacy:' || conversation."id"::text),
	conversation."forked_from_conversation_id",
	conversation."forked_from_message_id",
	conversation."preferred_agent_id",
	CASE WHEN first_input."id" IS NULL THEN 'awaiting' ELSE 'accepted' END,
	first_input."client_mutation_id",
	first_input."client_mutation_fingerprint",
	first_input."id",
	conversation."created_at",
	NOW()
FROM "chat_conversations" AS conversation
LEFT JOIN LATERAL (
	SELECT message."id", message."client_mutation_id", message."client_mutation_fingerprint"
	FROM "chat_messages" AS message
	WHERE message."org_id" = conversation."org_id"
		AND message."conversation_id" = conversation."id"
		AND message."role" = 'user'
		AND message."kind" = 'message'
		AND NOT COALESCE(message."structured_payload" ? 'sideChatSource', FALSE)
	ORDER BY message."created_at", message."id"
	LIMIT 1
) AS first_input ON TRUE
WHERE conversation."conversation_kind" = 'side_chat';
