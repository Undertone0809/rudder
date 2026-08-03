ALTER TABLE "rudder_analytics"."product_analytics_collector_work_loop_revisions"
  ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'human';
