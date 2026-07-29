ALTER TABLE "mcp_connections" DROP CONSTRAINT "mcp_connections_owner_agent_id_agents_id_fk";
--> statement-breakpoint
DROP INDEX "mcp_connections_org_provider_scope_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_id_uq" ON "agents" USING btree ("org_id","id");--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_owner_agent_org_fk" FOREIGN KEY ("org_id","owner_agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;
