import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, Settings, X } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "@/lib/router";
import { SettingsSidebar } from "./SettingsSidebar";
import { PrimaryRail } from "./PrimaryRail";
import { ThreeColumnContextSidebar } from "./ThreeColumnContextSidebar";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { CommandPalette } from "./CommandPalette";
import { NewIssueDialog } from "./NewIssueDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { NewGoalDialog } from "./NewGoalDialog";
import { NewAgentDialog } from "./NewAgentDialog";
import { ToastViewport } from "./ToastViewport";
import { MobileBottomNav } from "./MobileBottomNav";
import { WorktreeBanner } from "./WorktreeBanner";
import { DevRestartBanner } from "./DevRestartBanner";
import { useDialog } from "../context/DialogContext";
import { usePanel } from "../context/PanelContext";
import { useOrganization } from "../context/OrganizationContext";
import { useSidebar } from "../context/SidebarContext";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useOrganizationPageMemory } from "../hooks/useOrganizationPageMemory";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { accessApi } from "../api/access";
import { chatsApi } from "../api/chats";
import { healthApi } from "../api/health";
import { projectsApi } from "../api/projects";
import { shouldSyncOrganizationSelectionFromRoute } from "../lib/organization-selection";
import {
  normalizeRememberedSettingsPath,
  resolveDefaultSettingsPath,
} from "../lib/instance-settings";
import {
  buildSettingsOverlayState,
  clearStoredSettingsOverlayBackgroundPath,
  rememberSettingsOverlayBackgroundPath,
  readSettingsOverlayBackgroundPath,
} from "../lib/settings-overlay-state";
import { prefetchSettingsQueries } from "../lib/settings-prefetch";
import { findOrganizationByPrefix, toOrganizationRelativePath } from "../lib/organization-routes";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { NotFoundPage } from "../pages/NotFound";
import { MobileWorkspaceDrawer } from "@/components/MobileWorkspaceDrawer";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useI18n } from "@/context/I18nContext";

const INSTANCE_SETTINGS_MEMORY_KEY = "rudder.lastInstanceSettingsPath";
const LAST_WORKSPACE_PATH_KEY = "rudder.lastWorkspacePath";
const WORKSPACE_COLUMN_WIDTH_KEY_PREFIX = "rudder.workspace.contextWidth";

type WorkspaceColumnFamily = "chat" | "messenger" | "issues" | "projects" | "agents" | "org";

const WORKSPACE_COLUMN_WIDTH_DEFAULTS: Record<WorkspaceColumnFamily, number> = {
  chat: 318,
  messenger: 332,
  issues: 248,
  projects: 268,
  agents: 268,
  org: 248,
};

const WORKSPACE_COLUMN_WIDTH_LIMITS: Record<WorkspaceColumnFamily, { min: number; max: number }> = {
  chat: { min: 280, max: 420 },
  messenger: { min: 280, max: 420 },
  issues: { min: 220, max: 340 },
  projects: { min: 236, max: 360 },
  agents: { min: 236, max: 360 },
  org: { min: 220, max: 340 },
};

function readRememberedSettingsPath(canManageAdminSettings: boolean): string {
  const fallback = resolveDefaultSettingsPath(canManageAdminSettings);
  if (typeof window === "undefined") return fallback;
  try {
    return normalizeRememberedSettingsPath(
      window.localStorage.getItem(INSTANCE_SETTINGS_MEMORY_KEY),
      canManageAdminSettings,
    );
  } catch {
    return fallback;
  }
}

function readRememberedWorkspacePath(): string {
  if (typeof window === "undefined") return "/dashboard";
  try {
    const stored = window.localStorage.getItem(LAST_WORKSPACE_PATH_KEY);
    if (!stored) return "/dashboard";
    const relativePath = toOrganizationRelativePath(stored);
    if (
      relativePath.startsWith("/instance/")
      || relativePath.startsWith("/organization/settings")
    ) {
      return "/dashboard";
    }
    return relativePath;
  } catch {
    return "/dashboard";
  }
}

