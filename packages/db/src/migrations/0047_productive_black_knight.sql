ALTER TABLE "companies" ADD COLUMN "default_chat_agent_runtime_type" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "default_chat_agent_runtime_config" jsonb;