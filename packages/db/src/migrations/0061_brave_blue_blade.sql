ALTER TABLE "chat_conversations" ADD COLUMN "plan_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" DROP COLUMN "operation_mode";