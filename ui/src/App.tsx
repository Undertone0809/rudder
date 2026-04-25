import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "@/lib/router";
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { DesktopSettingsModalFrame, Layout } from "./components/Layout";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { ToastViewport } from "./components/ToastViewport";
import { accessApi } from "./api/access";
import { agentsApi } from "./api/agents";
import { authApi } from "./api/auth";
import { healthApi } from "./api/health";
import { Dashboard } from "./pages/Dashboard";
import { Organizations } from "./pages/Organizations";
import { Agents } from "./pages/Agents";
import { AgentDetail } from "./pages/AgentDetail";
import { Projects } from "./pages/Projects";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Issues } from "./pages/Issues";
import { IssueDetail } from "./pages/IssueDetail";
import { Chat } from "./pages/Chat";
import { Messenger } from "./pages/Messenger";
import { Automations } from "./pages/Automations";
import { AutomationDetail } from "./pages/AutomationDetail";
import { ExecutionWorkspaceDetail } from "./pages/ExecutionWorkspaceDetail";
import { Goals } from "./pages/Goals";
import { GoalDetail } from "./pages/GoalDetail";
import { Costs } from "./pages/Costs";
import { Activity } from "./pages/Activity";
import { OrganizationSettings } from "./pages/OrganizationSettings";
import { OrganizationHeartbeats } from "./pages/OrganizationHeartbeats";
import { OrganizationResources } from "./pages/OrganizationResources";
import { OrganizationWorkspaces } from "./pages/OrganizationWorkspaces";
import { OrganizationSkills } from "./pages/OrganizationSkills";
import { OrganizationExport } from "./pages/OrganizationExport";
import { OrganizationImport } from "./pages/OrganizationImport";
import { DesignGuide } from "./pages/DesignGuide";
import { InstanceGeneralSettings } from "./pages/InstanceGeneralSettings";
import { InstanceNotificationsSettings } from "./pages/InstanceNotificationsSettings";
import { InstanceLangfuseSettings } from "./pages/InstanceLangfuseSettings";
import { InstanceAboutSettings } from "./pages/InstanceAboutSettings";
import { InstanceProfileSettings } from "./pages/InstanceProfileSettings";
import { InstanceSettings } from "./pages/InstanceSettings";
import { InstanceExperimentalSettings } from "./pages/InstanceExperimentalSettings";
import { PluginManager } from "./pages/PluginManager";
import { PluginSettings } from "./pages/PluginSettings";
import { PluginPage } from "./pages/PluginPage";
import { RunTranscriptUxLab } from "./pages/RunTranscriptUxLab";
import { OrgChart } from "./pages/OrgChart";
import { NewAgent } from "./pages/NewAgent";
import { AuthPage } from "./pages/Auth";
import { BoardClaimPage } from "./pages/BoardClaim";
import { CliAuthPage } from "./pages/CliAuth";
import { InviteLandingPage } from "./pages/InviteLanding";
import { NotFoundPage } from "./pages/NotFound";
import { queryKeys } from "./lib/queryKeys";
import {
  INSTANCE_SETTINGS_ORGANIZATIONS_PATH,
  normalizeRememberedInstanceSettingsPath,
  resolveDefaultInstanceSettingsPath,
} from "./lib/instance-settings";
import {
  clearStoredSettingsOverlayBackgroundPath,
  isSettingsOverlayRoutePath,
  preserveSettingsOverlayState,
  readStoredSettingsOverlayBackgroundPath,
  readSettingsOverlayBackgroundPath,
} from "./lib/settings-overlay-state";
import { useOrganization } from "./context/OrganizationContext";
import { useDialog } from "./context/DialogContext";
import { useI18n } from "./context/I18nContext";
import { useViewedOrganization } from "./hooks/useViewedOrganization";
import { getOrganizationSettingsPath } from "./lib/organization-settings-path";
import { agentUrl } from "./lib/utils";
import { shouldRedirectOrganizationlessRouteToOnboarding } from "./lib/onboarding-route";
import { findOrganizationByPrefix } from "./lib/organization-routes";
import type { Agent } from "@rudder/shared";

