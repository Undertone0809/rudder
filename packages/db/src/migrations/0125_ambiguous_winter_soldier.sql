CREATE TABLE "external_user_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"local_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installation_account_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"local_user_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_exchange_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"jti" text NOT NULL,
	"audience" text NOT NULL,
	"subject" text NOT NULL,
	"local_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_user_bindings" ADD CONSTRAINT "external_user_bindings_local_user_id_user_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_account_bindings" ADD CONSTRAINT "installation_account_bindings_local_user_id_user_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_exchange_redemptions" ADD CONSTRAINT "server_exchange_redemptions_local_user_id_user_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_user_bindings_issuer_subject_uq" ON "external_user_bindings" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "external_user_bindings_local_user_idx" ON "external_user_bindings" USING btree ("local_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installation_account_bindings_installation_uq" ON "installation_account_bindings" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "installation_account_bindings_issuer_subject_idx" ON "installation_account_bindings" USING btree ("issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "server_exchange_redemptions_issuer_jti_uq" ON "server_exchange_redemptions" USING btree ("issuer","jti");--> statement-breakpoint
CREATE INDEX "server_exchange_redemptions_expiry_idx" ON "server_exchange_redemptions" USING btree ("expires_at");