ALTER TABLE "entity_tombstones" ADD COLUMN IF NOT EXISTS "title" text;
--> statement-breakpoint
UPDATE "entity_tombstones"
SET "title" = CASE
	WHEN "entity_type" = 'issue' THEN 'Deleted issue'
	WHEN "entity_type" = 'chat' THEN 'Deleted chat'
	ELSE 'Deleted entity'
END
WHERE "title" IS NULL;
--> statement-breakpoint
ALTER TABLE "entity_tombstones" ALTER COLUMN "title" SET NOT NULL;
