DROP INDEX "heartbeat_runs_active_chat_conversation_uq";--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_active_chat_conversation_uq" ON "heartbeat_runs" USING btree ("org_id","chat_conversation_id") WHERE "heartbeat_runs"."chat_conversation_id" is not null and ("heartbeat_runs"."status" in ('queued', 'running') or "heartbeat_runs"."terminal_effects_pending" = true);
