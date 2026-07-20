CREATE TABLE "messenger_saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_payload" jsonb NOT NULL,
	"resource_key" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"favicon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messenger_saved_views" ADD CONSTRAINT "messenger_saved_views_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_saved_views_org_user_resource_uq" ON "messenger_saved_views" USING btree ("org_id","user_id","resource_key");--> statement-breakpoint
CREATE INDEX "messenger_saved_views_org_user_order_idx" ON "messenger_saved_views" USING btree ("org_id","user_id","sort_order","created_at");--> statement-breakpoint
CREATE INDEX "messenger_saved_views_org_user_visible_order_idx" ON "messenger_saved_views" USING btree ("org_id","user_id","sort_order","created_at") WHERE "messenger_saved_views"."hidden_at" is null;