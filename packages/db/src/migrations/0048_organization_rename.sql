ALTER TABLE "companies" RENAME TO "organizations";
--> statement-breakpoint
ALTER TABLE "company_logos" RENAME TO "organization_logos";
--> statement-breakpoint
ALTER TABLE "company_memberships" RENAME TO "organization_memberships";
--> statement-breakpoint
ALTER TABLE "company_secret_versions" RENAME TO "organization_secret_versions";
--> statement-breakpoint
ALTER TABLE "company_secrets" RENAME TO "organization_secrets";
--> statement-breakpoint
ALTER TABLE "company_skills" RENAME TO "organization_skills";
--> statement-breakpoint
ALTER TABLE "plugin_company_settings" RENAME TO "plugin_organization_settings";
--> statement-breakpoint

ALTER TABLE "activity_log" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "agent_api_keys" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "agent_config_revisions" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "agent_runtime_state" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "agents" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "approval_comments" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "approvals" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "assets" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "budget_incidents" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "budget_policies" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "chat_attachments" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "chat_context_links" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "chat_conversations" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "chat_messages" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "cost_events" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "document_revisions" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "documents" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "execution_workspaces" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "finance_events" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "goals" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "invites" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "issue_approvals" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "issue_attachments" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "issue_comments" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "issue_documents" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "issue_labels" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "issue_read_states" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "issue_work_products" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "issues" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "join_requests" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "labels" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "organization_logos" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "organization_memberships" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "organization_secrets" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "organization_skills" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "plugin_organization_settings" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "principal_permission_grants" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "project_goals" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "project_workspaces" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "routines" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "routine_triggers" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "routine_runs" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "workspace_operations" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" RENAME COLUMN "company_id" TO "org_id";
--> statement-breakpoint

ALTER INDEX "companies_issue_prefix_idx" RENAME TO "organizations_issue_prefix_idx";
--> statement-breakpoint
ALTER INDEX "chat_conversations_company_updated_idx" RENAME TO "chat_conversations_org_updated_idx";
--> statement-breakpoint
ALTER INDEX "chat_conversations_company_status_updated_idx" RENAME TO "chat_conversations_org_status_updated_idx";
--> statement-breakpoint
ALTER INDEX "chat_messages_company_conversation_created_idx" RENAME TO "chat_messages_org_conversation_created_idx";
--> statement-breakpoint
ALTER INDEX "company_logos_company_uq" RENAME TO "organization_logos_org_uq";
--> statement-breakpoint
ALTER INDEX "company_logos_asset_uq" RENAME TO "organization_logos_asset_uq";
--> statement-breakpoint
ALTER INDEX "company_memberships_company_principal_unique_idx" RENAME TO "organization_memberships_org_principal_unique_idx";
--> statement-breakpoint
ALTER INDEX "company_memberships_principal_status_idx" RENAME TO "organization_memberships_principal_status_idx";
--> statement-breakpoint
ALTER INDEX "company_memberships_company_status_idx" RENAME TO "organization_memberships_org_status_idx";
--> statement-breakpoint
ALTER INDEX "company_secret_versions_secret_idx" RENAME TO "organization_secret_versions_secret_idx";
--> statement-breakpoint
ALTER INDEX "company_secret_versions_value_sha256_idx" RENAME TO "organization_secret_versions_value_sha256_idx";
--> statement-breakpoint
ALTER INDEX "company_secret_versions_secret_version_uq" RENAME TO "organization_secret_versions_secret_version_uq";
--> statement-breakpoint
ALTER INDEX "company_secrets_company_idx" RENAME TO "organization_secrets_org_idx";
--> statement-breakpoint
ALTER INDEX "company_secrets_company_provider_idx" RENAME TO "organization_secrets_org_provider_idx";
--> statement-breakpoint
ALTER INDEX "company_secrets_company_name_uq" RENAME TO "organization_secrets_org_name_uq";
--> statement-breakpoint
ALTER INDEX "company_skills_company_key_idx" RENAME TO "organization_skills_org_key_idx";
--> statement-breakpoint
ALTER INDEX "company_skills_company_name_idx" RENAME TO "organization_skills_org_name_idx";
--> statement-breakpoint
ALTER INDEX "plugin_company_settings_company_idx" RENAME TO "plugin_organization_settings_org_idx";
--> statement-breakpoint
ALTER INDEX "plugin_company_settings_plugin_idx" RENAME TO "plugin_organization_settings_plugin_idx";
--> statement-breakpoint
ALTER INDEX "plugin_company_settings_company_plugin_uq" RENAME TO "plugin_organization_settings_org_plugin_uq";
