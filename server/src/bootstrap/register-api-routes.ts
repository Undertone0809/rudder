import type { Db } from "@rudderhq/db";
import { Router } from "express";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { accessRoutes } from "../routes/access.js";
import { activityRoutes } from "../routes/activity.js";
import { agentRoutes } from "../routes/agents.js";
import { aiSearchRoutes } from "../routes/ai-search.js";
import { appBuilderRoutes } from "../routes/app-builder.js";
import { approvalRoutes } from "../routes/approvals.js";
import { assetRoutes } from "../routes/assets.js";
import { automationRoutes } from "../routes/automations.js";
import { browserRoutes } from "../routes/browser.js";
import { calendarRoutes } from "../routes/calendar.js";
import type { ChatBackgroundRuntime } from "../routes/chat-background-runtime.js";
import { chatRoutes } from "../routes/chats.js";
import { costRoutes } from "../routes/costs.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { runWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { goalRoutes } from "../routes/goals.js";
import { healthRoutes } from "../routes/health.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { integrationRoutes } from "../routes/integrations.js";
import { issueRoutes } from "../routes/issues.js";
import { localAccountAuthRoutes } from "../routes/local-account-auth.js";
import { managedMcpAgentBindingRoutes } from "../routes/managed-mcp-agent-bindings.js";
import { managedMcpConnectionRoutes } from "../routes/managed-mcp-connections.js";
import { messengerRoutes } from "../routes/messenger.js";
import { onboardingRoutes } from "../routes/onboarding.js";
import { organizationSkillRoutes } from "../routes/organization-skills.js";
import { organizationRoutes } from "../routes/orgs.js";
import { pluginRoutes } from "../routes/plugins.js";
import { productAnalyticsRoutes } from "../routes/product-analytics.js";
import { projectRoutes } from "../routes/projects.js";
import { runIntelligenceRoutes } from "../routes/run-intelligence.js";
import { secretRoutes } from "../routes/secrets.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { websiteMetadataRoutes } from "../routes/website-metadata.js";
import type { WorkspaceWebPreviewRuntime } from "../services/workspace-web-preview.js";
import type { PluginHostRuntime } from "./plugin-host-runtime.js";
import type { RudderAppOptions } from "./types.js";

export function registerApiRoutes(
  db: Db,
  opts: RudderAppOptions,
  pluginRuntime: PluginHostRuntime,
  workspacePreview?: WorkspaceWebPreviewRuntime,
  chatBackgroundRuntime?: ChatBackgroundRuntime,
) {
  const api = Router();

  api.use(boardMutationGuard());
  if (opts.localAccountExchangePolicy && opts.instanceId) {
    api.use(localAccountAuthRoutes(db, {
      installationId: opts.instanceId,
      exchangePolicy: opts.localAccountExchangePolicy,
      sessionRevocation: opts.localAccountSessionRevocation,
    }));
  }
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
      instanceId: opts.instanceId,
      localEnv: opts.localEnv,
      runtimeOwnerKind: opts.runtimeOwnerKind,
    }),
  );
  api.use("/orgs", organizationRoutes(db, opts.storageService, workspacePreview));
  api.use("/orgs", aiSearchRoutes(db));
  api.use(organizationSkillRoutes(db));
  api.use(agentRoutes(db, opts.storageService));
  api.use(managedMcpAgentBindingRoutes(db));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(appBuilderRoutes(db));
  api.use(onboardingRoutes(db));
  api.use(productAnalyticsRoutes(db));
  api.use(issueRoutes(db, opts.storageService));
  api.use(messengerRoutes(db));
  api.use(chatRoutes(db, opts.storageService, chatBackgroundRuntime));
  api.use(automationRoutes(db));
  api.use(calendarRoutes(db));
  api.use(runWorkspaceRoutes(db));
  api.use(integrationRoutes(db));
  api.use(managedMcpConnectionRoutes(db, {
    deploymentMode: opts.deploymentMode,
    serverPort: opts.serverPort,
    authPublicBaseUrl: opts.authPublicBaseUrl,
    allowlists: opts.mcpDeploymentAllowlists ?? {
      httpOrigins: [],
      stdioCommands: [],
      stdioWorkingDirectories: [],
      stdioEnvironmentNames: [],
    },
    hostEnv: opts.mcpHostEnv ?? process.env,
  }));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(runIntelligenceRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(websiteMetadataRoutes());
  api.use(instanceSettingsRoutes(db, { deploymentMode: opts.deploymentMode, instanceId: opts.instanceId }));
  api.use(browserRoutes(db, { deploymentMode: opts.deploymentMode }));
  api.use(
    pluginRoutes(
      db,
      pluginRuntime.loader,
      { scheduler: pluginRuntime.scheduler, jobStore: pluginRuntime.jobStore },
      { workerManager: pluginRuntime.workerManager },
      { toolDispatcher: pluginRuntime.toolDispatcher },
      { workerManager: pluginRuntime.workerManager },
    ),
  );
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );

  return api;
}
