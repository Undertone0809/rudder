CREATE TABLE "agent_instruction_bundles" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entry_file" text NOT NULL,
	"files" jsonb NOT NULL,
	"clear_legacy_prompt_template" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"materialized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_instruction_bundles_state_ck" CHECK ("agent_instruction_bundles"."state" in ('pending', 'repair', 'materialized') and "agent_instruction_bundles"."attempts" >= 0),
	CONSTRAINT "agent_instruction_bundles_entry_ck" CHECK (octet_length("agent_instruction_bundles"."entry_file") between 1 and 512 and left("agent_instruction_bundles"."entry_file", 1) <> '/'),
	CONSTRAINT "agent_instruction_bundles_files_ck" CHECK (jsonb_typeof("agent_instruction_bundles"."files") = 'object')
);
--> statement-breakpoint
ALTER TABLE "agent_instruction_bundles" ADD CONSTRAINT "agent_instruction_bundles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_instruction_bundles" ADD CONSTRAINT "agent_instruction_bundles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_instruction_bundles_claim_idx" ON "agent_instruction_bundles" USING btree ("state","next_attempt_at","created_at");
