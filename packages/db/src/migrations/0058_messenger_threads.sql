CREATE TABLE "issue_follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messenger_thread_user_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"thread_key" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_follows" ADD CONSTRAINT "issue_follows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_follows" ADD CONSTRAINT "issue_follows_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_thread_user_states" ADD CONSTRAINT "messenger_thread_user_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_follows_org_issue_idx" ON "issue_follows" USING btree ("org_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_follows_org_user_idx" ON "issue_follows" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_follows_org_issue_user_idx" ON "issue_follows" USING btree ("org_id","issue_id","user_id");--> statement-breakpoint
CREATE INDEX "messenger_thread_user_states_org_user_idx" ON "messenger_thread_user_states" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "messenger_thread_user_states_org_thread_idx" ON "messenger_thread_user_states" USING btree ("org_id","thread_key");--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_thread_user_states_org_thread_user_idx" ON "messenger_thread_user_states" USING btree ("org_id","thread_key","user_id");