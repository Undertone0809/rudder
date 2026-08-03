ALTER TABLE "chat_conversations" ADD COLUMN IF NOT EXISTS "initial_client_mutation_id" text;
CREATE UNIQUE INDEX IF NOT EXISTS "chat_conversations_initial_owner_mutation_idx"
  ON "chat_conversations" USING btree ("org_id", "created_by_user_id", "initial_client_mutation_id")
  WHERE "initial_client_mutation_id" IS NOT NULL;
