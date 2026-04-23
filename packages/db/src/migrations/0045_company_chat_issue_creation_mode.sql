ALTER TABLE "companies"
ADD COLUMN IF NOT EXISTS "default_chat_issue_creation_mode" text DEFAULT 'manual_approval' NOT NULL;
