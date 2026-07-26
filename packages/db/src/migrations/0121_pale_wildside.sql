ALTER TABLE "chat_conversations" ADD COLUMN "model_override" text;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "effort_override" text;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD COLUMN "runtime_snapshot_version" integer;