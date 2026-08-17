import { Button } from "@/components/ui/button";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "@/lib/router";
import type { Agent } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { accessApi } from "./api/access";
import { agentsApi } from "./api/agents";
import { authApi } from "./api/auth";
import { healthApi } from "./api/health";
import { AppBuilderAutoLaunchCoordinator } from "./components/AppBuilderAutoLaunchCoordinator";
import { DesktopBrowserLinkBridge } from "./components/DesktopBrowserLinkBridge";
import { DesktopReleaseNotesDialog } from "./components/DesktopReleaseNotesDialog";
import { DesktopUpdatePromptBridge } from "./components/DesktopUpdatePromptBridge";
import { DesktopUpdateStatusCard } from "./components/DesktopUpdateStatusCard";
import { DesktopSettingsModalFrame, Layout } from "./components/Layout";
import { LocalTrustedSettingsRoute } from "./components/LocalTrustedSettingsRoute";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { PageSkeleton } from "./components/PageSkeleton";
import { ProductTourOverlay } from "./components/ProductTourOverlay";
import { ToastViewport } from "./components/ToastViewport";
import { BreadcrumbProvider } from "./context/BreadcrumbContext";
import { useDialog } from "./context/DialogContext";
import { useI18n } from "./context/I18nContext";
import { LiveSurfaceRuntimeLayer, LiveSurfaceRuntimeProvider } from "./context/LiveSurfaceRuntimeContext";
import { MainWorkbenchProvider } from "./context/MainWorkbenchContext";
import { useOrganization } from "./context/OrganizationContext";
import { SavedViewPromotionProvider } from "./context/SavedViewPromotionContext";
import { SidePanelProvider } from "./context/SidePanelContext";
import { useExperimentalGoalsEnabled } from "./hooks/useExperimentalGoalsEnabled";
import { useViewedOrganization } from "./hooks/useViewedOrganization";
import {
  normalizeRememberedInstanceSettingsPath,
  resolveDefaultInstanceSettingsPath,
} from "./lib/instance-settings";
import { shouldRedirectOrganizationlessRouteToOnboarding } from "./lib/onboarding-route";
import { DEFAULT_ORGANIZATION_HOME_PATH, findOrganizationByPrefix, getOrganizationRouteKey } from "./lib/organization-routes";
import { getOrganizationSettingsPath } from "./lib/organization-settings-path";
import { queryKeys } from "./lib/queryKeys";
import {
  clearStoredSettingsOverlayBackgroundPath,
  isSettingsOverlayRoutePath,
  preserveSettingsOverlayState,
  readSettingsOverlayBackgroundPath,
  readStoredSettingsOverlayBackgroundPath,
} from "./lib/settings-overlay-state";
import { legacySkillRouteToLibraryHref } from "./lib/skill-library-routes";
import { agentUrl } from "./lib/utils";
import { Activity } from "./pages/Activity";
import { AgentDetail } from "./pages/AgentDetail";
import { Apps } from "./pages/Apps";
import { AuthPage } from "./pages/Auth";
import { Automations } from "./pages/Automations";
import { BoardClaimPage } from "./pages/BoardClaim";
import { Calendar as CalendarPage } from "./pages/Calendar";
import { Chat } from "./pages/Chat";
import { CliAuthPage } from "./pages/CliAuth";
import { Costs } from "./pages/Costs";
import { Dashboard } from "./pages/Dashboard";
import { GoalDetail } from "./pages/GoalDetail";
import { Goals } from "./pages/Goals";
import { Inbox } from "./pages/Inbox";
import { InstanceAboutSettings } from "./pages/InstanceAboutSettings";
import { InstanceAppearanceSettings } from "./pages/InstanceAppearanceSettings";
import { InstanceBrowserSettings } from "./pages/InstanceBrowserSettings";
import { InstanceExperimentalSettings } from "./pages/InstanceExperimentalSettings";
import { InstanceGeneralSettings } from "./pages/InstanceGeneralSettings";
import { InstanceNotificationsSettings } from "./pages/InstanceNotificationsSettings";
import { InstancePrivacyTelemetrySettings } from "./pages/InstancePrivacyTelemetrySettings";
import { InstanceProfileSettings } from "./pages/InstanceProfileSettings";
import { InstanceSettings } from "./pages/InstanceSettings";
import { InstanceShortcutsSettings } from "./pages/InstanceShortcutsSettings";
import { InviteLandingPage } from "./pages/InviteLanding";
import { IssueDetail } from "./pages/IssueDetail";
import { Issues } from "./pages/Issues";
import { LocalAppSavedViewWorkspace } from "./pages/LocalAppSavedViewWorkspace";
import { Messenger } from "./pages/Messenger";
import { NewAgent } from "./pages/NewAgent";
import { NotFoundPage } from "./pages/NotFound";
import { OrganizationExport } from "./pages/OrganizationExport";
import { OrganizationHeartbeats } from "./pages/OrganizationHeartbeats";
import { OrganizationImport } from "./pages/OrganizationImport";
import { OrganizationResources } from "./pages/OrganizationResources";
import { OrganizationSettings } from "./pages/OrganizationSettings";
import { OrganizationWorkspaceBackups } from "./pages/OrganizationWorkspaceBackups";
import { PluginDetail } from "./pages/PluginDetail";
import { Plugins } from "./pages/Plugins";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Projects } from "./pages/Projects";
import { RunWorkspaceDetail } from "./pages/RunWorkspaceDetail";
import { UiLab } from "./pages/UiLab";

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
    const leftPriority = left.role === "ceo" ? 0 : 1;
    const rightPriority = right.role === "ceo" ? 0 : 1;
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
    return <AgentsEntrySkeleton />;
  }

  const targetAgent = agents ? pickAgentsEntryTarget(agents) : null;
  if (!targetAgent) {
    return <AgentsEntrySkeleton />;
  }

  return <Navigate to={`${agentUrl(targetAgent)}/dashboard`} replace />;
}

