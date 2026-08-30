ALTER TABLE "chat_messages" ADD COLUMN "client_mutation_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_conversation_mutation_uq"
  ON "chat_messages" USING btree ("conversation_id", "client_mutation_id")
  WHERE "client_mutation_id" IS NOT NULL;
