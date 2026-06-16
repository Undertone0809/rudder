CREATE TABLE "messenger_custom_group_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"group_id" uuid NOT NULL,
	"thread_key" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messenger_custom_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"collapsed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messenger_custom_groups_org_user_id_unique" UNIQUE("org_id","user_id","id")
);
--> statement-breakpoint
ALTER TABLE "messenger_custom_group_entries" ADD CONSTRAINT "messenger_custom_group_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_custom_group_entries" ADD CONSTRAINT "messenger_custom_group_entries_owner_group_fk" FOREIGN KEY ("org_id","user_id","group_id") REFERENCES "public"."messenger_custom_groups"("org_id","user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_custom_groups" ADD CONSTRAINT "messenger_custom_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messenger_custom_group_entries_org_user_group_idx" ON "messenger_custom_group_entries" USING btree ("org_id","user_id","group_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_custom_group_entries_org_user_thread_idx" ON "messenger_custom_group_entries" USING btree ("org_id","user_id","thread_key");--> statement-breakpoint
CREATE INDEX "messenger_custom_groups_org_user_idx" ON "messenger_custom_groups" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "messenger_custom_groups_org_user_order_idx" ON "messenger_custom_groups" USING btree ("org_id","user_id","sort_order");