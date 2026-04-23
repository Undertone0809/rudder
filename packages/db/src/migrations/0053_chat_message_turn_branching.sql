ALTER TABLE "chat_messages" ADD COLUMN "chat_turn_id" uuid;
ALTER TABLE "chat_messages" ADD COLUMN "turn_variant" integer DEFAULT 0 NOT NULL;
ALTER TABLE "chat_messages" ADD COLUMN "superseded_at" timestamp with time zone;
