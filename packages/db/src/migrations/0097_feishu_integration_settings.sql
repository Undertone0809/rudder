ALTER TABLE "agent_integrations" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
