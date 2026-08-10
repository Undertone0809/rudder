import { MobileWorkspaceDrawer } from "@/components/MobileWorkspaceDrawer";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CalendarWorkspaceProvider } from "@/context/CalendarWorkspaceContext";
import { useI18n } from "@/context/I18nContext";
import { MarkdownMentionsProvider } from "@/context/MarkdownMentionsContext";
import {
  useSidePanel,
  type DisplayedSidePanelContextHold,
} from "@/context/SidePanelContext";
import { Link, Outlet, useLocation, useNavigate, useNavigationType, useParams } from "@/lib/router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, PanelLeft, PanelRight, Settings, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { accessApi } from "../api/access";
import { chatsApi } from "../api/chats";
import { healthApi } from "../api/health";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { useDialog } from "../context/DialogContext";
import { NavigationBackProvider } from "../context/NavigationBackContext";
import { useOrganization } from "../context/OrganizationContext";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useToast } from "../context/ToastContext";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useOrganizationPageMemory } from "../hooks/useOrganizationPageMemory";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import {
  normalizeRememberedSettingsPath,
  resolveDefaultSettingsPath,
} from "../lib/instance-settings";
import { resolveInAppBackStackTargetIndex } from "../lib/navigation-back-stack";
import { DEFAULT_ORGANIZATION_HOME_PATH, findOrganizationByPrefix, getOrganizationRouteKey, isLegacyOrganizationSettingsRedirectPath, toOrganizationRelativePath } from "../lib/organization-routes";
import { shouldSyncOrganizationSelectionFromRoute } from "../lib/organization-selection";
import { rememberPrimaryRailPath } from "../lib/primary-rail-memory";
import { RUDDER_DOCS_URL } from "../lib/product-links";
import { queryKeys } from "../lib/queryKeys";
import {
  buildSettingsOverlayState,
  clearStoredSettingsOverlayBackgroundPath,
  readSettingsOverlayBackgroundPath,
  rememberSettingsOverlayBackgroundPath,
} from "../lib/settings-overlay-state";
import { scheduleSettingsPrefetchQueries } from "../lib/settings-prefetch";
import { cn } from "../lib/utils";
import { ChatSidePanel } from "../pages/Chat.side-panel";
import { NotFoundPage } from "../pages/NotFound";
import { OrganizationWorkspaceFilesSidebar } from "../pages/organization-workspaces/OrganizationWorkspaceFilesSidebar";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { CommandPalette } from "./CommandPalette";
import { DevRestartBanner } from "./DevRestartBanner";
import { MobileBottomNav } from "./MobileBottomNav";
import { NewAgentDialog } from "./NewAgentDialog";
import { NewGoalDialog } from "./NewGoalDialog";
import { NewIssueDialog } from "./NewIssueDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { PrimaryRail } from "./PrimaryRail";
import { hasCompletedProductTour, hasPendingProductTour } from "./ProductTourOverlay";
import { SettingsSidebar } from "./SettingsSidebar";
import { ThreeColumnContextSidebar } from "./ThreeColumnContextSidebar";
import { WorkspaceBackupFilesSidebar } from "./WorkspaceBackupFilesSidebar";
import { WorktreeBanner } from "./WorktreeBanner";
import { startSidePanelResizeLifecycle, type SidePanelResizeMoveEvent } from "./side-panel-resize-lifecycle";

const INSTANCE_SETTINGS_MEMORY_KEY = "rudder.lastInstanceSettingsPath";
const LAST_WORKSPACE_PATH_KEY = "rudder.lastWorkspacePath";
const WORKSPACE_COLUMN_WIDTH_KEY_PREFIX = "rudder.workspace.contextWidth";
const SIDE_PANEL_WIDTH_KEY = "rudder.workspace.sidePanelWidth.v2";
const SIDE_PANEL_DEFAULT_WIDTH = 420;
const SIDE_PANEL_MIN_WIDTH = 340;
const SIDE_PANEL_COLLAPSE_WIDTH = 292;
const SIDE_PANEL_COLLAPSE_GAP = SIDE_PANEL_MIN_WIDTH - SIDE_PANEL_COLLAPSE_WIDTH;
const SIDE_PANEL_RESIZER_WIDTH = 4;
const SIDE_PANEL_RESIZER_HIT_WIDTH = 10;

type WorkspaceColumnFamily = "apps" | "chat" | "messenger" | "issues" | "calendar" | "projects" | "agents" | "org" | "backups";

const WORKSPACE_COLUMN_WIDTH_DEFAULTS: Record<WorkspaceColumnFamily, number> = {
  apps: 268,
  chat: 318,
  messenger: 332,
  issues: 248,
  calendar: 268,
  projects: 268,
  agents: 268,
  org: 248,
  backups: 332,
};

const WORKSPACE_COLUMN_WIDTH_LIMITS: Record<WorkspaceColumnFamily, { min: number; max: number; maxViewportFraction?: number }> = {
  apps: { min: 236, max: 360 },
  chat: { min: 280, max: 420 },
  messenger: { min: 280, max: 420 },
  issues: { min: 220, max: 340, maxViewportFraction: 1 / 3 },
  calendar: { min: 236, max: 360 },
  projects: { min: 236, max: 360 },
  agents: { min: 236, max: 360 },
  org: { min: 220, max: 340 },
  backups: { min: 280, max: 420 },
};

function readRememberedSettingsPath(
  canManageAdminSettings: boolean,
  deploymentMode: "local_trusted" | "authenticated" = "authenticated",
): string {
  const fallback = resolveDefaultSettingsPath(canManageAdminSettings);
  if (typeof window === "undefined") return fallback;
  try {
    return normalizeRememberedSettingsPath(
      window.localStorage.getItem(INSTANCE_SETTINGS_MEMORY_KEY),
      canManageAdminSettings,
      deploymentMode,
    );
  } catch {
    return fallback;
  }
}

function readRememberedWorkspacePath(): string {
  if (typeof window === "undefined") return DEFAULT_ORGANIZATION_HOME_PATH;
  try {
    const stored = window.localStorage.getItem(LAST_WORKSPACE_PATH_KEY);
    if (!stored) return DEFAULT_ORGANIZATION_HOME_PATH;
    const relativePath = toOrganizationRelativePath(stored);
    if (
      relativePath.startsWith("/instance/")
      || relativePath.startsWith("/organization/settings")
      || isLegacyOrganizationSettingsRedirectPath(relativePath)
    ) {
      return DEFAULT_ORGANIZATION_HOME_PATH;
    }
    return relativePath;
  } catch {
    return DEFAULT_ORGANIZATION_HOME_PATH;
  }
}

