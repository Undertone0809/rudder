ALTER TABLE "agents" DROP CONSTRAINT "agents_reports_to_agents_id_fk";
--> statement-breakpoint
DROP INDEX "agents_company_reports_to_idx";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "reports_to";