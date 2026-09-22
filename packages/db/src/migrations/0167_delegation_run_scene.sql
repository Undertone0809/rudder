ALTER TABLE "heartbeat_runs" DROP CONSTRAINT "heartbeat_runs_scene_check";
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_scene_check"
	CHECK ("scene" IS NULL OR "scene" IN ('chat', 'side_chat', 'issue', 'review', 'automation', 'heartbeat', 'delegation'));
