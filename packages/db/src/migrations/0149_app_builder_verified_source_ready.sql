ALTER TABLE "app_builder_apps" DROP CONSTRAINT "app_builder_apps_build_status_check";
--> statement-breakpoint
ALTER TABLE "app_builder_apps" ADD CONSTRAINT "app_builder_apps_build_status_check" CHECK ("app_builder_apps"."build_status" in ('preparing', 'building', 'verified_source_ready', 'verifying', 'ready', 'launch_failed', 'failed'));
