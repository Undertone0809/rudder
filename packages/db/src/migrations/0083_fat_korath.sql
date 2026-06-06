ALTER TABLE "automations" ADD COLUMN "notify_on_issue_created" boolean DEFAULT false NOT NULL;
ALTER TABLE "automations" ADD COLUMN "notify_on_issue_created_user_id" text;
UPDATE "automations"
SET "notify_on_issue_created_user_id" = COALESCE("updated_by_user_id", "created_by_user_id")
WHERE "notify_on_issue_created" = true;
