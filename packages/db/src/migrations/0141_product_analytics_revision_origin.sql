ALTER TABLE "rudder_analytics"."product_analytics_collector_work_loop_revisions"
  ADD COLUMN "origin" text NOT NULL DEFAULT 'human';
