WITH "ranked_ready_proposals" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "goal_id"
			ORDER BY "created_at" ASC, "id" ASC
		) AS "ready_rank"
	FROM "goal_result_proposals"
	WHERE "status" = 'ready'
)
UPDATE "goal_result_proposals"
SET
	"status" = 'superseded',
	"updated_at" = now()
FROM "ranked_ready_proposals"
WHERE "goal_result_proposals"."id" = "ranked_ready_proposals"."id"
	AND "ranked_ready_proposals"."ready_rank" > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "goal_result_proposals_goal_ready_uq" ON "goal_result_proposals" USING btree ("goal_id") WHERE "goal_result_proposals"."status" = 'ready';
