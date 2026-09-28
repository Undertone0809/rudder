ALTER TABLE "side_chat_first_inputs"
	ADD COLUMN "generation_id" uuid;
--> statement-breakpoint
ALTER TABLE "side_chat_first_inputs"
	ADD CONSTRAINT "side_chat_first_inputs_generation_id_chat_generations_id_fk"
	FOREIGN KEY ("generation_id") REFERENCES "chat_generations"("id");
--> statement-breakpoint
CREATE UNIQUE INDEX "side_chat_first_inputs_generation_uq"
	ON "side_chat_first_inputs" USING btree ("generation_id")
	WHERE "generation_id" IS NOT NULL;
--> statement-breakpoint
WITH first_generations AS (
	SELECT DISTINCT ON ("org_id", "conversation_id")
		"org_id", "conversation_id", "id"
	FROM "chat_generations"
	ORDER BY "org_id", "conversation_id", "created_at", "id"
)
UPDATE "side_chat_first_inputs" AS first_input
SET "generation_id" = generation."id",
	"updated_at" = NOW()
FROM first_generations AS generation
WHERE first_input."org_id" = generation."org_id"
	AND first_input."conversation_id" = generation."conversation_id"
	AND first_input."status" = 'accepted';
