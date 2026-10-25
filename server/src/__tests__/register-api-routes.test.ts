import { Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApiRoutes } from "../bootstrap/register-api-routes.js";
import * as localAccountRoutes from "../routes/local-account-auth.js";

const mocks = vi.hoisted(() => ({
  organizationRoutes: vi.fn(), projectRoutes: vi.fn(), goalRoutes: vi.fn(),
  localAccountAuthRoutes: vi.fn(), otherRoute: vi.fn(), rudderPluginService: vi.fn(),
}));

vi.mock("../routes/access.js", () => ({ accessRoutes: mocks.otherRoute }));
vi.mock("../routes/activity.js", () => ({ activityRoutes: mocks.otherRoute }));
vi.mock("../routes/agents.js", () => ({ agentRoutes: mocks.otherRoute }));
vi.mock("../routes/ai-search.js", () => ({ aiSearchRoutes: mocks.otherRoute }));
vi.mock("../routes/app-builder.js", () => ({ appBuilderRoutes: mocks.otherRoute }));
vi.mock("../routes/approvals.js", () => ({ approvalRoutes: mocks.otherRoute }));
vi.mock("../routes/assets.js", () => ({ assetRoutes: mocks.otherRoute }));
vi.mock("../routes/automations.js", () => ({ automationRoutes: mocks.otherRoute }));
vi.mock("../routes/browser.js", () => ({ browserRoutes: mocks.otherRoute }));
vi.mock("../routes/calendar.js", () => ({ calendarRoutes: mocks.otherRoute }));
vi.mock("../routes/chats.js", () => ({ chatRoutes: mocks.otherRoute }));
vi.mock("../routes/computer.js", () => ({ computerRoutes: mocks.otherRoute }));
vi.mock("../routes/costs.js", () => ({ costRoutes: mocks.otherRoute }));
vi.mock("../routes/dashboard.js", () => ({ dashboardRoutes: mocks.otherRoute }));
vi.mock("../routes/execution-workspaces.js", () => ({ runWorkspaceRoutes: mocks.otherRoute }));
vi.mock("../routes/health.js", () => ({ healthRoutes: mocks.otherRoute }));
vi.mock("../routes/instance-settings.js", () => ({ instanceSettingsRoutes: mocks.otherRoute }));
vi.mock("../routes/integrations.js", () => ({ integrationRoutes: mocks.otherRoute }));
vi.mock("../routes/issues.js", () => ({ issueRoutes: mocks.otherRoute }));
vi.mock("../routes/local-account-auth.js", () => ({ localAccountAuthRoutes: mocks.localAccountAuthRoutes }));
vi.mock("../routes/managed-mcp-agent-bindings.js", () => ({ managedMcpAgentBindingRoutes: mocks.otherRoute }));
vi.mock("../routes/managed-mcp-connections.js", () => ({ managedMcpConnectionRoutes: mocks.otherRoute }));
vi.mock("../routes/messenger.js", () => ({ messengerRoutes: mocks.otherRoute }));
vi.mock("../routes/onboarding.js", () => ({ onboardingRoutes: mocks.otherRoute }));
vi.mock("../routes/organization-skills.js", () => ({ organizationSkillRoutes: mocks.otherRoute }));
vi.mock("../routes/product-analytics.js", () => ({ productAnalyticsRoutes: mocks.otherRoute }));
vi.mock("../routes/requests.js", () => ({ requestRoutes: mocks.otherRoute }));
vi.mock("../routes/rudder-plugins.js", () => ({ rudderPluginRoutes: mocks.otherRoute }));
vi.mock("../routes/run-intelligence.js", () => ({ runIntelligenceRoutes: mocks.otherRoute }));
vi.mock("../routes/secrets.js", () => ({ secretRoutes: mocks.otherRoute }));
vi.mock("../routes/sidebar-badges.js", () => ({ sidebarBadgeRoutes: mocks.otherRoute }));
vi.mock("../routes/website-metadata.js", () => ({ websiteMetadataRoutes: mocks.otherRoute }));
vi.mock("../middleware/board-mutation-guard.js", () => ({ boardMutationGuard: () => mocks.otherRoute() }));
vi.mock("../services/rudder-plugins.js", () => ({ rudderPluginService: mocks.rudderPluginService }));
vi.mock("../routes/orgs.js", () => ({ organizationRoutes: mocks.organizationRoutes }));
vi.mock("../routes/projects.js", () => ({ projectRoutes: mocks.projectRoutes }));
vi.mock("../routes/goals.js", () => ({ goalRoutes: mocks.goalRoutes }));

