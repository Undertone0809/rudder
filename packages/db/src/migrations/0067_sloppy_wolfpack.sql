ALTER TABLE "issues" ADD COLUMN "board_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH ranked_issues AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "org_id", "status"
			ORDER BY
				CASE "priority"
					WHEN 'critical' THEN 0
					WHEN 'high' THEN 1
					WHEN 'medium' THEN 2
					WHEN 'low' THEN 3
					ELSE 4
				END,
				"updated_at" DESC,
				"created_at" DESC,
				"id" ASC
		) AS "rank"
	FROM "issues"
	WHERE "hidden_at" IS NULL
)
UPDATE "issues"
SET "board_order" = ranked_issues."rank" * 1000
FROM ranked_issues
WHERE "issues"."id" = ranked_issues."id";--> statement-breakpoint
CREATE INDEX "issues_company_status_board_order_idx" ON "issues" USING btree ("org_id","status","board_order");
