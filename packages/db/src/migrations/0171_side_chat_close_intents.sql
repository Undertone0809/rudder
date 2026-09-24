CREATE TABLE "side_chat_close_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"source_conversation_id" uuid,
	"source_message_id" uuid,
	"state" text DEFAULT 'requested' NOT NULL,
	"stop_generation_id" uuid,
	"stop_control_action_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"attachments_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attachment_cursor" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"lease_owner" text,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "side_chat_close_intents_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
	CONSTRAINT "side_chat_close_state_check"
		CHECK ("state" IN ('requested', 'claimed', 'retry_wait', 'review_required')),
	CONSTRAINT "side_chat_close_lease_check"
		CHECK (("state" = 'claimed' AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
			OR ("state" <> 'claimed' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL)),
	CONSTRAINT "side_chat_close_cursor_check"
		CHECK ("attachment_cursor" >= 0 AND "lease_epoch" >= 0 AND "attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "side_chat_close_conversation_uq"
	ON "side_chat_close_intents" USING btree ("org_id", "conversation_id");
--> statement-breakpoint
CREATE INDEX "side_chat_close_claim_idx"
	ON "side_chat_close_intents" USING btree ("state", "next_attempt_at", "lease_expires_at");