function AgentsEntrySkeleton() {
  return (
    <div data-testid="agents-entry-skeleton">
      <PageSkeleton variant="detail" />
    </div>
  );
}

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to={DEFAULT_ORGANIZATION_HOME_PATH.slice(1)} replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="dashboard/calendar" element={<CalendarPage />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="organizations" element={<LegacyOrganizationsRedirect />} />
      <Route path="organization/settings" element={<OrganizationSettings />} />
      <Route path="organization/settings/workspace/backups" element={<LegacyWorkspaceBackupsRedirect />} />
      <Route path="library" element={<OrganizationResources />} />
      <Route path="resources" element={<LegacyResourcesRedirect />} />
      <Route path="heartbeats" element={<OrganizationHeartbeats />} />
      <Route path="workspaces" element={<LegacyWorkspacesRedirect />} />
      <Route path="workspaces/backups" element={<OrganizationWorkspaceBackups />} />
      <Route path="organization/export/*" element={<OrganizationExport />} />
      <Route path="organization/import" element={<OrganizationImport />} />
      <Route path="skills/*" element={<LegacySkillsRedirect />} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="hub" element={<Plugins />} />
      <Route path="hub/plugins/:slug" element={<PluginDetail />} />
      <Route path="plugins" element={<Plugins />} />
      <Route path="plugins/catalog/:slug" element={<PluginDetail />} />
      <Route path="org" element={<Navigate to="../organization/settings" replace />} />
      <Route path="agents" element={<AgentsEntryRedirect />} />
      <Route path="agents/all" element={<Navigate to="/agents" replace />} />
      <Route path="agents/active" element={<Navigate to="/agents" replace />} />
      <Route path="agents/paused" element={<Navigate to="/agents" replace />} />
      <Route path="agents/error" element={<Navigate to="/agents" replace />} />
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
      <Route path="messenger/issues/:issueId" element={<IssueDetail />} />
      <Route path="messenger/approvals" element={<Messenger />} />
      <Route path="messenger/approvals/:approvalId" element={<Messenger />} />
      <Route path="messenger/system/:threadKind" element={<Messenger />} />
      <Route path="messenger/chat" element={<Chat />} />
      <Route path="messenger/chat/:conversationId" element={<Chat />} />
      <Route path="chat" element={<LegacyMessengerRedirect />} />
      <Route path="chat/:conversationId" element={<LegacyMessengerRedirect />} />
      <Route path="automations" element={<Automations />} />
      <Route path="automations/:automationId" element={<Automations />} />
      <Route path="apps/saved/:savedViewId" element={<LocalAppSavedViewWorkspace />} />
      <Route path="apps/*" element={<Apps />} />
      <Route path="calendar" element={<LegacyCalendarRedirect />} />
      <Route path="run-workspaces/:workspaceId" element={<RunWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId" element={<RunWorkspaceDetail />} />
      <Route element={<ExperimentalGoalsGate />}>
        <Route path="goals" element={<Goals />} />
        <Route path="goals/:goalId" element={<GoalDetail />} />
      </Route>
      <Route path="costs" element={<Costs />} />
      <Route path="activity" element={<Activity />} />
      <Route path="inbox" element={<Inbox />} />
      <Route path="inbox/*" element={<Inbox />} />
      <Route path="ui-lab" element={<UiLab />} />
      <Route path="design-guide" element={<UiLab initialSection="design-guide" />} />
      <Route path="tests/ux/runs" element={<UiLab initialSection="transcripts" />} />
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

function LegacyCalendarRedirect() {
  const location = useLocation();
  const { orgPrefix } = useParams<{ orgPrefix?: string }>();
  if (!orgPrefix) {
    return <Navigate to={`/dashboard/calendar${location.search}${location.hash}`} replace />;
  }
  return <Navigate to={`/${orgPrefix}/dashboard/calendar${location.search}${location.hash}`} replace />;
}

function InstanceSettingsRedirect({ requestedPath }: { requestedPath?: string }) {
  const { t } = useI18n();
  const location = useLocation();
  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  if (boardAccessQuery.isLoading || healthQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("common.loading")}</div>;
  }

  const canManageAdminSettings = boardAccessQuery.data?.isInstanceAdmin === true;
  const target = requestedPath
    ? requestedPath === "/instance/settings"
      ? resolveDefaultInstanceSettingsPath(canManageAdminSettings)
      : normalizeRememberedInstanceSettingsPath(
          `${requestedPath}${location.search}${location.hash}`,
          canManageAdminSettings,
          healthQuery.data?.deploymentMode ?? "authenticated",
        )
    : resolveDefaultInstanceSettingsPath(canManageAdminSettings);

  return <Navigate to={target} replace />;
}

function LegacyAccountSettingsRedirect() {
  const location = useLocation();
  return (
    <Navigate
      to={`/instance/settings/profile${location.search}${location.hash}`}
      replace
      state={location.state}
    />
  );
}

function LegacySettingsRedirect() {
  const location = useLocation();
  return <InstanceSettingsRedirect requestedPath={`/instance${location.pathname}`} />;
}

function LegacyWorkspaceBackupsRedirect() {
  const { orgPrefix } = useParams<{ orgPrefix?: string }>();
  const location = useLocation();
  return <Navigate to={`/${orgPrefix ?? ""}/workspaces/backups${location.search}${location.hash}`} replace />;
}

function LegacyResourcesRedirect() {
  const location = useLocation();
  return <Navigate to={`/library${location.search}${location.hash}`} replace />;
}

function LegacyWorkspacesRedirect() {
  const location = useLocation();
  return <Navigate to={`/library${location.search}${location.hash}`} replace />;
}

function LegacySkillsRedirect() {
  const { "*": routePath } = useParams<{ "*": string }>();
  return <Navigate to={legacySkillRouteToLibraryHref(routePath)} replace />;
}

function LegacyOrganizationsRedirect() {
  const location = useLocation();
  const { orgPrefix } = useParams<{ orgPrefix?: string }>();
  const target = orgPrefix
    ? `/${orgPrefix}/organization/settings${location.search}${location.hash}`
    : `/organization/settings${location.search}${location.hash}`;
  return <Navigate to={target} replace />;
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

  if (!matchedOrganization) return null;

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {t("app.addAnotherAgentToOrganization", { name: matchedOrganization.name })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("app.onboarding.addAgentDescription")}
        </p>
        <div className="mt-4">
          <Button
            onClick={() =>
              openOnboarding({ initialStep: 2, orgId: matchedOrganization.id })
            }
          >
            {t("app.addAgent")}
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

  return <Navigate to={`/${getOrganizationRouteKey(targetOrganization)}${DEFAULT_ORGANIZATION_HOME_PATH}`} replace />;
}

function ExperimentalGoalsGate() {
  const { enabled, error, isLoading, retry } = useExperimentalGoalsEnabled();

  if (isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  if (error) {
    return (
      <div role="alert" className="mx-auto max-w-xl space-y-3 py-10">
        <p className="text-sm font-medium text-destructive">Unable to check whether Goals are enabled.</p>
        <p className="text-sm text-muted-foreground">Retry to check the experiment setting before opening Goals.</p>
        <Button type="button" variant="outline" onClick={() => void retry()}>Retry</Button>
      </div>
    );
  }

  if (!enabled) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
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
      to={`/${getOrganizationRouteKey(targetOrganization)}${location.pathname}${location.search}${location.hash}`}
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
  const backgroundPath = readSettingsOverlayBackgroundPath(location.state) ?? DEFAULT_ORGANIZATION_HOME_PATH;
  const overlayState = preserveSettingsOverlayState(location.state);

  useEffect(() => {
    if (!orgPrefix || organizationsLoading || viewedOrganization) return;

    if (selectedOrganization) {
      navigate(
        getOrganizationSettingsPath(getOrganizationRouteKey(selectedOrganization)),
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
      <BreadcrumbProvider manageDocumentTitle={false}>
        <Outlet />
      </BreadcrumbProvider>
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
      <LiveSurfaceRuntimeProvider>
      <MainWorkbenchProvider>
      <SidePanelProvider>
      <SavedViewPromotionProvider>
        <DesktopBrowserLinkBridge />
        <AppBuilderAutoLaunchCoordinator />
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
            <Route path="account" element={<LegacyAccountSettingsRedirect />} />
            <Route path="shortcuts" element={<InstanceShortcutsSettings />} />
            <Route path="general" element={<InstanceGeneralSettings />} />
            <Route path="experimental" element={<InstanceExperimentalSettings />} />
            <Route path="appearance" element={<InstanceAppearanceSettings />} />
            <Route
              path="browser"
              element={
                <LocalTrustedSettingsRoute>
                  <InstanceBrowserSettings />
                </LocalTrustedSettingsRoute>
              }
            />
            <Route path="notifications" element={<InstanceNotificationsSettings />} />
            <Route path="privacy" element={<InstancePrivacyTelemetrySettings />} />
            <Route path="about" element={<InstanceAboutSettings />} />
            <Route path="heartbeats" element={<InstanceSettings />} />
            <Route path="*" element={<NotFoundPage scope="global" />} />
          </Route>
          <Route path="organizations" element={<LegacyOrganizationsRedirect />} />
          <Route path="dashboard" element={<UnprefixedBoardRedirect />} />
          <Route path="dashboard/calendar" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="messenger" element={<UnprefixedBoardRedirect />} />
          <Route path="messenger/*" element={<UnprefixedBoardRedirect />} />
          <Route path="inbox" element={<UnprefixedBoardRedirect />} />
          <Route path="inbox/*" element={<UnprefixedBoardRedirect />} />
          <Route path="chat" element={<LegacyMessengerRedirect />} />
          <Route path="chat/:conversationId" element={<LegacyMessengerRedirect />} />
          <Route path="ui-lab" element={<UnprefixedBoardRedirect />} />
          <Route path="design-guide" element={<UnprefixedBoardRedirect />} />
          <Route path="automations" element={<UnprefixedBoardRedirect />} />
          <Route path="automations/:automationId" element={<UnprefixedBoardRedirect />} />
          <Route path="apps/*" element={<UnprefixedBoardRedirect />} />
          <Route path="hub" element={<UnprefixedBoardRedirect />} />
          <Route path="plugins" element={<UnprefixedBoardRedirect />} />
          <Route path="calendar" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
          <Route path="heartbeats" element={<UnprefixedBoardRedirect />} />
          <Route path="organization/settings" element={<UnprefixedBoardRedirect />} />
          <Route path="organization/settings/workspace/backups" element={<UnprefixedBoardRedirect />} />
          <Route path="organization/export/*" element={<UnprefixedBoardRedirect />} />
          <Route path="organization/import" element={<UnprefixedBoardRedirect />} />
          <Route path="workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="workspaces/backups" element={<UnprefixedBoardRedirect />} />
          <Route path="library" element={<UnprefixedBoardRedirect />} />
          <Route path="resources" element={<LegacyResourcesRedirect />} />
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
      </SavedViewPromotionProvider>
      </SidePanelProvider>
      <LiveSurfaceRuntimeLayer />
      </MainWorkbenchProvider>
      </LiveSurfaceRuntimeProvider>
      {showDesktopSettingsOverlay ? (
        <Routes>
          <Route element={<CloudAccessGate />}>
            <Route path="instance/settings" element={<DesktopSettingsOverlayLayout />}>
              <Route index element={<InstanceSettingsRedirect requestedPath="/instance/settings" />} />
              <Route path="profile" element={<InstanceProfileSettings />} />
              <Route path="account" element={<LegacyAccountSettingsRedirect />} />
              <Route path="shortcuts" element={<InstanceShortcutsSettings />} />
              <Route path="general" element={<InstanceGeneralSettings />} />
              <Route path="experimental" element={<InstanceExperimentalSettings />} />
              <Route path="appearance" element={<InstanceAppearanceSettings />} />
              <Route
                path="browser"
                element={
                  <LocalTrustedSettingsRoute>
                    <InstanceBrowserSettings />
                  </LocalTrustedSettingsRoute>
                }
              />
              <Route path="notifications" element={<InstanceNotificationsSettings />} />
              <Route path="privacy" element={<InstancePrivacyTelemetrySettings />} />
              <Route path="about" element={<InstanceAboutSettings />} />
              <Route path="heartbeats" element={<InstanceSettings />} />
              <Route path="*" element={<NotFoundPage scope="global" />} />
            </Route>
            <Route path=":orgPrefix" element={<DesktopSettingsOverlayLayout />}>
              <Route path="organization/settings" element={<OrganizationSettings />} />
            </Route>
          </Route>
        </Routes>
      ) : null}
      <OnboardingWizard />
      <ProductTourOverlay />
      <DesktopReleaseNotesDialog />
      <DesktopUpdatePromptBridge />
      <ToastViewport />
      <DesktopUpdateStatusCard />
    </>
  );
}
