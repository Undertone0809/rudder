ALTER TABLE "automation_runs" ADD COLUMN "linked_chat_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "started_chat_message_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "terminal_chat_message_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "last_chat_message_id" uuid;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "output_mode" text DEFAULT 'track_issue' NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "chat_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_linked_chat_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("linked_chat_conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_started_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("started_chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_terminal_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("terminal_chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_last_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("last_chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_chat_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("chat_conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_runs_linked_chat_conversation_idx" ON "automation_runs" USING btree ("linked_chat_conversation_id");