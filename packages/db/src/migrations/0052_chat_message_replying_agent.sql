ALTER TABLE "chat_messages" ADD COLUMN "replying_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL;
