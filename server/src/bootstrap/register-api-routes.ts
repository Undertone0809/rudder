import { Router } from "express";
import type { Db } from "@rudderhq/db";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { accessRoutes } from "../routes/access.js";
import { activityRoutes } from "../routes/activity.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { assetRoutes } from "../routes/assets.js";
import { automationRoutes } from "../routes/automations.js";
import { chatRoutes } from "../routes/chats.js";
import { costRoutes } from "../routes/costs.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { goalRoutes } from "../routes/goals.js";
import { healthRoutes } from "../routes/health.js";
import { issueRoutes } from "../routes/issues.js";
import { messengerRoutes } from "../routes/messenger.js";
import { organizationSkillRoutes } from "../routes/organization-skills.js";
import { organizationRoutes } from "../routes/orgs.js";
import { pluginRoutes } from "../routes/plugins.js";
import { projectRoutes } from "../routes/projects.js";
import { runIntelligenceRoutes } from "../routes/run-intelligence.js";
import { secretRoutes } from "../routes/secrets.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import type { PluginHostRuntime } from "./plugin-host-runtime.js";
import type { RudderAppOptions } from "./types.js";

export function registerApiRoutes(
  db: Db,
  opts: RudderAppOptions,
  pluginRuntime: PluginHostRuntime,
) {
  const api = Router();

  api.use(boardMutationGuard());
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
  api.use("/orgs", organizationRoutes(db, opts.storageService));
  api.use(organizationSkillRoutes(db));
  api.use(agentRoutes(db, opts.storageService));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService));
  api.use(messengerRoutes(db));
  api.use(chatRoutes(db, opts.storageService));
  api.use(automationRoutes(db));
  api.use(executionWorkspaceRoutes(db));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(runIntelligenceRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(instanceSettingsRoutes(db, { deploymentMode: opts.deploymentMode }));
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
