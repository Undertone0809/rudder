ALTER TABLE "messenger_saved_views" ADD COLUMN "instance_id" text;--> statement-breakpoint
ALTER TABLE "messenger_saved_views" ADD COLUMN "canonical_resource_key" text;--> statement-breakpoint
ALTER TABLE "messenger_saved_views" ADD COLUMN "client_mutation_id" uuid;--> statement-breakpoint
UPDATE "messenger_saved_views"
SET
  "instance_id" = "id"::text,
  "canonical_resource_key" = "resource_key",
  "target_payload" = "target_payload" || jsonb_build_object('viewInstanceId', "id"::text),
  "hidden_at" = NULL;--> statement-breakpoint
ALTER TABLE "messenger_saved_views" ALTER COLUMN "instance_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messenger_saved_views" ALTER COLUMN "canonical_resource_key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_saved_views_org_user_instance_uq" ON "messenger_saved_views" USING btree ("org_id","user_id","instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_saved_views_org_user_client_mutation_uq" ON "messenger_saved_views" USING btree ("org_id","user_id","client_mutation_id") WHERE "messenger_saved_views"."client_mutation_id" is not null;--> statement-breakpoint
WITH "ungrouped_saved_views" AS (
  SELECT
    "saved_view"."id",
    "saved_view"."org_id",
    "saved_view"."user_id",
    row_number() OVER (
      PARTITION BY "saved_view"."org_id", "saved_view"."user_id"
      ORDER BY "saved_view"."sort_order", "saved_view"."created_at", "saved_view"."id"
    ) - 1 AS "recovered_sort_order"
  FROM "messenger_saved_views" "saved_view"
  WHERE NOT EXISTS (
    SELECT 1
    FROM "messenger_custom_group_entries" "entry"
    WHERE "entry"."org_id" = "saved_view"."org_id"
      AND "entry"."user_id" = "saved_view"."user_id"
      AND "entry"."thread_key" = 'saved-view:' || "saved_view"."id"::text
  )
),
"recovery_owners" AS (
  SELECT DISTINCT "org_id", "user_id"
  FROM "ungrouped_saved_views"
),
"created_groups" AS (
  INSERT INTO "messenger_custom_groups" (
    "org_id",
    "user_id",
    "name",
    "sort_order",
    "created_at",
    "updated_at"
  )
  SELECT
    "owner"."org_id",
    "owner"."user_id",
    'Recovered items',
    COALESCE((
      SELECT max("existing_group"."sort_order") + 1
      FROM "messenger_custom_groups" "existing_group"
      WHERE "existing_group"."org_id" = "owner"."org_id"
        AND "existing_group"."user_id" = "owner"."user_id"
    ), 0),
    now(),
    now()
  FROM "recovery_owners" "owner"
  RETURNING "id", "org_id", "user_id"
)
INSERT INTO "messenger_custom_group_entries" (
  "org_id",
  "user_id",
  "group_id",
  "thread_key",
  "sort_order",
  "created_at",
  "updated_at"
)
SELECT
  "saved_view"."org_id",
  "saved_view"."user_id",
  "group"."id",
  'saved-view:' || "saved_view"."id"::text,
  "saved_view"."recovered_sort_order"::integer,
  now(),
  now()
FROM "ungrouped_saved_views" "saved_view"
INNER JOIN "created_groups" "group"
  ON "group"."org_id" = "saved_view"."org_id"
  AND "group"."user_id" = "saved_view"."user_id";
