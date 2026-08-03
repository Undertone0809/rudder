CREATE TABLE IF NOT EXISTS "product_analytics_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "event_name" text NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source_transition" text NOT NULL,
  "confidence" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "entity_type" text,
  "entity_id" text,
  "dedupe_key" text NOT NULL,
  "properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "product_analytics_events_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_analytics_events_org_occurred_idx"
  ON "product_analytics_events" USING btree ("org_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_analytics_events_org_event_occurred_idx"
  ON "product_analytics_events" USING btree ("org_id", "event_name", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_analytics_events_org_actor_occurred_idx"
  ON "product_analytics_events" USING btree ("org_id", "actor_type", "actor_id", "occurred_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_analytics_events_org_dedupe_key_uq"
  ON "product_analytics_events" USING btree ("org_id", "dedupe_key");
