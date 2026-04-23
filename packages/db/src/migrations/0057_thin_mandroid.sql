CREATE TABLE "chat_conversation_user_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pinned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_conversation_user_states" ADD CONSTRAINT "chat_conversation_user_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversation_user_states" ADD CONSTRAINT "chat_conversation_user_states_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_conversation_user_states_org_conversation_idx" ON "chat_conversation_user_states" USING btree ("org_id","conversation_id");--> statement-breakpoint
CREATE INDEX "chat_conversation_user_states_org_user_idx" ON "chat_conversation_user_states" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversation_user_states_org_conversation_user_idx" ON "chat_conversation_user_states" USING btree ("org_id","conversation_id","user_id");