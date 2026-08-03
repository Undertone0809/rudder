ALTER TABLE "product_analytics_outbox" DROP CONSTRAINT "product_analytics_outbox_event_id_product_analytics_events_id_fk";
--> statement-breakpoint
ALTER TABLE "product_analytics_events" ALTER COLUMN "is_backfill" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ALTER COLUMN "is_backfill" SET DATA TYPE boolean USING "is_backfill"::boolean;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ALTER COLUMN "is_backfill" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "work_cycle_id" text;--> statement-breakpoint
ALTER TABLE "product_analytics_events" ADD COLUMN "installation_id" text;--> statement-breakpoint
ALTER TABLE "product_analytics_outbox" ADD CONSTRAINT "product_analytics_outbox_event_id_product_analytics_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."product_analytics_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_conversations_work_cycle_idx" ON "chat_conversations" USING btree ("org_id","work_cycle_id");
