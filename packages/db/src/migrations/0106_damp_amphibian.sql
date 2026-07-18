ALTER TABLE "chat_conversations" ADD COLUMN "conversation_kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "messenger_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "side_chat_state" text;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "side_chat_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "side_chat_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "side_chat_kept_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "side_chat_client_mutation_id" text;--> statement-breakpoint
CREATE INDEX "chat_conversations_org_messenger_visibility_idx" ON "chat_conversations" USING btree ("org_id","messenger_visible","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_side_chat_owner_mutation_idx" ON "chat_conversations" USING btree ("org_id","created_by_user_id","side_chat_client_mutation_id");