function getLocationPath(location: { pathname: string; search: string; hash: string }): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function hasBrowserBackStackEntry() {
  if (typeof window === "undefined") return false;
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof index === "number" && index > 0;
}

export function DesktopSettingsModalFrame({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { isMobile } = useSidebar();
  const location = useLocation();
  const [settingsNavigationOpen, setSettingsNavigationOpen] = useState(false);
  const mainScrollRef = useScrollbarActivityRef("workspace-main:settings-modal");
  const settingsNavigationCloseRef = useRef<HTMLButtonElement | null>(null);
  const settingsNavigationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const restoreSettingsFocus = useCallback(() => {
    const fallbackTrigger = Array.from(
      document.querySelectorAll<HTMLElement>('[data-settings-trigger="true"]'),
    ).find((element) => element.getClientRects().length > 0 && !element.closest("[inert]"));
    const previouslyFocused = previouslyFocusedRef.current;
    const restoreTarget = previouslyFocused
      && previouslyFocused !== document.body
      && previouslyFocused !== document.documentElement
      && previouslyFocused.isConnected
      && !previouslyFocused.closest("[inert]")
      ? previouslyFocused
      : fallbackTrigger;
    restoreTarget?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const outsideElements = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
    const animationFrame = window.requestAnimationFrame(() => {
      const backdrop = backdropRef.current;
      const shell = shellRef.current;
      if (!backdrop || !shell) return;

      let current: HTMLElement | null = shell;
      while (current.parentElement) {
        for (const sibling of Array.from(current.parentElement.children)) {
          if (!(sibling instanceof HTMLElement) || outsideElements.has(sibling)) continue;
          if (
            sibling === current
            || sibling === backdrop
            || sibling.contains(shell)
            || sibling.contains(backdrop)
          ) continue;
          outsideElements.set(sibling, {
            inert: sibling.inert,
            ariaHidden: sibling.getAttribute("aria-hidden"),
          });
          sibling.inert = true;
          sibling.setAttribute("aria-hidden", "true");
        }
        current = current.parentElement;
        if (current === document.body) break;
      }
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      for (const [element, previous] of outsideElements) {
        element.inert = previous.inert;
        if (previous.ariaHidden === null) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", previous.ariaHidden);
        }
      }
    };
  }, []);

  useEffect(() => {
    if (isMobile) setSettingsNavigationOpen(false);
  }, [isMobile, location.pathname]);

  useEffect(() => {
    if (!isMobile) return;
    if (settingsNavigationOpen) {
      settingsNavigationCloseRef.current?.focus();
    } else {
      settingsNavigationTriggerRef.current?.focus();
    }
  }, [isMobile, settingsNavigationOpen]);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          ref={backdropRef}
          data-testid="settings-modal-backdrop"
          className="settings-modal-backdrop fixed inset-0 z-50"
        />
        <DialogPrimitive.Content
          data-testid="settings-modal-shell"
          ref={shellRef}
          aria-describedby={undefined}
          tabIndex={-1}
          className="settings-modal-shell fixed left-1/2 top-1/2 z-50 flex min-h-0 w-[calc(100%-1rem)] max-w-[1440px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[10px] sm:w-[calc(100%-2rem)]"
          onOpenAutoFocus={(event) => {
            if (!isMobile) return;
            event.preventDefault();
            settingsNavigationTriggerRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreSettingsFocus();
          }}
          onEscapeKeyDown={(event) => {
            if (!isMobile || !settingsNavigationOpen) return;
            event.preventDefault();
            setSettingsNavigationOpen(false);
          }}
      >
        <DialogPrimitive.Title className="sr-only">
          {t("common.systemSettings")}
        </DialogPrimitive.Title>
        {isMobile && settingsNavigationOpen ? (
          <div
            aria-hidden="true"
            className="absolute inset-0 z-10 bg-foreground/10 backdrop-blur-[1px]"
            onClick={() => setSettingsNavigationOpen(false)}
          />
        ) : null}
        <div
          id="settings-modal-navigation"
          data-testid="settings-modal-navigation"
          aria-hidden={isMobile && !settingsNavigationOpen}
          inert={isMobile && !settingsNavigationOpen ? true : undefined}
          className={cn(
            "z-20 flex h-full min-h-0 shrink-0",
            isMobile
              ? "absolute inset-y-0 left-0 transition-transform duration-200 ease-out motion-reduce:transition-none"
              : "relative",
            isMobile && !settingsNavigationOpen && "pointer-events-none -translate-x-full",
          )}
          onClickCapture={(event) => {
            if (isMobile && (event.target as Element).closest("a")) {
              setSettingsNavigationOpen(false);
            }
          }}
        >
          {isMobile && settingsNavigationOpen ? (
            <Button
              ref={settingsNavigationCloseRef}
              variant="ghost"
              size="icon-sm"
              className="absolute right-1 top-1 z-10 size-8 rounded-full text-muted-foreground"
              onClick={() => setSettingsNavigationOpen(false)}
              aria-label={`${t("common.closeSidebar")} (${t("common.systemSettings")})`}
              title={t("common.closeSidebar")}
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
          <SettingsSidebar showBackButton={false} variant="modal" />
        </div>
        <section
          className="settings-modal-main flex min-h-0 min-w-0 flex-1 flex-col"
          inert={isMobile && settingsNavigationOpen ? true : undefined}
        >
          <div className="flex h-14 shrink-0 items-center justify-between px-3 sm:px-5">
            {isMobile ? (
              <Button
                ref={settingsNavigationTriggerRef}
                variant="ghost"
                size="icon-sm"
                className="size-8 rounded-full text-muted-foreground"
                onClick={() => setSettingsNavigationOpen(true)}
                aria-expanded={settingsNavigationOpen}
                aria-controls="settings-modal-navigation"
                aria-label={t("common.openSidebar")}
                title={t("common.openSidebar")}
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
            ) : <span />}
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-8 rounded-full text-muted-foreground"
              onClick={onClose}
              aria-label={t("common.closeSettings")}
              title={t("common.closeSettings")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <main
            id="main-content"
            tabIndex={-1}
            ref={mainScrollRef}
            className="scrollbar-auto-hide min-w-0 flex-1 overflow-auto"
          >
            {children}
          </main>
        </section>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function isMacDesktopShell(): boolean {
  if (typeof window === "undefined") return false;
  if (!("desktopShell" in window) || !window.desktopShell) return false;
  return /Mac/i.test(window.navigator.userAgent);
}

function getWorkspaceColumnFamily(relativePath: string): WorkspaceColumnFamily | null {
  if (/^\/apps(?:\/|$)/.test(relativePath)) return "apps";
  if (/^\/workspaces\/backups(?:\/|$)/.test(relativePath)) return "backups";
  if (/^\/chat(?:\/|$)/.test(relativePath)) return "chat";
  if (/^\/messenger(?:\/|$)/.test(relativePath)) return "messenger";
  if (/^\/issues(?:\/|$)/.test(relativePath)) return "issues";
  if (/^\/(?:dashboard\/calendar|calendar)(?:\/|$)/.test(relativePath)) return "calendar";
  if (/^\/projects(?:\/|$)/.test(relativePath)) return "org";
  if (/^\/agents(?:\/|$)/.test(relativePath)) return "agents";
  if (/^\/(?:dashboard|org|library|resources|heartbeats|workspaces|skills|costs|activity)(?:\/|$)/.test(relativePath)) return "org";
  return null;
}

export function shouldUseFramelessWorkspaceMain(relativePath: string): boolean {
  if (/^\/apps(?:\/|$)/.test(relativePath)) return true;
  if (/^\/(?:library|resources|workspaces)(?:\/|$)/.test(relativePath) && !/^\/workspaces\/backups(?:\/|$)/.test(relativePath)) return true;
  if (/^\/automations(?:\/|$)/.test(relativePath)) return true;
  if (/^\/chat(?:\/|$)/.test(relativePath)) return true;
  if (/^\/messenger\/chat(?:\/|$)/.test(relativePath)) return true;
  if (/^\/messenger\/(?:workbench|saved)(?:\/|$)/.test(relativePath)) return true;
  return relativePath === "/messenger";
}

export function shouldAutoCollapseAgentContextSidebar({
  isMobile,
  relativePath,
  sidePanelOpen,
  sidePanelContextReady,
}: {
  isMobile: boolean;
  relativePath: string;
  sidePanelOpen: boolean;
  sidePanelContextReady: boolean;
}): boolean {
  return !isMobile
    && sidePanelOpen
    && sidePanelContextReady
    && /^\/agents\/[^/]+(?:\/|$)/.test(relativePath);
}

function decodeSidePanelRouteSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function resolveSidePanelContextKey(relativePath: string): string | null {
  const segments = relativePath.split("?")[0]?.split("#")[0]?.split("/").filter(Boolean) ?? [];
  if (segments[0] === "messenger" && segments[1] === "chat" && segments[2]) {
    return `chat:${decodeSidePanelRouteSegment(segments[2])}`;
  }
  if (segments[0] === "messenger" && segments[1] === "issues" && segments[2]) {
    return `issue:${decodeSidePanelRouteSegment(segments[2])}`;
  }
  if (segments[0] === "chat" && segments[1]) {
    return `chat:${decodeSidePanelRouteSegment(segments[1])}`;
  }
  if (segments[0] === "agents" && segments[1] && segments[2] === "runs") {
    return `agent-runs:${decodeSidePanelRouteSegment(segments[1])}`;
  }
  return null;
}

export function resolveSidePanelRouteContextKey(
  relativePath: string,
  organizationId: string | null | undefined,
): string {
  return resolveSidePanelContextKey(relativePath)
    ?? (organizationId ? `organization:${organizationId}:global` : "global");
}

export function resolveDisplayedSidePanelContext(
  relativePath: string,
  organizationId: string | null | undefined,
  hold: DisplayedSidePanelContextHold | null,
): { contextKey: string; preserveHold: boolean } {
  const routeContextKey = resolveSidePanelRouteContextKey(relativePath, organizationId);
  const isWorkbenchRoute = /^\/messenger\/(?:workbench(?:\/|$)|saved\/[^/]+(?:\/|$))/.test(
    relativePath.split("?")[0]?.split("#")[0] ?? relativePath,
  );
  const isHoldableContext = hold?.contextKey.startsWith("chat:")
    || hold?.contextKey.startsWith("issue:");
  if (
    (isWorkbenchRoute || routeContextKey === hold?.contextKey)
    && isHoldableContext
    && hold?.organizationId === organizationId
  ) {
    return { contextKey: hold!.contextKey, preserveHold: true };
  }
  return { contextKey: routeContextKey, preserveHold: false };
}

function getCurrentViewportWidth(): number | null {
  if (typeof window === "undefined") return null;
  return window.innerWidth;
}

function useViewportWidth(): number | null {
  const [viewportWidth, setViewportWidth] = useState(getCurrentViewportWidth);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const updateViewportWidth = () => setViewportWidth(getCurrentViewportWidth());
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  return viewportWidth;
}

export function getWorkspaceColumnMaxWidth(family: WorkspaceColumnFamily, viewportWidth: number | null = getCurrentViewportWidth()): number {
  const { max, maxViewportFraction } = WORKSPACE_COLUMN_WIDTH_LIMITS[family];
  if (!maxViewportFraction || viewportWidth === null || !Number.isFinite(viewportWidth)) return max;
  return Math.max(max, Math.floor(viewportWidth * maxViewportFraction));
}

export function clampWorkspaceColumnWidth(
  family: WorkspaceColumnFamily,
  value: number,
  viewportWidth: number | null = getCurrentViewportWidth(),
): number {
  const { min } = WORKSPACE_COLUMN_WIDTH_LIMITS[family];
  const max = getWorkspaceColumnMaxWidth(family, viewportWidth);
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

function getSidePanelGeometry(workspaceWidth: number) {
  const availableWidth = Math.max(0, workspaceWidth - SIDE_PANEL_RESIZER_WIDTH);
  const twoToOneBoundary = availableWidth * (2 / 3);
  return {
    availableWidth,
    dockedMinWidth: Math.min(SIDE_PANEL_MIN_WIDTH, availableWidth / 2),
    dockedMaxWidth: twoToOneBoundary,
  };
}

function clampSidePanelWidth(
  value: number,
  workspaceWidth: number | null = null,
): number {
  const roundedWidth = Math.round(value);
  if (workspaceWidth === null || !Number.isFinite(workspaceWidth)) {
    return Math.max(SIDE_PANEL_MIN_WIDTH, roundedWidth);
  }
  const geometry = getSidePanelGeometry(workspaceWidth);
  return Math.min(geometry.dockedMaxWidth, Math.max(geometry.dockedMinWidth, roundedWidth));
}

export function resolveProportionalWorkspaceColumnWidth(
  family: WorkspaceColumnFamily,
  widthRatioValue: number,
  viewportWidth: number,
): number {
  return clampWorkspaceColumnWidth(family, widthRatioValue * viewportWidth, viewportWidth);
}

export function resolveProportionalSidePanelWidth(
  widthRatioValue: number,
  workspaceWidth: number,
): number {
  return clampSidePanelWidth(widthRatioValue * workspaceWidth, workspaceWidth);
}

export function resolveDefaultSidePanelWidth(workspaceWidth: number): number {
  return clampSidePanelWidth((workspaceWidth - SIDE_PANEL_RESIZER_WIDTH) / 2, workspaceWidth);
}

export function shouldAutoExpandSidePanel(panelWidth: number, workspaceWidth: number): boolean {
  const { availableWidth } = getSidePanelGeometry(workspaceWidth);
  const mainWidth = availableWidth - panelWidth;
  return panelWidth > 2 * mainWidth;
}

export function resolveSidePanelCollapseWidth(workspaceWidth: number | null): number {
  if (workspaceWidth === null || !Number.isFinite(workspaceWidth)) return SIDE_PANEL_COLLAPSE_WIDTH;
  const { dockedMinWidth } = getSidePanelGeometry(workspaceWidth);
  return Math.max(0, Math.min(SIDE_PANEL_COLLAPSE_WIDTH, dockedMinWidth - SIDE_PANEL_COLLAPSE_GAP));
}

export function resolveSidePanelDragWidth(
  startWidth: number,
  pointerDeltaX: number,
  renderedWorkspaceWidth: number,
  layoutWorkspaceWidth: number,
): number {
  const visualScale = Number.isFinite(renderedWorkspaceWidth)
    && Number.isFinite(layoutWorkspaceWidth)
    && renderedWorkspaceWidth > 0
    && layoutWorkspaceWidth > 0
    ? renderedWorkspaceWidth / layoutWorkspaceWidth
    : 1;
  return startWidth - pointerDeltaX / visualScale;
}

function widthRatio(value: number, widthBase: number | null = getCurrentViewportWidth()): number | null {
  if (widthBase === null || !Number.isFinite(widthBase) || widthBase <= 0) return null;
  return value / widthBase;
}

export function preserveRememberedSidePanelWidth(value: number): number {
  return Math.round(value);
}

function readRememberedSidePanelWidth(): number {
  if (typeof window === "undefined") return SIDE_PANEL_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(SIDE_PANEL_WIDTH_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed)) return SIDE_PANEL_DEFAULT_WIDTH;
    return preserveRememberedSidePanelWidth(parsed);
  } catch {
    return SIDE_PANEL_DEFAULT_WIDTH;
  }
}

function DesktopSidePanelSlot({
  contextReady,
  expanded,
  onExpandedChange,
  selectedOrganizationId,
}: {
  contextReady: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  selectedOrganizationId: string | null | undefined;
}) {
  const sidePanel = useSidePanel();
  const workspaceAnchorRef = useRef<HTMLSpanElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState<number | null>(null);
  const hasRememberedWidthRef = useRef(
    typeof window !== "undefined" && window.localStorage.getItem(SIDE_PANEL_WIDTH_KEY) !== null,
  );
  const widthInitializedRef = useRef(hasRememberedWidthRef.current);
  const [useEqualDefaultWidth, setUseEqualDefaultWidth] = useState(!hasRememberedWidthRef.current);
  const [sidePanelWidth, setSidePanelWidth] = useState(readRememberedSidePanelWidth);
  const sidePanelWidthRatioRef = useRef<number | null>(null);
  const [resizingSidePanel, setResizingSidePanel] = useState(false);
  const sidePanelResizeShieldRef = useRef<HTMLDivElement | null>(null);
  const previousSidePanelOpenRef = useRef(sidePanel.open);
  const sidePanelFocusWithinRef = useRef(false);
  const sidePanelResizeActiveRef = useRef(false);
  const sidePanelResizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !widthInitializedRef.current) return;
    try {
      window.localStorage.setItem(SIDE_PANEL_WIDTH_KEY, String(sidePanelWidth));
    } catch {
      // Ignore storage failures; width falls back to the default next time.
    }
  }, [sidePanelWidth]);

  useLayoutEffect(() => {
    const workspace = workspaceAnchorRef.current?.parentElement;
    if (!workspace) return;
    const updateWorkspaceWidth = () => setWorkspaceWidth(workspace.offsetWidth);
    updateWorkspaceWidth();
    const observer = new ResizeObserver(updateWorkspaceWidth);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (hasRememberedWidthRef.current || workspaceWidth === null) return;
    const defaultWidth = resolveDefaultSidePanelWidth(workspaceWidth);
    sidePanelWidthRatioRef.current = widthRatio(defaultWidth, workspaceWidth);
    setSidePanelWidth(defaultWidth);
  }, [workspaceWidth]);

  useLayoutEffect(() => {
    const wasOpen = previousSidePanelOpenRef.current;
    previousSidePanelOpenRef.current = sidePanel.open;
    if (!wasOpen && sidePanel.open) {
      const frame = window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>("[data-testid='chat-side-panel-collapse']")?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (!wasOpen || sidePanel.open || !sidePanelFocusWithinRef.current) return undefined;
    sidePanelFocusWithinRef.current = false;

    const frame = window.requestAnimationFrame(() => {
      const chatTrigger = document.querySelector<HTMLElement>("[data-testid='chat-side-panel-trigger']");
      const globalTrigger = document.querySelector<HTMLElement>("[data-testid='global-side-panel-trigger']");
      (chatTrigger ?? globalTrigger)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sidePanel.open]);

  useEffect(() => {
    if (workspaceWidth === null || useEqualDefaultWidth) return;
    const sidePanelWidthRatio = sidePanelWidthRatioRef.current;
    if (sidePanelWidthRatio === null) {
      const clampedWidth = clampSidePanelWidth(sidePanelWidth, workspaceWidth);
      sidePanelWidthRatioRef.current = widthRatio(clampedWidth, workspaceWidth);
      setSidePanelWidth(clampedWidth);
      return;
    }
    setSidePanelWidth(resolveProportionalSidePanelWidth(sidePanelWidthRatio, workspaceWidth));
  }, [useEqualDefaultWidth, workspaceWidth]);

  const setProportionalSidePanelWidth = useCallback((nextWidth: number) => {
    const clampedWidth = clampSidePanelWidth(nextWidth, workspaceWidth);
    sidePanelWidthRatioRef.current = workspaceWidth === null
      ? null
      : widthRatio(clampedWidth, workspaceWidth);
    setSidePanelWidth(clampedWidth);
    return clampedWidth;
  }, [workspaceWidth]);

  const resetSidePanelWidth = useCallback(() => {
    setUseEqualDefaultWidth(true);
    hasRememberedWidthRef.current = false;
    widthInitializedRef.current = false;
    try {
      window.localStorage.removeItem(SIDE_PANEL_WIDTH_KEY);
    } catch {
      // Ignore storage failures; the equal-width default still applies in memory.
    }
    const nextWidth = workspaceWidth === null
      ? SIDE_PANEL_DEFAULT_WIDTH
      : resolveDefaultSidePanelWidth(workspaceWidth);
    return setProportionalSidePanelWidth(nextWidth);
  }, [setProportionalSidePanelWidth, workspaceWidth]);

  const dockedPanelWidth = useEqualDefaultWidth && workspaceWidth !== null
    ? resolveDefaultSidePanelWidth(workspaceWidth)
    : sidePanelWidth;

  useEffect(() => () => {
    sidePanelResizeCleanupRef.current?.();
  }, []);

  const startSidePanelResize = useCallback((event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>) => {
    if (!sidePanel.open || sidePanelResizeActiveRef.current) return;
    event.preventDefault();
    sidePanelResizeActiveRef.current = true;
    setUseEqualDefaultWidth(false);
    hasRememberedWidthRef.current = true;
    widthInitializedRef.current = true;
    const startX = event.clientX;
    const resizeHandle = event.currentTarget.closest<HTMLElement>("[data-testid='side-panel-resizer']") ?? event.currentTarget;
    const resizeWorkspace = workspaceAnchorRef.current?.parentElement;
    const layoutPanelWidth = resizeWorkspace
      ?.querySelector<HTMLElement>("[data-testid='chat-side-panel']")
      ?.offsetWidth ?? null;
    const resizeWorkspaceWidth = resizeWorkspace?.offsetWidth ?? workspaceWidth;
    const renderedWorkspaceWidth = resizeWorkspace?.getBoundingClientRect().width ?? resizeWorkspaceWidth;
    const collapseWidth = resolveSidePanelCollapseWidth(resizeWorkspaceWidth);
    const startWidth = layoutPanelWidth !== null && layoutPanelWidth > 0 ? layoutPanelWidth : dockedPanelWidth;
    const pointerId = "pointerId" in event ? event.pointerId : null;
    let latestWidth = startWidth;
    let collapsedByDrag = false;
    setProportionalSidePanelWidth(startWidth);
    setResizingSidePanel(true);

    let stopResizing = () => {};
    const onPointerMove = (moveEvent: SidePanelResizeMoveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      latestWidth = resolveSidePanelDragWidth(
        startWidth,
        deltaX,
        renderedWorkspaceWidth ?? resizeWorkspaceWidth ?? 0,
        resizeWorkspaceWidth ?? 0,
      );
      if (resizeWorkspaceWidth !== null && shouldAutoExpandSidePanel(latestWidth, resizeWorkspaceWidth)) {
        stopResizing();
        onExpandedChange(true);
        return;
      }
      if (latestWidth <= collapseWidth) {
        collapsedByDrag = true;
        stopResizing();
        sidePanel.hidePanel();
        resetSidePanelWidth();
        return;
      }
      setProportionalSidePanelWidth(latestWidth);
    };

    const lifecycle = startSidePanelResizeLifecycle({
      resizeHandle,
      pointerId,
      onMove: onPointerMove,
      onStop: () => {
        sidePanelResizeCleanupRef.current = null;
        sidePanelResizeActiveRef.current = false; sidePanelResizeShieldRef.current?.classList.add("hidden"); setResizingSidePanel(false);
        if (!collapsedByDrag && latestWidth <= collapseWidth) {
          sidePanel.hidePanel();
          resetSidePanelWidth();
        }
      },
    });
    stopResizing = lifecycle.stop;
    sidePanelResizeCleanupRef.current = lifecycle.isActive() ? stopResizing : null;
    if (lifecycle.isActive()) { flushSync(() => setResizingSidePanel(true)); sidePanelResizeShieldRef.current?.classList.remove("hidden"); }
  }, [dockedPanelWidth, onExpandedChange, resetSidePanelWidth, setProportionalSidePanelWidth, sidePanel, workspaceWidth]);

  const panelVisible = contextReady && sidePanel.open;
  const expandedVisible = contextReady && sidePanel.open && expanded;
  const panelTargetWidth = panelVisible
    ? expandedVisible
      ? workspaceWidth ?? dockedPanelWidth
      : dockedPanelWidth
    : 0;
  const resizerVisible = panelVisible && !expandedVisible;

  return (
    <>
      <span ref={workspaceAnchorRef} className="hidden" aria-hidden="true" />
      {!panelVisible ? <div key="trigger" className="group absolute inset-y-1 right-0 z-20 w-1" data-testid="side-panel-hover-edge">
        <Button
          type="button"
          variant="outline"
          size="icon"
          data-testid="global-side-panel-trigger"
          className="pointer-events-none absolute right-[3px] top-1/2 h-11 w-7 -translate-y-1/2 rounded-l-[calc(var(--radius-sm)-1px)] rounded-r-none border-r-0 bg-[color:var(--surface-elevated)] text-muted-foreground opacity-0 shadow-[var(--shadow-sm)] transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:bg-[color:var(--surface-active)] hover:text-foreground"
          onClick={sidePanel.showPanel}
          aria-label="Open Side Panel"
          title="Open Side Panel"
        >
          <PanelRight className="h-4 w-4" />
        </Button>
      </div> : null}
      <div
        key="resizer"
        data-testid="side-panel-resizer"
        aria-hidden={!resizerVisible}
        className={cn(
          "motion-resize workspace-column-resizer group relative z-[80] flex shrink-0 touch-none select-none items-stretch justify-center",
          resizerVisible ? "cursor-col-resize opacity-100" : "pointer-events-none opacity-0",
          resizingSidePanel && "is-resizing",
        )}
        style={{ width: resizerVisible ? SIDE_PANEL_RESIZER_WIDTH : 0 }}
        onPointerDown={startSidePanelResize}
        onMouseDown={startSidePanelResize}
        role={resizerVisible ? "separator" : undefined} aria-orientation="vertical"
        aria-label={resizerVisible ? "Resize Side Panel" : undefined}
      >
        <span
          data-testid="side-panel-resizer-hit-target"
          className="absolute inset-y-0 right-0"
          style={{ width: SIDE_PANEL_RESIZER_HIT_WIDTH }} aria-hidden="true"
          onPointerDown={(event) => { event.stopPropagation(); startSidePanelResize(event); }}
          onMouseDown={(event) => { event.stopPropagation(); startSidePanelResize(event); }}
        />
        <div className="workspace-column-resizer-line" />
      </div>
      <div ref={sidePanelResizeShieldRef} data-testid="side-panel-resize-shield" className="fixed inset-0 z-[200] hidden cursor-col-resize" aria-hidden="true" />
      <div
        key="panel"
        className={cn(
          "motion-resize relative flex min-h-0 shrink-0 overflow-hidden",
          expandedVisible && "z-30",
          resizingSidePanel && "transition-none",
        )}
        data-testid={expandedVisible ? "side-panel-expanded-overlay" : "side-panel-stable-host"}
        data-side-panel-state={expandedVisible ? "expanded" : panelVisible ? "docked" : "closed"}
        style={{ width: panelTargetWidth }}
        aria-hidden={!panelVisible}
        inert={!panelVisible ? true : undefined}
        onFocusCapture={() => {
          sidePanelFocusWithinRef.current = true;
        }}
        onBlurCapture={(event) => {
          if (sidePanel.open && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
            sidePanelFocusWithinRef.current = false;
          }
        }}
      >
        <ChatSidePanel
          contextReady={contextReady}
          selectedOrganizationId={selectedOrganizationId}
          expanded={expandedVisible}
          onClose={() => {
            if (expanded) {
              onExpandedChange(false);
              resetSidePanelWidth();
            }
            sidePanel.hidePanel();
          }}
          onToggleExpanded={() => {
            if (expanded) {
              onExpandedChange(false);
              resetSidePanelWidth();
            } else {
              onExpandedChange(true);
            }
          }}
        />
      </div>
    </>
  );
}

function SidePanelRouteContextBinder({
  contextKey,
  preserveHold,
}: {
  contextKey: string;
  preserveHold: boolean;
}) {
  const { clearDisplayedContextHold, setContextKey } = useSidePanel();

  useLayoutEffect(() => {
    if (!preserveHold) clearDisplayedContextHold();
    setContextKey(contextKey);
  }, [clearDisplayedContextHold, contextKey, preserveHold, setContextKey]);

  return null;
}

function CollapsedWorkspaceSidebarReveal({
  onOpen,
  alwaysVisible = false,
}: {
  onOpen: () => void;
  alwaysVisible?: boolean;
}) {
  return (
    <div
      data-testid="workspace-sidebar-reopen-zone"
      className="group absolute left-0 top-0 z-30 flex w-8 items-start"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            data-testid="workspace-sidebar-reopen-button"
            className={cn(
              "desktop-window-no-drag h-10 w-7 shrink-0 rounded-l-none rounded-r-[calc(var(--radius-sm)-1px)] border-l-0 bg-[color:var(--surface-elevated)] text-muted-foreground shadow-[var(--shadow-sm)] transition-[background-color,color,opacity,transform] duration-[var(--motion-duration-fast)] ease-[var(--motion-ease-standard)] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none",
              alwaysVisible
                ? "pointer-events-auto translate-x-0 opacity-100"
                : "pointer-events-none -translate-x-1/2 opacity-0 group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100",
            )}
            onClick={onOpen}
            aria-label="Open workspace sidebar"
            title="Open workspace sidebar"
          >
            <PanelLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Open workspace sidebar</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function Layout() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile } = useSidebar();
  const {
    openNewIssue,
    openOnboarding,
    onboardingOpen,
    productTourOpen,
    openProductTour,
  } = useDialog();
  const { togglePanelVisible } = usePanel();
  const {
    contextKey: sidePanelContextKey,
    displayedContextHold,
    open: sidePanelOpen,
  } = useSidePanel();
  const {
    organizations,
    loading: organizationsLoading,
    selectedOrganization,
    selectedOrganizationId,
    selectionSource,
    setSelectedOrganizationId,
  } = useOrganization();
  const { pushToast } = useToast();
  const { orgPrefix } = useParams<{ orgPrefix: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const inAppBackStackRef = useRef<string[]>([]);
  const macDesktopShell = useMemo(() => isMacDesktopShell(), []);
  const isInstanceSettingsRoute = location.pathname.startsWith("/instance/");
  const relativeBoardPath = useMemo(
    () => toOrganizationRelativePath(location.pathname),
    [location.pathname],
  );
  const relativeBoardUrl = useMemo(
    () => `${relativeBoardPath}${location.search}${location.hash}`,
    [location.hash, location.search, relativeBoardPath],
  );
  const workspaceColumnFamily = useMemo(
    () => getWorkspaceColumnFamily(relativeBoardPath),
    [relativeBoardPath],
  );
  const useMiddleContextColumn = useMemo(
    () =>
      !/^\/apps\/saved\/[^/]+(?:\/|$)/.test(relativeBoardPath)
      && /^\/(?:apps|chat|messenger|issues|calendar|dashboard|agents|projects|org|library|resources|heartbeats|workspaces|skills|costs|activity)(?:\/|$)/.test(relativeBoardPath),
    [relativeBoardPath],
  );
  const isWorkspaceBackupsRoute = useMemo(
    () => /^\/workspaces\/backups(?:\/|$)/.test(relativeBoardPath),
    [relativeBoardPath],
  );
  const isLibraryRoute = useMemo(
    () => /^\/(?:library|resources|workspaces)(?:\/|$)/.test(relativeBoardPath) && !/^\/workspaces\/backups(?:\/|$)/.test(relativeBoardPath),
    [relativeBoardPath],
  );
  const isChatRoute = useMemo(() => /^\/chat(?:\/|$)/.test(relativeBoardPath), [relativeBoardPath]);
  const isMessengerRoute = useMemo(() => /^\/messenger(?:\/|$)/.test(relativeBoardPath), [relativeBoardPath]);
  const useFramelessWorkspaceMain = useMemo(
    () => shouldUseFramelessWorkspaceMain(relativeBoardPath),
    [relativeBoardPath],
  );
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
  const productTourTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);
  const viewportWidth = useViewportWidth();
  const [mobileNavVisible, setMobileNavVisible] = useState(true);
  const [contextColumnWidth, setContextColumnWidth] = useState<number>(() =>
    workspaceColumnFamily ? readRememberedWorkspaceColumnWidth(workspaceColumnFamily) : WORKSPACE_COLUMN_WIDTH_DEFAULTS.issues,
  );
  const contextColumnWidthRatioRef = useRef(widthRatio(contextColumnWidth));
  const [resizingColumn, setResizingColumn] = useState(false);
  const [desktopSidePanelExpanded, setDesktopSidePanelExpanded] = useState(false);
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
  const displayedSidePanelContext = resolveDisplayedSidePanelContext(
    relativeBoardPath,
    matchedOrganization?.id,
    displayedContextHold,
  );
  const sidePanelContextReady = sidePanelContextKey === displayedSidePanelContext.contextKey;
  const sidePanelOrganizationId = sidePanelContextReady ? matchedOrganization?.id : null;
  const autoCollapseAgentContextSidebar = shouldAutoCollapseAgentContextSidebar({
    isMobile,
    relativePath: relativeBoardPath,
    sidePanelOpen,
    sidePanelContextReady,
  });
  const contextSidebarVisible = sidebarOpen && !autoCollapseAgentContextSidebar;
  const desktopSidePanelContentInactive = sidePanelContextReady
    && sidePanelOpen
    && desktopSidePanelExpanded;
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
    queryKey: queryKeys.chats.listPreview(selectedOrganizationId ?? "__none__", "active", 40),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "active", { limit: 40 }),
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
    if (productTourTriggered.current || productTourOpen || onboardingOpen) return;
    if (organizationsLoading || organizations.length === 0) return;
    if (isSettingsRoute || relativeBoardPath === "/onboarding") return;
    if (hasCompletedProductTour() || !hasPendingProductTour()) return;

    productTourTriggered.current = true;
    openProductTour({ source: "auto" });
  }, [
    isSettingsRoute,
    onboardingOpen,
    openProductTour,
    organizations.length,
    organizationsLoading,
    productTourOpen,
    relativeBoardPath,
  ]);

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

    const canonicalRouteKey = getOrganizationRouteKey(matchedOrganization);
    if (orgPrefix.toLowerCase() !== canonicalRouteKey.toLowerCase()) {
      const suffix = location.pathname.replace(/^\/[^/]+/, "");
      navigate(`/${canonicalRouteKey}${suffix}${location.search}`, { replace: true });
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

  useLayoutEffect(() => {
    setDesktopSidePanelExpanded(false);
  }, [matchedOrganization?.id]);

  useLayoutEffect(() => {
    if (!sidePanelContextReady) setDesktopSidePanelExpanded(false);
  }, [sidePanelContextReady]);

  useLayoutEffect(() => {
    if (!sidePanelOpen) setDesktopSidePanelExpanded(false);
  }, [sidePanelOpen]);

  useEffect(() => {
    rememberPrimaryRailPath(matchedOrganization?.id, relativeBoardUrl);
  }, [matchedOrganization?.id, relativeBoardUrl]);

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
    let gestureIgnored = false;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0]!;
      startX = t.clientX;
      startY = t.clientY;
      const target = e.target instanceof Element ? e.target : null;
      gestureIgnored = Boolean(
        target?.closest('[data-slot="dialog-content"], [data-slot="dialog-overlay"], [data-testid="chat-side-panel"]'),
      );
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (gestureIgnored) {
        gestureIgnored = false;
        return;
      }
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
    setSettingsTarget(readRememberedSettingsPath(
      canManageAdminSettings,
      health?.deploymentMode ?? "authenticated",
    ));
  }, [canManageAdminSettings, health?.deploymentMode]);

  useEffect(() => {
    if (!workspaceColumnFamily) return;
    const rememberedWidth = readRememberedWorkspaceColumnWidth(workspaceColumnFamily);
    contextColumnWidthRatioRef.current = widthRatio(rememberedWidth);
    setContextColumnWidth(rememberedWidth);
  }, [workspaceColumnFamily]);

  useEffect(() => {
    if (!workspaceColumnFamily) return;
    if (viewportWidth === null || !Number.isFinite(viewportWidth)) return;
    const contextColumnWidthRatio = contextColumnWidthRatioRef.current;
    if (contextColumnWidthRatio === null) {
      contextColumnWidthRatioRef.current = widthRatio(contextColumnWidth, viewportWidth);
      return;
    }
    setContextColumnWidth(resolveProportionalWorkspaceColumnWidth(workspaceColumnFamily, contextColumnWidthRatio, viewportWidth));
  }, [viewportWidth, workspaceColumnFamily]);

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
    if (isLegacyOrganizationSettingsRedirectPath(relativePath)) return;
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
      health?.deploymentMode ?? "authenticated",
    );
    setSettingsTarget(nextPath);

    try {
      window.localStorage.setItem(INSTANCE_SETTINGS_MEMORY_KEY, nextPath);
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [canManageAdminSettings, health?.deploymentMode, isSettingsRoute, location.hash, location.pathname, location.search]);

  const showDesktopWorkspaceShell = !isMobile && !isSettingsRoute;
  const showIntegratedShellSidebar =
    showDesktopWorkspaceShell && effectiveShowMiddleContextColumn;
  const showIntegratedCardHeaders = showDesktopWorkspaceShell;
  const showDesktopSettingsModal = !isMobile && isSettingsRoute;
  const shellMainPaddingClass = showDesktopWorkspaceShell
    ? useFramelessWorkspaceMain
      ? "p-0"
      : "px-2 py-1.5 md:px-3.5 md:py-2.5 lg:px-5 lg:py-3"
    : "px-2.5 py-1.5 md:px-3 md:py-2 lg:px-4 lg:py-2.5";

  const warmSettingsEntry = useCallback(() => {
    scheduleSettingsPrefetchQueries(queryClient, {
      target: settingsTarget,
      organizationId: selectedOrganizationId,
    });
  }, [queryClient, selectedOrganizationId, settingsTarget]);

  const openSettings = useCallback(() => {
    const currentPath = `${location.pathname}${location.search}${location.hash}`;
    rememberSettingsOverlayBackgroundPath(currentPath);
    navigate(
      settingsTarget,
      settingsOverlayState ? { state: settingsOverlayState } : undefined,
    );
    warmSettingsEntry();
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

  useEffect(() => {
    const currentPath = getLocationPath(location);
    const stack = inAppBackStackRef.current;
    if (stack.length === 0) {
      stack.push(currentPath);
      return;
    }

    const currentIndex = stack.lastIndexOf(currentPath);
    if (navigationType === "POP") {
      if (currentIndex >= 0) {
        stack.splice(currentIndex + 1);
      } else {
        stack.push(currentPath);
      }
      return;
    }

    if (navigationType === "REPLACE") {
      stack[stack.length - 1] = currentPath;
      return;
    }

    if (stack[stack.length - 1] !== currentPath) {
      stack.push(currentPath);
    }
    if (stack.length > 50) stack.splice(0, stack.length - 50);
  }, [location, navigationType]);

  const navigateBack = useCallback(() => {
    const stack = inAppBackStackRef.current;
    if (stack.length < 2) {
      if (!hasBrowserBackStackEntry()) return false;
      navigate(-1);
      return true;
    }
    const targetIndex = resolveInAppBackStackTargetIndex(stack);
    const previousPath = targetIndex >= 0 ? stack[targetIndex] : null;
    if (!previousPath) return false;
    stack.splice(targetIndex + 1);
    navigate(previousPath);
    return true;
  }, [navigate]);

  const openNewChatComposer = useCallback(() => {
    if (!selectedOrganizationId) {
      pushToast({
        title: "Select an organization first",
        body: "A new chat must belong to an organization.",
        tone: "error",
      });
      return;
    }

    navigate("/messenger/chat");
  }, [navigate, pushToast, selectedOrganizationId]);

  const shortcutSettingsQuery = useQuery({
    queryKey: queryKeys.instance.shortcutSettings,
    queryFn: () => instanceSettingsApi.getShortcuts(),
    retry: false,
  });
  const shortcutSettings = shortcutSettingsQuery.data === undefined
    ? (shortcutSettingsQuery.isError ? null : undefined)
    : shortcutSettingsQuery.data;
  const shortcutSettingsReady = shortcutSettings !== undefined;

  useKeyboardShortcuts({
    onNewChat: openNewChatComposer,
    onNewIssue: () => openNewIssue(),
    onToggleSidebar: toggleSidebar,
    onTogglePanel: togglePanel,
    onOpenSettings: () => openSettings(),
    onNavigateBack: navigateBack,
    shortcutSettings,
  });

  const desktopContentShellInsetClass = macDesktopShell
    ? "h-full flex-1 pl-2.5 pb-1 pr-1 pt-0.5 md:pl-3 md:pb-1.5 md:pr-1.5 md:pt-0.5"
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
      const nextWidth = clampWorkspaceColumnWidth(workspaceColumnFamily, startWidth + deltaX);
      contextColumnWidthRatioRef.current = widthRatio(nextWidth);
      setContextColumnWidth(nextWidth);
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
    <NavigationBackProvider navigateBack={navigateBack}>
    <div
      data-shortcut-settings-ready={shortcutSettingsReady ? "true" : "false"}
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
      <MarkdownMentionsProvider>
      <SidePanelRouteContextBinder
        contextKey={displayedSidePanelContext.contextKey}
        preserveHold={displayedSidePanelContext.preserveHold}
      />
      <CalendarWorkspaceProvider>
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
                  href={RUDDER_DOCS_URL}
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
                      to={DEFAULT_ORGANIZATION_HOME_PATH}
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
          {!isMobile && macDesktopShell ? <div className="desktop-window-drag h-[var(--desktop-content-top-gap)] shrink-0" /> : null}
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
                !isMobile && isLibraryRoute && "workspace-shell--library-transparent",
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
                  <div
                    className={cn(
                      "relative flex min-h-0 min-w-0 flex-1",
                      "px-[3px] pb-[3px] pt-[1px] md:px-1 md:pb-1 md:pt-0.5",
                    )}
                  >
                    {showIntegratedShellSidebar ? (
                      <>
                        <div
                          data-testid="workspace-context-card"
                          data-auto-collapsed={autoCollapseAgentContextSidebar || undefined}
                          aria-hidden={!contextSidebarVisible}
                          inert={contextSidebarVisible ? undefined : true}
                          className={cn(
                            "box-border flex min-h-0 shrink-0 overflow-hidden",
                            "workspace-context-card",
                            !resizingColumn && "transition-[width,opacity,border-color] duration-200 ease-out motion-reduce:transition-none",
                            sidebarOpen ? "opacity-100" : "pointer-events-none border-0 border-transparent opacity-0",
                          )}
                          style={{ width: contextSidebarVisible ? contextColumnWidth : 0 }}
                        >
                          {isWorkspaceBackupsRoute ? (
                            <WorkspaceBackupFilesSidebar />
                          ) : isLibraryRoute ? (
                            <OrganizationWorkspaceFilesSidebar onCollapseSidebar={() => setSidebarOpen(false)} />
                          ) : (
                            <ThreeColumnContextSidebar />
                          )}
                        </div>
                        <div
                          data-testid="workspace-column-resizer"
                          aria-hidden={!contextSidebarVisible}
                          className={cn(
                            "workspace-column-resizer group flex shrink-0 cursor-col-resize items-stretch justify-center",
                            !resizingColumn && "motion-resize",
                            contextSidebarVisible ? "w-2 opacity-100 md:w-[9px]" : "w-0 overflow-hidden opacity-0",
                            resizingColumn && "is-resizing",
                          )}
                          onPointerDown={startContextColumnResize}
                          role={contextSidebarVisible ? "separator" : undefined}
                          aria-orientation="vertical"
                          aria-label="Resize workspace columns"
                        >
                          <div className="workspace-column-resizer-line" />
                        </div>
                      </>
                    ) : null}
                    {showIntegratedShellSidebar
                      && !sidebarOpen
                      && useFramelessWorkspaceMain
                      && !hasActiveChatConversation ? (
                      <CollapsedWorkspaceSidebarReveal
                        onOpen={() => setSidebarOpen(true)}
                        alwaysVisible={isChatRoute || isMessengerRoute}
                      />
                    ) : null}
                    <div className="workspace-main-panel-stack relative flex min-h-0 min-w-0 flex-1" data-testid="workspace-main-panel-stack">
                      <div
                        data-testid="workspace-main-card"
                        data-tour-target="workspace-main"
                        aria-hidden={desktopSidePanelContentInactive || undefined}
                        inert={desktopSidePanelContentInactive ? true : undefined}
                        className={cn(
                          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                          "workspace-main-card",
                          useFramelessWorkspaceMain && "workspace-main-card--frameless",
                          desktopSidePanelContentInactive
                            && "pointer-events-none border-0 [box-shadow:none]",
                        )}
                      >
                        {!useFramelessWorkspaceMain ? (
                          <div data-testid="workspace-main-header" className="shrink-0">
                            <BreadcrumbBar desktopChrome={macDesktopShell} variant="card" />
                          </div>
                        ) : null}
                        <main
                          id="main-content"
                          tabIndex={-1}
                          ref={mainScrollRef}
                          className={cn(
                            "scrollbar-auto-hide min-w-0 flex-1",
                            shellMainPaddingClass,
                            isMobile
                              ? "overflow-visible pb-[calc(5rem+env(safe-area-inset-bottom))]"
                              : useFramelessWorkspaceMain
                                ? "overflow-hidden"
                                : "overflow-auto",
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
                      <DesktopSidePanelSlot
                        contextReady={sidePanelContextReady}
                        expanded={desktopSidePanelExpanded}
                        selectedOrganizationId={sidePanelOrganizationId}
                        onExpandedChange={setDesktopSidePanelExpanded}
                      />
                    </div>
                  </div>
                ) : (
                  <main
                    id="main-content"
                    data-tour-target="workspace-main"
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
      {isMobile ? (
        <ChatSidePanel
          contextReady={sidePanelContextReady}
          selectedOrganizationId={sidePanelOrganizationId}
        />
      ) : null}
      </CalendarWorkspaceProvider>
      </MarkdownMentionsProvider>
    </div>
    </NavigationBackProvider>
  );
}