export function DesktopSettingsModalFrame({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const mainScrollRef = useScrollbarActivityRef("workspace-main:settings-modal");
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    shellRef.current?.focus();
  }, []);

  return (
    <div
      data-testid="settings-modal-backdrop"
      className="settings-modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-3 py-4 md:px-4 md:py-6"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <div
        data-testid="settings-modal-shell"
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("common.systemSettings")}
        tabIndex={-1}
        className="settings-modal-shell flex min-h-0 w-full max-w-[1100px] overflow-hidden rounded-[12px]"
        onClick={(event) => event.stopPropagation()}
      >
        <SettingsSidebar showBackButton={false} variant="modal" />
        <section className="settings-modal-main flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center justify-end px-3">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onClose}
              aria-label={t("common.closeSidebar")}
              title={t("common.closeSidebar")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <main
            id="main-content"
            tabIndex={-1}
            ref={mainScrollRef}
            className="scrollbar-auto-hide min-w-0 flex-1 overflow-auto px-2.5 pb-2.5 md:px-3 md:pb-3"
          >
            {children}
          </main>
        </section>
      </div>
    </div>
  );
}

function isMacDesktopShell(): boolean {
  if (typeof window === "undefined") return false;
  if (!("desktopShell" in window) || !window.desktopShell) return false;
  return /Mac/i.test(window.navigator.userAgent);
}

function getWorkspaceColumnFamily(relativePath: string): WorkspaceColumnFamily | null {
  if (/^\/chat(?:\/|$)/.test(relativePath)) return "chat";
  if (/^\/messenger(?:\/|$)/.test(relativePath)) return "messenger";
  if (/^\/issues(?:\/|$)/.test(relativePath)) return "issues";
  if (/^\/projects(?:\/|$)/.test(relativePath)) return "org";
  if (/^\/agents(?:\/|$)/.test(relativePath)) return "agents";
  if (/^\/(?:org|resources|heartbeats|workspaces|goals|skills|costs|activity)(?:\/|$)/.test(relativePath)) return "org";
  return null;
}

function clampWorkspaceColumnWidth(family: WorkspaceColumnFamily, value: number): number {
  const { min, max } = WORKSPACE_COLUMN_WIDTH_LIMITS[family];
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readRememberedWorkspaceColumnWidth(family: WorkspaceColumnFamily): number {
  const fallback = WORKSPACE_COLUMN_WIDTH_DEFAULTS[family];
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(`${WORKSPACE_COLUMN_WIDTH_KEY_PREFIX}.${family}`);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return clampWorkspaceColumnWidth(family, parsed);
  } catch {
    return fallback;
  }
}