beforeEach(() => {
  mocks.organizationRoutes.mockReset();
  mocks.organizationRoutes.mockImplementation(() => Router());
  mocks.projectRoutes.mockReset();
  mocks.projectRoutes.mockImplementation(() => Router());
  mocks.goalRoutes.mockReset();
  mocks.goalRoutes.mockImplementation(() => Router());
  mocks.localAccountAuthRoutes.mockReset();
  mocks.localAccountAuthRoutes.mockImplementation(() => Router());
  mocks.otherRoute.mockReset();
  mocks.otherRoute.mockImplementation(() => Router());
  mocks.rudderPluginService.mockReset();
  mocks.rudderPluginService.mockImplementation(() => ({ syncLocalApps: vi.fn() }));
});

describe("registerApiRoutes", () => {
  it("passes native organization and Project route gates only when public ingress is configured", () => {
    const baseOptions = {
      uiMode: "none", serverPort: 3100, storageService: {}, deploymentMode: "local_trusted",
      deploymentExposure: "private", allowedHostnames: [], bindHost: "127.0.0.1",
      authReady: true, companyDeletionEnabled: false,
    };

    registerApiRoutes({} as never, {
      ...baseOptions,
      rustPublicIngress: {},
    } as never);
    expect(mocks.organizationRoutes.mock.calls.at(-1)?.[4]).toEqual({ nativeResourceRoutes: true });
    expect(mocks.projectRoutes.mock.calls.at(-1)?.[2]).toEqual({
      nativeProjectReads: true,
      nativeProjectWrites: true,
    });
    expect(mocks.goalRoutes.mock.calls.at(-1)?.[2]).toEqual({ nativeGoalWrites: true });

    registerApiRoutes({} as never, baseOptions as never);
    expect(mocks.organizationRoutes.mock.calls.at(-1)?.[4]).toEqual({ nativeResourceRoutes: false });
    expect(mocks.projectRoutes.mock.calls.at(-1)?.[2]).toEqual({
      nativeProjectReads: false,
      nativeProjectWrites: false,
    });
    expect(mocks.goalRoutes.mock.calls.at(-1)?.[2]).toEqual({ nativeGoalWrites: false });
  });

  it("builds the API router from the current server dependencies", () => {
    const router = registerApiRoutes(
      {} as never,
      {
        uiMode: "none",
        serverPort: 3100,
        storageService: {} as never,
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        authReady: true,
        companyDeletionEnabled: false,
      },
    );

    expect(router).toBeTruthy();
    expect((router as { stack?: unknown[] }).stack?.length ?? 0).toBeGreaterThan(10);
  });
});

afterEach(() => vi.restoreAllMocks());

it("retires the private Node account writer when native lifecycle authority is configured", () => {
  const legacy = vi.spyOn(localAccountRoutes, "localAccountAuthRoutes").mockReturnValue(Router());
  const options = {
    uiMode: "none", serverPort: 3100, storageService: {}, deploymentMode: "local_trusted",
    deploymentExposure: "private", allowedHostnames: [], bindHost: "127.0.0.1",
    authReady: true, companyDeletionEnabled: false, instanceId: "test-installation",
    localAccountExchangePolicy: {},
  };
  registerApiRoutes({} as never, {
    ...options,
    rustPublicIngress: {
      localAccountLifecycle: {
        installationId: "test-installation", expectedIssuer: "https://identity.example",
        identityOrigin: "https://identity.example", audience: "test-audience",
      },
    },
  } as never);
  expect(legacy).not.toHaveBeenCalled();
  registerApiRoutes({} as never, options as never);
  expect(legacy).toHaveBeenCalledOnce();
});