function BootstrapPendingPage({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{t("app.instanceSetupRequired")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasActiveInvite
            ? t("app.bootstrapInvite.active")
            : t("app.bootstrapInvite.inactive")}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm rudder auth bootstrap-ceo`}
        </pre>
      </div>
    </div>
  );
}

function CloudAccessGate() {
  const { t } = useI18n();
  const location = useLocation();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  if (healthQuery.isLoading || (isAuthenticatedMode && sessionQuery.isLoading)) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("common.loading")}</div>;
  }

  if (healthQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error ? healthQuery.error.message : t("app.failedToLoadAppState")}
      </div>
    );
  }

  if (isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending") {
    return <BootstrapPendingPage hasActiveInvite={healthQuery.data.bootstrapInviteActive} />;
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  return <Outlet />;
}

function pickAgentsEntryTarget(agents: Agent[]): Agent | null {
  const visibleAgents = agents.filter((agent) => agent.status !== "terminated");
  if (visibleAgents.length === 0) return null;

  return [...visibleAgents].sort((left, right) => {
    const leftPriority = left.reportsTo === null ? 0 : left.role === "ceo" ? 1 : 2;
    const rightPriority = right.reportsTo === null ? 0 : right.role === "ceo" ? 1 : 2;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.name.localeCompare(right.name);
  })[0] ?? null;
}

function AgentsEntryRedirect() {
  const { selectedOrganizationId } = useOrganization();
  const { viewedOrganizationId } = useViewedOrganization();
  const organizationId = viewedOrganizationId ?? selectedOrganizationId;
  const { data: agents, isLoading } = useQuery({
    queryKey: queryKeys.agents.list(organizationId ?? "__none__"),
    queryFn: () => agentsApi.list(organizationId!),
    enabled: !!organizationId,
  });

  if (!organizationId || isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading agents…</div>;
  }

  const targetAgent = agents ? pickAgentsEntryTarget(agents) : null;
  if (!targetAgent) {
    return <Navigate to="/agents/all" replace />;
  }

  return <Navigate to={`${agentUrl(targetAgent)}/dashboard`} replace />;
}

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="organizations" element={<LegacyOrganizationsRedirect />} />
      <Route path="organization/settings" element={<OrganizationSettings />} />
      <Route path="resources" element={<OrganizationResources />} />
      <Route path="heartbeats" element={<OrganizationHeartbeats />} />
      <Route path="workspaces" element={<OrganizationWorkspaces />} />
      <Route path="organization/export/*" element={<OrganizationExport />} />
      <Route path="organization/import" element={<OrganizationImport />} />
      <Route path="skills/*" element={<OrganizationSkills />} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route path="org" element={<OrgChart />} />
      <Route path="agents" element={<AgentsEntryRedirect />} />
      <Route path="agents/all" element={<Agents />} />
      <Route path="agents/active" element={<Agents />} />
      <Route path="agents/paused" element={<Agents />} />
      <Route path="agents/error" element={<Agents />} />
      <Route path="agents/new" element={<NewAgent />} />
      <Route path="agents/:agentId" element={<AgentDetail />} />
      <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
      <Route path="projects/:projectId/resources" element={<ProjectDetail />} />
      <Route path="projects/:projectId/configuration" element={<ProjectDetail />} />
      <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
      <Route path="issues" element={<Issues />} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="issues/:issueId" element={<IssueDetail />} />
      <Route path="messenger" element={<Messenger />} />
      <Route path="messenger/*" element={<Messenger />} />
      <Route path="messenger/issues" element={<Messenger />} />
      <Route path="messenger/approvals" element={<Messenger />} />
      <Route path="messenger/approvals/:approvalId" element={<Messenger />} />
      <Route path="messenger/system/:threadKind" element={<Messenger />} />
      <Route path="messenger/chat" element={<Chat />} />
      <Route path="messenger/chat/:conversationId" element={<Chat />} />
      <Route path="chat" element={<LegacyMessengerRedirect />} />
      <Route path="chat/:conversationId" element={<LegacyMessengerRedirect />} />
      <Route path="automations" element={<Automations />} />
      <Route path="automations/:automationId" element={<AutomationDetail />} />
      <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      <Route path="costs" element={<Costs />} />
      <Route path="activity" element={<Activity />} />
      <Route path="inbox" element={<LegacyInboxRedirect />} />
      <Route path="inbox/*" element={<LegacyInboxRedirect />} />
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="tests/ux/runs" element={<RunTranscriptUxLab />} />
      <Route path=":pluginRoutePath" element={<PluginPage />} />
      <Route path="*" element={<NotFoundPage scope="board" />} />
    </>
  );
}

function LegacyMessengerRedirect() {
  const location = useLocation();
  const { orgPrefix, conversationId } = useParams<{ orgPrefix?: string; conversationId?: string }>();
  if (!orgPrefix) {
    return <Navigate to={conversationId ? `/messenger/chat/${conversationId}${location.search}${location.hash}` : `/messenger${location.search}${location.hash}`} replace />;
  }
  return (
    <Navigate
      to={conversationId
        ? `/${orgPrefix}/messenger/chat/${conversationId}${location.search}${location.hash}`
        : `/${orgPrefix}/messenger${location.search}${location.hash}`}
      replace
    />
  );
}

function LegacyInboxRedirect() {
  const location = useLocation();
  const { orgPrefix } = useParams<{ orgPrefix?: string }>();
  if (!orgPrefix) {
    return <Navigate to={`/messenger${location.search}${location.hash}`} replace />;
  }
  return <Navigate to={`/${orgPrefix}/messenger${location.search}${location.hash}`} replace />;
}

function InstanceSettingsRedirect({ requestedPath }: { requestedPath?: string }) {
  const { t } = useI18n();
  const location = useLocation();
  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });

  if (boardAccessQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("common.loading")}</div>;
  }

  const canManageAdminSettings = boardAccessQuery.data?.isInstanceAdmin === true;
  const target = requestedPath
    ? requestedPath === "/instance/settings"
      ? resolveDefaultInstanceSettingsPath(canManageAdminSettings)
      : normalizeRememberedInstanceSettingsPath(
          `${requestedPath}${location.search}${location.hash}`,
          canManageAdminSettings,
        )
    : resolveDefaultInstanceSettingsPath(canManageAdminSettings);

  return <Navigate to={target} replace />;
}

function LegacySettingsRedirect() {
  const location = useLocation();
  return <InstanceSettingsRedirect requestedPath={`/instance${location.pathname}`} />;
}

function LegacyOrganizationsRedirect() {
  const location = useLocation();
  return <Navigate to={`${INSTANCE_SETTINGS_ORGANIZATIONS_PATH}${location.search}${location.hash}`} replace />;
}

function OnboardingRoutePage() {
  const { t } = useI18n();
  const { organizations } = useOrganization();
  const { openOnboarding } = useDialog();
  const { orgPrefix } = useParams<{ orgPrefix?: string }>();
  const matchedOrganization = orgPrefix
    ? findOrganizationByPrefix({
        organizations,
        organizationPrefix: orgPrefix,
      })
    : null;

  const title = matchedOrganization
    ? t("app.addAnotherAgentToOrganization", { name: matchedOrganization.name })
    : organizations.length > 0
      ? t("app.createAnotherOrganization")
      : t("app.createFirstOrganization");
  const description = matchedOrganization
    ? t("app.onboarding.addAgentDescription")
    : organizations.length > 0
      ? t("app.onboarding.createAnotherDescription")
      : t("app.onboarding.createFirstDescription");

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4">
          <Button
            onClick={() =>
              matchedOrganization
                ? openOnboarding({ initialStep: 2, orgId: matchedOrganization.id })
                : openOnboarding()
            }
          >
            {matchedOrganization ? t("app.addAgent") : t("app.startOnboarding")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function OrganizationRootRedirect() {
  const { t } = useI18n();
  const { organizations, selectedOrganization, loading } = useOrganization();
  const location = useLocation();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("common.loading")}</div>;
  }

  const targetOrganization = selectedOrganization ?? organizations[0] ?? null;
  if (!targetOrganization) {
    if (
      shouldRedirectOrganizationlessRouteToOnboarding({
        pathname: location.pathname,
        hasOrganizations: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoOrganizationsStartPage />;
  }

  return <Navigate to={`/${targetOrganization.issuePrefix}/dashboard`} replace />;
}

function UnprefixedBoardRedirect() {
  const { t } = useI18n();
  const location = useLocation();
  const { organizations, selectedOrganization, loading } = useOrganization();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("common.loading")}</div>;
  }

  const targetOrganization = selectedOrganization ?? organizations[0] ?? null;
  if (!targetOrganization) {
    if (
      shouldRedirectOrganizationlessRouteToOnboarding({
        pathname: location.pathname,
        hasOrganizations: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoOrganizationsStartPage />;
  }

  return (
    <Navigate
      to={`/${targetOrganization.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

function NoOrganizationsStartPage() {
  const { t } = useI18n();
  const { openOnboarding } = useDialog();

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{t("app.createFirstOrganization")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("app.noCompaniesDescription")}
        </p>
        <div className="mt-4">
          <Button onClick={() => openOnboarding()}>{t("app.newOrganization")}</Button>
        </div>
      </div>
    </div>
  );
}

function DesktopSettingsOverlayLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { orgPrefix } = useParams<{ orgPrefix?: string }>();
  const {
    loading: organizationsLoading,
    selectedOrganization,
  } = useOrganization();
  const { viewedOrganization } = useViewedOrganization();
  const backgroundPath = readSettingsOverlayBackgroundPath(location.state) ?? "/dashboard";
  const overlayState = preserveSettingsOverlayState(location.state);

  useEffect(() => {
    if (!orgPrefix || organizationsLoading || viewedOrganization) return;

    if (selectedOrganization) {
      navigate(
        getOrganizationSettingsPath(selectedOrganization.issuePrefix),
        overlayState ? { replace: true, state: overlayState } : { replace: true },
      );
      return;
    }

    clearStoredSettingsOverlayBackgroundPath();
    navigate(backgroundPath, { replace: true });
  }, [
    backgroundPath,
    navigate,
    orgPrefix,
    organizationsLoading,
    overlayState,
    selectedOrganization,
    viewedOrganization,
  ]);

  return (
    <DesktopSettingsModalFrame
      onClose={() => {
        clearStoredSettingsOverlayBackgroundPath();
        navigate(backgroundPath, { replace: true });
      }}
    >
      <Outlet />
    </DesktopSettingsModalFrame>
  );
}

export function App() {
  const location = useLocation();
  const settingsOverlayBackgroundPath = readSettingsOverlayBackgroundPath(location.state)
    ?? readStoredSettingsOverlayBackgroundPath();
  const showDesktopSettingsOverlay = Boolean(
    settingsOverlayBackgroundPath && isSettingsOverlayRoutePath(location.pathname),
  );

  useEffect(() => {
    if (!isSettingsOverlayRoutePath(location.pathname)) {
      clearStoredSettingsOverlayBackgroundPath();
    }
  }, [location.pathname]);

  return (
    <>
      <Routes location={showDesktopSettingsOverlay ? settingsOverlayBackgroundPath! : location}>
        <Route path="auth" element={<AuthPage />} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="cli-auth/:id" element={<CliAuthPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />

        <Route element={<CloudAccessGate />}>
          <Route index element={<OrganizationRootRedirect />} />
          <Route path="onboarding" element={<OnboardingRoutePage />} />
          <Route path="instance" element={<InstanceSettingsRedirect />} />
          <Route path="instance/settings" element={<Layout />}>
            <Route index element={<InstanceSettingsRedirect requestedPath="/instance/settings" />} />
            <Route path="profile" element={<InstanceProfileSettings />} />
            <Route path="general" element={<InstanceGeneralSettings />} />
            <Route path="notifications" element={<InstanceNotificationsSettings />} />
            <Route path="organizations" element={<Organizations />} />
            <Route path="langfuse" element={<InstanceLangfuseSettings />} />
            <Route path="about" element={<InstanceAboutSettings />} />
            <Route path="heartbeats" element={<InstanceSettings />} />
            <Route path="experimental" element={<InstanceExperimentalSettings />} />
            <Route path="plugins" element={<PluginManager />} />
            <Route path="plugins/:pluginId" element={<PluginSettings />} />
          </Route>
          <Route path="organizations" element={<LegacyOrganizationsRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="messenger" element={<UnprefixedBoardRedirect />} />
          <Route path="messenger/*" element={<UnprefixedBoardRedirect />} />
          <Route path="inbox" element={<LegacyInboxRedirect />} />
          <Route path="inbox/*" element={<LegacyInboxRedirect />} />
          <Route path="chat" element={<LegacyMessengerRedirect />} />
          <Route path="chat/:conversationId" element={<LegacyMessengerRedirect />} />
          <Route path="automations" element={<UnprefixedBoardRedirect />} />
          <Route path="automations/:automationId" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
          <Route path="heartbeats" element={<UnprefixedBoardRedirect />} />
          <Route path="organization/settings" element={<UnprefixedBoardRedirect />} />
          <Route path="organization/export/*" element={<UnprefixedBoardRedirect />} />
          <Route path="organization/import" element={<UnprefixedBoardRedirect />} />
          <Route path="settings" element={<LegacySettingsRedirect />} />
          <Route path="settings/*" element={<LegacySettingsRedirect />} />
          <Route path="agents" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/new" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/:tab" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/runs/:runId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/overview" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues/:filter" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="tests/ux/runs" element={<UnprefixedBoardRedirect />} />
          <Route path=":orgPrefix" element={<Layout />}>
            {boardRoutes()}
          </Route>
          <Route path="*" element={<NotFoundPage scope="global" />} />
        </Route>
      </Routes>
      {showDesktopSettingsOverlay ? (
        <Routes>
          <Route element={<CloudAccessGate />}>
            <Route path="instance/settings" element={<DesktopSettingsOverlayLayout />}>
              <Route index element={<InstanceSettingsRedirect requestedPath="/instance/settings" />} />
              <Route path="profile" element={<InstanceProfileSettings />} />
              <Route path="general" element={<InstanceGeneralSettings />} />
              <Route path="notifications" element={<InstanceNotificationsSettings />} />
              <Route path="organizations" element={<Organizations />} />
              <Route path="langfuse" element={<InstanceLangfuseSettings />} />
              <Route path="about" element={<InstanceAboutSettings />} />
              <Route path="heartbeats" element={<InstanceSettings />} />
              <Route path="experimental" element={<InstanceExperimentalSettings />} />
              <Route path="plugins" element={<PluginManager />} />
              <Route path="plugins/:pluginId" element={<PluginSettings />} />
            </Route>
            <Route path=":orgPrefix" element={<DesktopSettingsOverlayLayout />}>
              <Route path="organization/settings" element={<OrganizationSettings />} />
            </Route>
          </Route>
        </Routes>
      ) : null}
      <OnboardingWizard />
      <ToastViewport />
    </>
  );
}