export function Layout() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile } = useSidebar();
  const { openNewIssue, openOnboarding } = useDialog();
  const { togglePanelVisible } = usePanel();
  const {
    organizations,
    loading: organizationsLoading,
    selectedOrganization,
    selectedOrganizationId,
    selectionSource,
    setSelectedOrganizationId,
  } = useOrganization();
  const { orgPrefix } = useParams<{ orgPrefix: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const macDesktopShell = useMemo(() => isMacDesktopShell(), []);
  const isInstanceSettingsRoute = location.pathname.startsWith("/instance/");
  const relativeBoardPath = useMemo(
    () => toOrganizationRelativePath(location.pathname),
    [location.pathname],
  );
  const workspaceColumnFamily = useMemo(
    () => getWorkspaceColumnFamily(relativeBoardPath),
    [relativeBoardPath],
  );
  const useMiddleContextColumn = useMemo(
    () => /^\/(?:chat|messenger|issues|agents|projects|org|resources|heartbeats|workspaces|goals|skills|costs|activity)(?:\/|$)/.test(relativeBoardPath),
    [relativeBoardPath],
  );
  const isChatRoute = useMemo(() => /^\/chat(?:\/|$)/.test(relativeBoardPath), [relativeBoardPath]);
  const isProjectsRoute = useMemo(() => /^\/projects(?:\/|$)/.test(relativeBoardPath), [relativeBoardPath]);
  const hasActiveChatConversation = useMemo(
    () => /\/chat\/[^/]+/.test(relativeBoardPath),
    [relativeBoardPath],
  );
  const isOrganizationSettingsRoute = useMemo(
    () => /^\/organization\/settings(?:\/|$)/.test(relativeBoardPath),
    [relativeBoardPath],
  );
  const settingsOverlayBackgroundPath = useMemo(
    () => readSettingsOverlayBackgroundPath(location.state),
    [location.state],
  );
  const settingsOverlayState = useMemo(
    () => buildSettingsOverlayState(location),
    [location],
  );
  const isSettingsRoute = isInstanceSettingsRoute || isOrganizationSettingsRoute;
  const onboardingTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);
  const [mobileNavVisible, setMobileNavVisible] = useState(true);
  const [contextColumnWidth, setContextColumnWidth] = useState<number>(() =>
    workspaceColumnFamily ? readRememberedWorkspaceColumnWidth(workspaceColumnFamily) : WORKSPACE_COLUMN_WIDTH_DEFAULTS.issues,
  );
  const [resizingColumn, setResizingColumn] = useState(false);
  const mainScrollRef = useScrollbarActivityRef(`workspace-main:${relativeBoardPath}`);
  const { data: currentBoardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const canManageAdminSettings = currentBoardAccess?.isInstanceAdmin === true;
  const [settingsTarget, setSettingsTarget] = useState<string>(() =>
    readRememberedSettingsPath(false),
  );
  const matchedOrganization = useMemo(() => {
    if (!orgPrefix) return null;
    return findOrganizationByPrefix({
      organizations,
      organizationPrefix: orgPrefix,
    });
  }, [organizations, orgPrefix]);
  const hasUnknownOrganizationPrefix =
    Boolean(orgPrefix) && !organizationsLoading && organizations.length > 0 && !matchedOrganization;
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as { devServer?: { enabled?: boolean } } | undefined;
      return data?.devServer?.enabled ? 2000 : false;
    },
    refetchIntervalInBackground: true,
  });
  const { data: activeChats } = useQuery({
    queryKey: queryKeys.chats.list(selectedOrganizationId ?? "__none__", "active"),
    queryFn: () => chatsApi.list(selectedOrganizationId!),
    enabled: isChatRoute && !!selectedOrganizationId,
  });
  const { data: visibleProjects } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId ?? "__none__"),
    queryFn: async () => {
      const all = await projectsApi.list(selectedOrganizationId!);
      return all.filter((project) => !project.archivedAt);
    },
    enabled: isProjectsRoute && !!selectedOrganizationId,
  });
  const showMiddleContextColumn = useMemo(() => {
    if (!useMiddleContextColumn) return false;
    if (!isChatRoute) return true;
    return hasActiveChatConversation || (activeChats?.length ?? 0) > 0;
  }, [activeChats?.length, hasActiveChatConversation, isChatRoute, useMiddleContextColumn]);
  const effectiveShowMiddleContextColumn = useMemo(() => {
    if (!showMiddleContextColumn) return false;
    if (!isProjectsRoute) return true;
    const isProjectsIndex = /^\/projects(?:\/|$)/.test(relativeBoardPath) && !/^\/projects\/[^/]+/.test(relativeBoardPath);
    if (!isProjectsIndex) return true;
    return (visibleProjects?.length ?? 0) > 0;
  }, [isProjectsRoute, relativeBoardPath, showMiddleContextColumn, visibleProjects?.length]);

  useEffect(() => {
    if (organizationsLoading || onboardingTriggered.current) return;
    if (health?.deploymentMode === "authenticated") return;
    if (organizations.length === 0) {
      onboardingTriggered.current = true;
      openOnboarding();
    }
  }, [organizations, organizationsLoading, openOnboarding, health?.deploymentMode]);

  useEffect(() => {
    if (!orgPrefix || organizationsLoading || organizations.length === 0) return;

    if (!matchedOrganization) {
      const fallback = (selectedOrganizationId ? organizations.find((organization) => organization.id === selectedOrganizationId) : null)
        ?? organizations[0]
        ?? null;
      if (fallback && selectedOrganizationId !== fallback.id) {
        setSelectedOrganizationId(fallback.id, { source: "route_sync" });
      }
      return;
    }

    if (orgPrefix !== matchedOrganization.issuePrefix) {
      const suffix = location.pathname.replace(/^\/[^/]+/, "");
      navigate(`/${matchedOrganization.issuePrefix}${suffix}${location.search}`, { replace: true });
      return;
    }

    if (
      shouldSyncOrganizationSelectionFromRoute({
        selectionSource,
        selectedOrganizationId,
        routeOrganizationId: matchedOrganization.id,
      })
    ) {
      setSelectedOrganizationId(matchedOrganization.id, { source: "route_sync" });
    }
  }, [
    orgPrefix,
    organizations,
    organizationsLoading,
    matchedOrganization,
    location.pathname,
    location.search,
    navigate,
    selectionSource,
    selectedOrganizationId,
    setSelectedOrganizationId,
  ]);

  const togglePanel = togglePanelVisible;

  useOrganizationPageMemory();

  useEffect(() => {
    if (!isMobile) {
      setMobileNavVisible(true);
      return;
    }
    lastMainScrollTop.current = 0;
    setMobileNavVisible(true);
  }, [isMobile]);

  // Swipe gesture to open/close sidebar on mobile
  useEffect(() => {
    if (!isMobile) return;

    const EDGE_ZONE = 30; // px from left edge to start open-swipe
    const MIN_DISTANCE = 50; // minimum horizontal swipe distance
    const MAX_VERTICAL = 75; // max vertical drift before we ignore

    let startX = 0;
    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0]!;
      startX = t.clientX;
      startY = t.clientY;
    };

    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0]!;
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);

      if (dy > MAX_VERTICAL) return; // vertical scroll, ignore

      // Swipe right from left edge → open
      if (!sidebarOpen && startX < EDGE_ZONE && dx > MIN_DISTANCE) {
        setSidebarOpen(true);
        return;
      }

      // Swipe left when open → close
      if (sidebarOpen && dx < -MIN_DISTANCE) {
        setSidebarOpen(false);
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [isMobile, sidebarOpen, setSidebarOpen]);

  const updateMobileNavVisibility = useCallback((currentTop: number) => {
    const delta = currentTop - lastMainScrollTop.current;

    if (currentTop <= 24) {
      setMobileNavVisible(true);
    } else if (delta > 8) {
      setMobileNavVisible(false);
    } else if (delta < -8) {
      setMobileNavVisible(true);
    }

    lastMainScrollTop.current = currentTop;
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobileNavVisible(true);
      lastMainScrollTop.current = 0;
      return;
    }

    const onScroll = () => {
      updateMobileNavVisibility(window.scrollY || document.documentElement.scrollTop || 0);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, [isMobile, updateMobileNavVisibility]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = isMobile ? "visible" : "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile]);

  useEffect(() => {
    setSettingsTarget(readRememberedSettingsPath(canManageAdminSettings));
  }, [canManageAdminSettings]);

  useEffect(() => {
    if (!workspaceColumnFamily) return;
    setContextColumnWidth(readRememberedWorkspaceColumnWidth(workspaceColumnFamily));
  }, [workspaceColumnFamily]);

  useEffect(() => {
    if (!workspaceColumnFamily) return;
    try {
      window.localStorage.setItem(
        `${WORKSPACE_COLUMN_WIDTH_KEY_PREFIX}.${workspaceColumnFamily}`,
        String(clampWorkspaceColumnWidth(workspaceColumnFamily, contextColumnWidth)),
      );
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [contextColumnWidth, workspaceColumnFamily]);

  useEffect(() => {
    if (isSettingsRoute) return;
    const relativePath = toOrganizationRelativePath(
      `${location.pathname}${location.search}${location.hash}`,
    );
    try {
      window.localStorage.setItem(LAST_WORKSPACE_PATH_KEY, relativePath);
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [isSettingsRoute, location.hash, location.pathname, location.search]);

  useEffect(() => {
    if (!isSettingsRoute) return;

    const nextPath = normalizeRememberedSettingsPath(
      `${location.pathname}${location.search}${location.hash}`,
      canManageAdminSettings,
    );
    setSettingsTarget(nextPath);

    try {
      window.localStorage.setItem(INSTANCE_SETTINGS_MEMORY_KEY, nextPath);
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [canManageAdminSettings, isSettingsRoute, location.hash, location.pathname, location.search]);

  const showDesktopWorkspaceShell = !isMobile && !isSettingsRoute;
  const showIntegratedShellSidebar =
    showDesktopWorkspaceShell && effectiveShowMiddleContextColumn && sidebarOpen;
  const showIntegratedCardHeaders = showDesktopWorkspaceShell;
  const showDesktopSettingsModal = !isMobile && isSettingsRoute;
  const shellMainPaddingClass = showDesktopWorkspaceShell
    ? "px-2 py-1.5 md:px-3.5 md:py-2.5 lg:px-5 lg:py-3"
    : "px-2.5 py-1.5 md:px-3 md:py-2 lg:px-4 lg:py-2.5";

  const warmSettingsEntry = useCallback(() => {
    void prefetchSettingsQueries(queryClient, {
      target: settingsTarget,
      organizationId: selectedOrganizationId,
    });
  }, [queryClient, selectedOrganizationId, settingsTarget]);

  const openSettings = useCallback(() => {
    const currentPath = `${location.pathname}${location.search}${location.hash}`;
    warmSettingsEntry();
    rememberSettingsOverlayBackgroundPath(currentPath);
    navigate(
      settingsTarget,
      settingsOverlayState ? { state: settingsOverlayState } : undefined,
    );
    if (isMobile) setSidebarOpen(false);
  }, [
    isMobile,
    location.hash,
    location.pathname,
    location.search,
    navigate,
    warmSettingsEntry,
    setSidebarOpen,
    settingsOverlayState,
    settingsTarget,
  ]);

  useKeyboardShortcuts({
    onNewIssue: () => openNewIssue(),
    onToggleSidebar: toggleSidebar,
    onTogglePanel: togglePanel,
    onOpenSettings: () => openSettings(),
  });

  const desktopContentShellInsetClass = macDesktopShell
    ? "h-full flex-1 pl-2.5 pb-1 pr-1 pt-0.5 md:pl-3 md:pb-1.5 md:pr-1.5 md:pt-1"
    : "h-full flex-1 pl-0 pb-1 pr-1 pt-0.5 md:pb-1.5 md:pr-1.5 md:pt-1";
  function closeSettingsModal() {
    clearStoredSettingsOverlayBackgroundPath();
    navigate(settingsOverlayBackgroundPath ?? readRememberedWorkspacePath(), { replace: true });
  }

  const startContextColumnResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!workspaceColumnFamily || isMobile) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = contextColumnWidth;
    const cleanupStyle = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizingColumn(true);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      setContextColumnWidth(clampWorkspaceColumnWidth(workspaceColumnFamily, startWidth + deltaX));
    };

    const stopResizing = () => {
      document.body.style.cursor = cleanupStyle.cursor;
      document.body.style.userSelect = cleanupStyle.userSelect;
      setResizingColumn(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResizing);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResizing, { once: true });
  }, [contextColumnWidth, isMobile, workspaceColumnFamily]);

  return (
    <div
      className={cn(
        "app-shell-backdrop text-foreground pt-[env(safe-area-inset-top)]",
        isMobile ? "min-h-dvh" : "flex h-dvh flex-col overflow-hidden",
      )}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("common.skipToMainContent")}
      </a>
      <WorktreeBanner />
      <DevRestartBanner devServer={health?.devServer} />
      <div className={cn("min-h-0 flex-1", isMobile ? "w-full" : "flex overflow-hidden")}>
        {isMobile && sidebarOpen && (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-[rgb(23_17_11/0.28)] backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
            aria-label={t("common.closeSidebar")}
          />
        )}

        {isMobile ? (
          <div
            className={cn(
              "fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] transition-transform duration-100 ease-out",
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            )}
          >
            <div className="flex flex-1 min-h-0 overflow-hidden">
              {isInstanceSettingsRoute
                ? <SettingsSidebar />
                : isOrganizationSettingsRoute
                  ? <SettingsSidebar />
                  : <MobileWorkspaceDrawer />}
            </div>
            <div className="editorial-dock px-3 py-3">
              <div className="flex items-center gap-1">
                <a
                  href="https://docs.github.com/Undertone0809/rudder/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-full px-3 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground"
                >
                  <BookOpen className="h-4 w-4 shrink-0" />
                  <span className="truncate">{t("common.documentation")}</span>
                </a>
                {health?.version && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="px-2 text-xs text-muted-foreground shrink-0 cursor-default">v</span>
                    </TooltipTrigger>
                    <TooltipContent>v{health.version}</TooltipContent>
                  </Tooltip>
                )}
                {isSettingsRoute ? (
                  <Button variant="ghost" size="icon-sm" className="text-muted-foreground shrink-0" asChild>
                    <Link
                      to="/dashboard"
                      aria-label={t("common.backToWorkspace")}
                      title={t("common.backToWorkspace")}
                      onClick={() => {
                        if (isMobile) setSidebarOpen(false);
                      }}
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Link>
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="settings-entry-button shrink-0 text-muted-foreground"
                    onPointerEnter={warmSettingsEntry}
                    onFocus={warmSettingsEntry}
                    onPointerDown={warmSettingsEntry}
                    onClick={openSettings}
                    aria-label={t("common.systemSettings")}
                    title={t("common.systemSettings")}
                    data-settings-trigger="true"
                  >
                    <Settings className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className={cn("flex h-full min-h-0 shrink-0", macDesktopShell && "pt-[var(--desktop-sidebar-top-clearance)]")}>
            {isSettingsRoute ? null : (
              <PrimaryRail onOpenSettings={openSettings} onWarmSettings={warmSettingsEntry} />
            )}
          </div>
        )}

        <div
          className={cn(
            "flex min-w-0 flex-col",
            isMobile ? "w-full" : desktopContentShellInsetClass,
          )}
        >
          {!isMobile && macDesktopShell ? <div className="desktop-window-drag h-3 shrink-0" /> : null}
          {showDesktopSettingsModal ? (
            <DesktopSettingsModalFrame onClose={closeSettingsModal}>
              {hasUnknownOrganizationPrefix ? (
                <NotFoundPage
                  scope="invalid_organization_prefix"
                  requestedPrefix={orgPrefix ?? selectedOrganization?.issuePrefix}
                />
              ) : (
                <Outlet />
              )}
            </DesktopSettingsModalFrame>
          ) : (
            <div
              data-testid={isMobile ? undefined : "workspace-shell"}
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                isMobile ? "w-full" : "workspace-shell overflow-hidden",
              )}
            >
              {!showIntegratedCardHeaders ? (
                <div
                  className={cn(
                    isMobile && "sticky top-0 z-20 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/65",
                  )}
                >
                  <BreadcrumbBar desktopChrome={macDesktopShell} />
                </div>
              ) : null}
              <div className={cn(isMobile ? "block" : "flex min-h-0 min-w-0 flex-1")}>
                {showDesktopWorkspaceShell ? (
                  <div className="flex min-h-0 min-w-0 flex-1 px-[3px] pb-[3px] pt-[2px] md:px-1 md:pb-1 md:pt-[3px]">
                    {showIntegratedShellSidebar ? (
                      <>
                        <div
                          data-testid="workspace-context-card"
                          className={cn(
                            "workspace-context-card flex min-h-0 shrink-0 overflow-hidden rounded-[5px]",
                            !resizingColumn && "transition-[width] duration-150 ease-out",
                          )}
                          style={{ width: contextColumnWidth }}
                        >
                          <ThreeColumnContextSidebar />
                        </div>
                        <div
                          data-testid="workspace-column-resizer"
                          className={cn(
                            "workspace-column-resizer group flex w-2 shrink-0 cursor-col-resize items-stretch justify-center md:w-[9px]",
                            resizingColumn && "is-resizing",
                          )}
                          onPointerDown={startContextColumnResize}
                          role="separator"
                          aria-orientation="vertical"
                          aria-label="Resize workspace columns"
                        >
                          <div className="workspace-column-resizer-line" />
                        </div>
                      </>
                    ) : null}
                    <div
                      data-testid="workspace-main-card"
                      className="workspace-main-card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[5px]"
                    >
                      <div data-testid="workspace-main-header" className="shrink-0">
                        <BreadcrumbBar desktopChrome={macDesktopShell} variant="card" />
                      </div>
                      <main
                        id="main-content"
                        tabIndex={-1}
                        ref={mainScrollRef}
                        className={cn(
                          "scrollbar-auto-hide min-w-0 flex-1",
                          shellMainPaddingClass,
                          isMobile ? "overflow-visible pb-[calc(5rem+env(safe-area-inset-bottom))]" : "overflow-auto",
                        )}
                      >
                        {hasUnknownOrganizationPrefix ? (
                          <NotFoundPage
                            scope="invalid_organization_prefix"
                            requestedPrefix={orgPrefix ?? selectedOrganization?.issuePrefix}
                          />
                        ) : (
                          <Outlet />
                        )}
                      </main>
                    </div>
                  </div>
                ) : (
                  <main
                    id="main-content"
                    tabIndex={-1}
                    ref={mainScrollRef}
                    className={cn(
                      "scrollbar-auto-hide min-w-0 flex-1",
                      shellMainPaddingClass,
                      isMobile ? "overflow-visible pb-[calc(5rem+env(safe-area-inset-bottom))]" : "overflow-auto",
                    )}
                  >
                    {hasUnknownOrganizationPrefix ? (
                      <NotFoundPage
                        scope="invalid_organization_prefix"
                        requestedPrefix={orgPrefix ?? selectedOrganization?.issuePrefix}
                      />
                    ) : (
                      <Outlet />
                    )}
                  </main>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {isMobile && <MobileBottomNav visible={mobileNavVisible} />}
      <CommandPalette />
      <NewIssueDialog />
      <NewProjectDialog />
      <NewGoalDialog />
      <NewAgentDialog />
      <ToastViewport />
    </div>
  );
}
