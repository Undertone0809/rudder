CREATE TABLE "chat_message_transcript_entries" (
  "org_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "entry_seq" integer NOT NULL,
  "payload" jsonb NOT NULL,
  CONSTRAINT "chat_message_transcript_entries_message_seq_pk" PRIMARY KEY("message_id","entry_seq")
);
--> statement-breakpoint
ALTER TABLE "chat_message_transcript_entries" ADD CONSTRAINT "chat_message_transcript_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_message_transcript_entries" ADD CONSTRAINT "chat_message_transcript_entries_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chat_message_transcript_entries_org_message_seq_idx" ON "chat_message_transcript_entries" USING btree ("org_id","message_id","entry_seq");
--> statement-breakpoint
ALTER TABLE "chat_messages" SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 500,
  autovacuum_analyze_threshold = 500,
  autovacuum_analyze_scale_factor = 0.02
);
