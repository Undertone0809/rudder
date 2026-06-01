CREATE TABLE "chat_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"terminal_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_queued_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"client_mutation_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expected_generation_id" uuid,
	"active_generation_id" uuid,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_delivery_reason" text,
	"source_message_id" uuid,
	"delivered_message_id" uuid,
	"cancelled_at" timestamp with time zone,
	"steered_at" timestamp with time zone,
	"dequeued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_generations" ADD CONSTRAINT "chat_generations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_generations" ADD CONSTRAINT "chat_generations_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_expected_generation_id_chat_generations_id_fk" FOREIGN KEY ("expected_generation_id") REFERENCES "public"."chat_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_active_generation_id_chat_generations_id_fk" FOREIGN KEY ("active_generation_id") REFERENCES "public"."chat_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_source_message_id_chat_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_queued_messages" ADD CONSTRAINT "chat_queued_messages_delivered_message_id_chat_messages_id_fk" FOREIGN KEY ("delivered_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_generations_conversation_status_idx" ON "chat_generations" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "chat_generations_org_conversation_started_idx" ON "chat_generations" USING btree ("org_id","conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "chat_queued_messages_conversation_status_position_idx" ON "chat_queued_messages" USING btree ("conversation_id","status","position");--> statement-breakpoint
CREATE INDEX "chat_queued_messages_org_conversation_idx" ON "chat_queued_messages" USING btree ("org_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_queued_messages_conversation_position_uq" ON "chat_queued_messages" USING btree ("conversation_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_queued_messages_conversation_mutation_uq" ON "chat_queued_messages" USING btree ("conversation_id","client_mutation_id");