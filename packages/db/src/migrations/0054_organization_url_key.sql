-- Add url_key column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'url_key'
  ) THEN
    ALTER TABLE "organizations" ADD COLUMN "url_key" text;
  END IF;
END $$;
--> statement-breakpoint
-- Populate url_key for rows where it's NULL or empty
WITH normalized AS (
  SELECT
    id,
    COALESCE(
      NULLIF(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''),
      'organization'
    ) AS base,
    row_number() OVER (
      PARTITION BY COALESCE(
        NULLIF(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''),
        'organization'
      )
      ORDER BY created_at, id
    ) AS ordinal
  FROM organizations
  WHERE url_key IS NULL OR url_key = ''
)
UPDATE organizations AS organizations
SET url_key = CASE
  WHEN normalized.ordinal = 1 THEN normalized.base
  ELSE normalized.base || '-' || normalized.ordinal
END
FROM normalized
WHERE organizations.id = normalized.id;
--> statement-breakpoint
-- Ensure url_key is not null (only if column exists and has data)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'url_key'
  ) THEN
    ALTER TABLE "organizations" ALTER COLUMN "url_key" SET NOT NULL;
  END IF;
END $$;
--> statement-breakpoint
-- Create unique index if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'organizations_url_key_idx'
  ) THEN
    CREATE UNIQUE INDEX "organizations_url_key_idx" ON "organizations" USING btree ("url_key");
  END IF;
END $$;
