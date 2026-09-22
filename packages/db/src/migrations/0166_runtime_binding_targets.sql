ALTER TABLE "runtime_bindings" ALTER COLUMN "conversation_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "runtime_bindings" ADD COLUMN "target_type" text;
--> statement-breakpoint
ALTER TABLE "runtime_bindings" ADD COLUMN "target_id" text;
--> statement-breakpoint
UPDATE "runtime_bindings"
SET "target_type" = 'chat_conversation', "target_id" = "conversation_id"::text
WHERE "conversation_id" IS NOT NULL AND "target_type" IS NULL;
--> statement-breakpoint
ALTER TABLE "runtime_bindings" ADD CONSTRAINT "runtime_bindings_target_type_check"
	CHECK ("target_type" IS NULL OR "target_type" IN ('issue', 'chat_conversation', 'chat_message', 'automation_run', 'wakeup_request', 'manual', 'review'));
--> statement-breakpoint
ALTER TABLE "runtime_bindings" ADD CONSTRAINT "runtime_bindings_target_shape_check"
	CHECK (
		("target_type" IS NULL AND "target_id" IS NULL AND "conversation_id" IS NOT NULL)
		OR
		("target_type" IS NOT NULL AND "target_type" = 'chat_conversation'
			AND "target_id" IS NOT NULL AND btrim("target_id") <> ''
			AND "conversation_id" IS NOT NULL AND "target_id" = "conversation_id"::text)
		OR
		("target_type" IS NOT NULL AND "target_type" IN ('issue', 'chat_message', 'automation_run', 'wakeup_request', 'manual', 'review')
			AND "target_id" IS NOT NULL AND btrim("target_id") <> ''
			AND "conversation_id" IS NULL)
	);
--> statement-breakpoint
DROP INDEX "runtime_bindings_org_conversation_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_bindings_org_conversation_uq" ON "runtime_bindings" USING btree ("org_id", "conversation_id")
	WHERE "status" = 'active' AND "conversation_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_bindings_org_target_uq" ON "runtime_bindings" USING btree ("org_id", "target_type", "target_id")
	WHERE "status" = 'active' AND "target_type" IS NOT NULL AND "target_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_bindings_org_target_epoch_uq" ON "runtime_bindings" USING btree ("org_id", "target_type", "target_id", "binding_epoch")
	WHERE "target_type" IS NOT NULL AND "target_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "runtime_bindings_org_target_idx" ON "runtime_bindings" USING btree ("org_id", "target_type", "target_id", "status");
