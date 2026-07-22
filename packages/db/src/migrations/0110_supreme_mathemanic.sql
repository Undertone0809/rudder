CREATE TABLE "messenger_saved_view_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"client_mutation_id" uuid NOT NULL,
	"saved_view_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messenger_saved_view_mutations" ADD CONSTRAINT "messenger_saved_view_mutations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_saved_view_mutations_org_user_mutation_uq" ON "messenger_saved_view_mutations" USING btree ("org_id","user_id","client_mutation_id");--> statement-breakpoint
CREATE INDEX "messenger_saved_view_mutations_saved_view_idx" ON "messenger_saved_view_mutations" USING btree ("org_id","user_id","saved_view_id");