CREATE TABLE "operator_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"nickname" text,
	"more_about_you" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operator_profiles_user_id_idx" ON "operator_profiles" USING btree ("user_id");
