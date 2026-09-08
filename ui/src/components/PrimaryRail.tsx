import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { messengerApi } from "@/api/messenger";
import { LocalAppIdentityIcon } from "@/components/LocalAppIdentityIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDialog } from "@/context/DialogContext";
import { useI18n } from "@/context/I18nContext";
import { useOrganization } from "@/context/OrganizationContext";
import { useSidebar } from "@/context/SidebarContext";
import { useCloseApp } from "@/hooks/useCloseApp";
import { useInboxBadge } from "@/hooks/useInboxBadge";
import {
  readDesktopNotificationPermission,
  requestDesktopNotificationPermission,
} from "@/lib/desktop-notification-permission";
import { readDesktopShell } from "@/lib/desktop-shell";
import { readRememberedIssueNavigationPath } from "@/lib/issue-navigation";
import { localAppIdentityMatches, type LocalAppOpaqueIdentity } from "@/lib/local-apps";
import { localAppSavedViewRoute } from "@/lib/messenger-saved-views";
import { requestMessengerUnreadScroll } from "@/lib/messenger-unread-scroll";
import { openApp, useOpenApps } from "@/lib/open-apps";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { readRememberedPrimaryRailPath } from "@/lib/primary-rail-memory";
import { queryKeys } from "@/lib/queryKeys";
import { NavLink, useLocation, useNavigate } from "@/lib/router";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  Blocks,
  Bot,
  CircleCheckBig,
  FolderKanban,
  Inbox,
  Inbox as InboxIcon,
  LibraryBig,
  MessageCirclePlus,
  MessageSquare,
  Network,
  Plus,
  Repeat,
  Search,
  Settings,
  Target,
  UsersRound,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { OrganizationSwitcher } from "./OrganizationSwitcher";

const DEFAULT_NOTIFICATION_SETTINGS = {
  desktopInboxNotifications: true,
  desktopDockBadge: true,
};

const RUDDER_NOTIFICATION_ICON = "/rudder-logo.png";

type RailItem = {
  key: string;
  to: string;
  label: string;
  icon: typeof Inbox;
  badge?: number;
  badgeTone?: "default" | "danger";
  badgeTestId?: string;
  active: boolean;
  localAppIdentity?: LocalAppOpaqueIdentity;
};

function isMessengerAttentionRoute(relativePath: string): boolean {
  return /^\/(?:messenger|chat)(?:\/|$)/.test(relativePath);
}

function resolveDesktopRailPlatform(isDesktopShell: boolean): "macos" | "windows" | "other" | null {
  if (!isDesktopShell || typeof window === "undefined") return null;
  const userAgent = window.navigator.userAgent;
  if (/Mac/i.test(userAgent)) return "macos";
  if (/Windows/i.test(userAgent)) return "windows";
  return "other";
}

const railUtilityButtonClass = [
  "rail-utility-button h-9 w-9 translate-x-[var(--primary-rail-item-shift,0.25rem)] overflow-hidden rounded-full border backdrop-blur-[22px]",
].join(" ");

function RailNavItem({
  to,
  label,
  icon: Icon,
  tourTarget,
  badge,
  badgeTone = "default",
  badgeTestId,
  active,
  onDoubleClick,
  onContextMenu,
  localAppIdentity,
  end,
  onClose,
  closePending,
}: {
  to: string;
  label: string;
  icon: typeof Inbox;
  tourTarget?: string;
  badge?: number;
  badgeTone?: "default" | "danger";
  badgeTestId?: string;
  active?: boolean;
  onDoubleClick?: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
  localAppIdentity?: LocalAppOpaqueIdentity;
  end?: boolean;
  onClose?: () => void;
  closePending?: boolean;
}) {
  const link = (
    <NavLink
      to={to}
      end={end}
      aria-current={active ? "page" : undefined}
      data-tour-target={tourTarget}
      data-tour-spotlight={tourTarget ? "compact-rail" : undefined}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={({ isActive }) =>
        cn(
          "relative z-10 flex min-h-[56px] w-[var(--primary-rail-item-width,66px)] translate-x-[var(--primary-rail-item-shift,0.25rem)] flex-col items-center justify-center gap-1 rounded-[var(--radius-sm)] px-1 py-2 text-[9px] font-medium leading-[1.05] transition-colors",
          (active ?? isActive)
            ? "text-white"
            : [
              "text-[color:color-mix(in_oklab,var(--sidebar-foreground)_86%,var(--sidebar))]",
              "hover:bg-[color:color-mix(in_oklab,var(--sidebar)_58%,white)]",
              "hover:text-[color:var(--sidebar-foreground)]",
              "dark:text-white/74 dark:hover:bg-white/[0.07] dark:hover:text-white",
            ].join(" "),
        )
      }
    >
      <span className="relative">
        {localAppIdentity ? (
          <LocalAppIdentityIcon
            className="h-[17px] w-[17px] rounded-[4px]"
            identity={localAppIdentity}
            testId="primary-rail-local-app-icon"
          />
        ) : (
          <Icon className="h-[17px] w-[17px]" />
        )}
        {badge != null && badge > 0 ? (
          <span
            data-testid={badgeTestId}
            className={cn(
              "absolute -right-2 -top-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
              badgeTone === "danger"
                ? "bg-red-500 text-white shadow-[0_4px_12px_-6px_rgba(220,38,38,0.85)]"
                : "bg-primary text-primary-foreground",
            )}
          >
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </span>
      <span className="block w-full min-w-0 truncate text-center" title={label}>{label}</span>
    </NavLink>
  );
  if (!onClose) return link;
  return (
    <div className="group/rail-app relative shrink-0" data-testid="primary-rail-app">
      {link}
      <button
        type="button"
        aria-label={`Close ${label}`}
        title={`Close ${label}`}
        disabled={closePending}
        onClick={onClose}
        className="absolute right-0 top-0.5 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-sidebar text-sidebar-foreground opacity-0 pointer-events-none transition-opacity group-hover/rail-app:opacity-100 group-hover/rail-app:pointer-events-auto group-focus-within/rail-app:opacity-100 group-focus-within/rail-app:pointer-events-auto hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait"
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}

export function PrimaryRail({
  onOpenSettings,
  onWarmSettings,
}: {
  onOpenSettings: () => void;
  onWarmSettings: () => void;
}) {
  const { t, locale } = useI18n();
  const { openNewIssue, openNewAgent, openNewGoal, openNewProject } = useDialog();
  const { setSidebarOpen } = useSidebar();
  const { selectedOrganizationId } = useOrganization();
  const openedApps = useOpenApps(selectedOrganizationId);
  const closeRailAppMutation = useCloseApp();
  const queryClient = useQueryClient();
  const inboxBadge = useInboxBadge(selectedOrganizationId);
  const [messengerContextMenu, setMessengerContextMenu] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const notificationsSettingsQuery = useQuery({
    queryKey: queryKeys.instance.notificationSettings,
    queryFn: () => instanceSettingsApi.getNotifications(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });
  // The canonical flag wins so a stale legacy alias cannot undo an explicit disable.
  const pluginsEnabled = (healthQuery.data?.features?.experimentalPluginsEnabled
    ?? healthQuery.data?.features?.experimentalSitesEnabled) === true;
  const goalsEnabled = healthQuery.data?.features?.experimentalGoalsEnabled === true;
  const pinnedLocalAppsQuery = useQuery({
    queryKey: queryKeys.messenger.primaryRailPins(selectedOrganizationId ?? "__none__"),
    queryFn: () => messengerApi.listSavedViews(selectedOrganizationId!, {
      visibility: "visible",
      primaryRailPinned: true,
      limit: 100,
    }),
    enabled: Boolean(selectedOrganizationId),
  });
  const location = useLocation();
  const navigate = useNavigate();
  const relativePath = toOrganizationRelativePath(location.pathname);
  const savedViewId = relativePath.match(/^\/apps\/saved\/([^/]+)$/)?.[1];
  const activeSavedViewQuery = useQuery({
    queryKey: queryKeys.messenger.savedView(selectedOrganizationId ?? "__none__", savedViewId ?? "__none__"),
    queryFn: () => messengerApi.getSavedView(selectedOrganizationId!, savedViewId!),
    enabled: Boolean(selectedOrganizationId && savedViewId),
  });
  useEffect(() => {
    const saved = activeSavedViewQuery.data;
    if (!selectedOrganizationId || !savedViewId || !saved || saved.id !== savedViewId || saved.targetPayload.kind !== "local_app") return;
    openApp(selectedOrganizationId, {
      key: `saved-view:${saved.id}`,
      title: saved.title,
      path: localAppSavedViewRoute(saved.id),
      identity: saved.targetPayload,
    });
  }, [activeSavedViewQuery.data, savedViewId, selectedOrganizationId]);
  const suppressInboxPopups = isMessengerAttentionRoute(relativePath);
  const isDesktopShell = readDesktopShell() !== null;
  const desktopRailPlatform = resolveDesktopRailPlatform(isDesktopShell);
  const previousInboxCountRef = useRef<number | null>(null);
  const previousInboxOrgRef = useRef<string | null | undefined>(selectedOrganizationId);
  const requestedNotificationPermissionRef = useRef(false);
  const orgGroupActive = /^\/(?:dashboard|calendar|org|heartbeats|skills|costs|activity)(?:\/|$)/.test(relativePath);
  const issueEntryPath = readRememberedIssueNavigationPath(selectedOrganizationId);
  const messengerEntryPath = readRememberedPrimaryRailPath(selectedOrganizationId, "messenger", "/messenger");
  const issuesEntryPath = readRememberedPrimaryRailPath(selectedOrganizationId, "issues", issueEntryPath);
  const goalsEntryPath = "/goals";
  const agentsEntryPath = readRememberedPrimaryRailPath(selectedOrganizationId, "agents", "/agents");
  const libraryEntryPath = readRememberedPrimaryRailPath(selectedOrganizationId, "library", "/library");
  const projectsEntryPath = readRememberedPrimaryRailPath(selectedOrganizationId, "projects", "/projects");
  const organizationEntryPath = readRememberedPrimaryRailPath(selectedOrganizationId, "organization", "/dashboard");
  const automationsEntryPath = readRememberedPrimaryRailPath(selectedOrganizationId, "automations", "/automations");
  const pluginsEntryPath = readRememberedPrimaryRailPath(selectedOrganizationId, "plugins", "/hub");
  const railItems: RailItem[] = [
    {
      key: "messenger",
      to: messengerEntryPath,
      label: "Messenger",
      icon: MessageSquare,
      badge: inboxBadge.inbox,
      badgeTone: "danger",
      badgeTestId: "rail-badge-messenger",
      active: /^\/(?:messenger|chat)(?:\/|$)/.test(relativePath),
    },
    {
      key: "issues",
      to: issuesEntryPath,
      label: "Issue",
      icon: CircleCheckBig,
      active: /^\/issues(?:\/|$)/.test(relativePath),
    },
    ...(goalsEnabled
      ? [{
          key: "goals",
          to: goalsEntryPath,
          label: "Goals",
          icon: Target,
          active: /^\/goals(?:\/|$)/.test(relativePath),
        }]
      : []),
    {
      key: "agents",
      to: agentsEntryPath,
      label: "Agents",
      icon: UsersRound,
      active: /^\/agents(?:\/|$)/.test(relativePath),
    },
    {
      key: "library",
      to: libraryEntryPath,
      label: locale === "zh-CN" ? "文档" : "Library",
      icon: LibraryBig,
      active: /^\/(?:library|resources|workspaces)(?:\/|$)/.test(relativePath),
    },
    ...(pluginsEnabled
      ? [{
          key: "plugins",
          to: pluginsEntryPath,
          label: "Hub",
          icon: Blocks,
          active: /^\/(?:hub|plugins|apps)(?:\/|$)/.test(relativePath)
            && !/^\/apps\/(?:saved|view)\/[^/]+(?:\/|$)/.test(relativePath),
        }]
      : []),
    {
      key: "projects",
      to: projectsEntryPath,
      label: "Projects",
      icon: FolderKanban,
      active: /^\/projects(?:\/|$)/.test(relativePath),
    },
    {
      key: "organization",
      to: organizationEntryPath,
      label: "Organization",
      icon: Network,
      active: orgGroupActive,
    },
    {
      key: "automations",
      to: automationsEntryPath,
      label: "Automations",
      icon: Repeat,
      active: /^\/automations(?:\/|$)/.test(relativePath),
    },
  ];
  const openedAppItems: RailItem[] = openedApps.map((app) => ({
    key: app.key,
    to: app.path,
    label: app.title,
    icon: AppWindow,
    localAppIdentity: app.identity,
    active: relativePath === app.path,
  }));
  const sameApp = (a: RailItem, b: RailItem) => a.to === b.to || Boolean(
    a.localAppIdentity && b.localAppIdentity && localAppIdentityMatches(a.localAppIdentity, b.localAppIdentity),
  );
  const legacyPinnedItems: RailItem[] = (pinnedLocalAppsQuery.data?.items ?? [])
    .filter((savedView) => savedView.targetPayload.kind === "local_app")
    .map((savedView) => ({
      key: `saved-view:${savedView.id}`,
      to: localAppSavedViewRoute(savedView.id),
      label: savedView.title,
      icon: MessageSquare,
      localAppIdentity: savedView.targetPayload as LocalAppOpaqueIdentity,
      active: relativePath === localAppSavedViewRoute(savedView.id),
    }));
  const pinnedLocalAppItems = [...openedAppItems, ...legacyPinnedItems].reduce<RailItem[]>((items, item) => {
    const index = items.findIndex((candidate) => sameApp(candidate, item));
    if (index < 0) items.push(item);
    else if (item.active) items[index] = item;
    return items;
  }, []);
  const activeFixedRailIndex = railItems.findIndex((item) => item.active);
  const activePinnedRailIndex = pinnedLocalAppItems.findIndex((item) => item.active);
  const activeRailIndex = activeFixedRailIndex >= 0
    ? activeFixedRailIndex
    : activePinnedRailIndex >= 0
      ? railItems.length + activePinnedRailIndex
      : -1;
  const activeRailStyle = activeRailIndex >= 0
    ? ({
        "--motion-rail-active-index": activeRailIndex,
        "--motion-rail-active-offset": activePinnedRailIndex >= 0
          ? `calc(${activeRailIndex} * (var(--motion-rail-item-height) + var(--motion-rail-item-gap)) + 0.6875rem)`
          : `calc(${activeRailIndex} * (var(--motion-rail-item-height) + var(--motion-rail-item-gap)))`,
      } as CSSProperties)
    : undefined;
  const handleMessengerDoubleClick = useCallback(() => {
    if ((inboxBadge.inbox ?? 0) <= 0) return;
    setSidebarOpen(true);
    requestMessengerUnreadScroll();
  }, [inboxBadge.inbox, setSidebarOpen]);
  const dismissUnreadsMutation = useMutation({
    mutationFn: async () => {
      if (!selectedOrganizationId) {
        return { dismissedCount: 0, dismissedThreadKeys: [] };
      }
      return messengerApi.dismissUnreads(selectedOrganizationId);
    },
    onSuccess: async () => {
      if (!selectedOrganizationId) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedOrganizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threadPreview(selectedOrganizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(selectedOrganizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threadPages(selectedOrganizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.messenger.customGroups(selectedOrganizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.messenger.issues(selectedOrganizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.messenger.approvals(selectedOrganizationId) }),
        queryClient.invalidateQueries({ queryKey: ["messenger", selectedOrganizationId, "system"] }),
        queryClient.invalidateQueries({ queryKey: ["chats", selectedOrganizationId] }),
      ]);
    },
  });
  const handleMessengerContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    setMessengerContextMenu({ left: event.clientX, top: event.clientY });
  }, []);
  const dismissUnreads = useCallback(() => {
    if (!selectedOrganizationId || dismissUnreadsMutation.isPending) return;
    dismissUnreadsMutation.mutate();
  }, [dismissUnreadsMutation, selectedOrganizationId]);

  useEffect(() => {
    if (notificationsSettingsQuery.isLoading) return;
    if (previousInboxOrgRef.current !== selectedOrganizationId) {
      previousInboxOrgRef.current = selectedOrganizationId;
      previousInboxCountRef.current = null;
    }

    const desktopShell = readDesktopShell();
    let cancelled = false;
    const desktopShellApi = desktopShell;
    const notificationSettings = notificationsSettingsQuery.data ?? DEFAULT_NOTIFICATION_SETTINGS;

    async function syncDesktopInboxSignals() {
      const nextCount = Math.max(0, inboxBadge.inbox ?? 0);
      if (desktopShellApi) {
        await desktopShellApi.setBadgeCount(notificationSettings.desktopInboxNotifications ? nextCount : 0).catch((error) => {
          console.warn("[rudder-ui] failed to sync desktop dock badge count", error);
        });
      }

      let browserPermission = readDesktopNotificationPermission();
      const shouldRequestBrowserPermission =
        desktopShellApi === null
        && inboxBadge.isReady
        && nextCount > 0
        && browserPermission === "default"
        && !requestedNotificationPermissionRef.current
        && notificationSettings.desktopInboxNotifications
        && !suppressInboxPopups;

      if (shouldRequestBrowserPermission) {
        requestedNotificationPermissionRef.current = true;
        browserPermission = await requestDesktopNotificationPermission();
      }

      if (cancelled) return;

      const previousCount = previousInboxCountRef.current;
      if (
        previousCount != null
        && inboxBadge.isReady
        && nextCount > previousCount
        && notificationSettings.desktopInboxNotifications
        && !suppressInboxPopups
      ) {
        const { title, body } = inboxBadge.notificationContent;

        if (desktopShellApi) {
          await desktopShellApi.showNotification({
            title,
            body,
          }).catch((error) => {
            console.warn("[rudder-ui] failed to trigger desktop inbox notification", error);
          });
        } else if (browserPermission === "granted" && typeof Notification !== "undefined") {
          try {
            const notification = new Notification(title, {
              body,
              icon: RUDDER_NOTIFICATION_ICON,
            });
            notification.onclick = () => window.focus();
          } catch (error) {
            console.warn("[rudder-ui] failed to trigger browser inbox notification", error);
          }
        }
      }
      if (inboxBadge.isReady) {
        previousInboxCountRef.current = nextCount;
      }
    }

    void syncDesktopInboxSignals();
    return () => {
      cancelled = true;
    };
  }, [
    inboxBadge.inbox,
    inboxBadge.isReady,
    inboxBadge.notificationContent,
    notificationsSettingsQuery.data,
    notificationsSettingsQuery.isLoading,
    selectedOrganizationId,
    suppressInboxPopups,
  ]);

  function openSearch() {
    document.dispatchEvent(
      new CustomEvent("rudder:open-command-palette", {
        detail: { source: "primary-rail" },
      }),
    );
  }

  return (
    <aside
      data-testid="primary-rail"
      data-tour-target="primary-rail"
      data-desktop-shell={isDesktopShell ? "true" : undefined}
      data-desktop-platform={desktopRailPlatform ?? undefined}
      className={cn(
        "primary-rail-shell my-2 flex h-[calc(100%-1rem)] shrink-0 flex-col items-center py-1.5 text-[color:color-mix(in_oklab,var(--foreground)_78%,white)]",
        desktopRailPlatform === "windows"
          ? "ml-1 mr-1 w-[52px] [--primary-rail-item-shift:0px] [--primary-rail-item-width:52px]"
          : isDesktopShell
            ? "ml-3 mr-1 w-[40px]"
            : "ml-2 mr-3 px-5 w-[50px]",
      )}
    >
      <div className="flex w-full flex-col items-center gap-4">
        <div className="translate-x-[var(--primary-rail-item-shift,0.25rem)]">
          <OrganizationSwitcher compact />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className={railUtilityButtonClass}
          onClick={openSearch}
          title={t("common.search")}
          aria-label={t("common.search")}
        >
          <Search className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(railUtilityButtonClass, "rail-create-menu-trigger")}
              data-tour-target="create-menu"
              title={t("common.create")}
              aria-label={t("common.create")}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="right"
            align="start"
            className="rail-create-menu-content morph-popover morph-popover--from-left glass-popover w-48 text-foreground"
          >
            <DropdownMenuItem onClick={() => navigate("/messenger/chat")}>
              <MessageCirclePlus className="h-4 w-4" />
              Create new chat
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openNewIssue()}>
              <CircleCheckBig className="h-4 w-4" />
              Create new issue
            </DropdownMenuItem>
            {goalsEnabled ? (
              <DropdownMenuItem onClick={() => openNewGoal()}>
                <Target className="h-4 w-4" />
                Create new goal
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={() => openNewAgent()}>
              <Bot className="h-4 w-4" />
              Create new agent
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openNewProject()}>
              <FolderKanban className="h-4 w-4" />
              Create new project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav
        className="motion-rail-nav scrollbar-auto-hide mt-2.5 flex min-h-0 w-[calc(var(--primary-rail-item-width,66px)+var(--primary-rail-item-shift,0.25rem)+var(--primary-rail-item-shift,0.25rem)+0.625rem)] flex-1 flex-col items-center gap-0.5 overflow-y-auto"
        style={activeRailStyle}
        data-active-index={activeRailIndex >= 0 ? activeRailIndex : undefined}
        aria-label="Primary navigation"
      >
        {activeRailIndex >= 0 ? (
          <span
            data-testid="primary-rail-active-indicator"
            className="motion-rail-active-indicator"
            aria-hidden="true"
          />
        ) : null}
        {railItems.map((item) => (
          <RailNavItem
            key={item.key}
            to={item.to}
            label={item.label}
            icon={item.icon}
            tourTarget={item.key === "issues" ? "issues-nav" : undefined}
            badge={item.badge}
            badgeTone={item.badgeTone}
            badgeTestId={item.badgeTestId}
            active={item.active}
            onDoubleClick={item.key === "messenger" ? handleMessengerDoubleClick : undefined}
            onContextMenu={item.key === "messenger" ? handleMessengerContextMenu : undefined}
            localAppIdentity={item.localAppIdentity}
            end={item.key === "plugins" ? true : undefined}
          />
        ))}
        {pinnedLocalAppItems.length > 0 ? (
          <span className="my-1 h-px w-7 shrink-0 bg-white/10" aria-hidden="true" />
        ) : null}
        {pinnedLocalAppItems.map((item) => (
          <RailNavItem
            key={item.key}
            to={item.to}
            label={item.label}
            icon={item.icon}
            active={item.active}
            localAppIdentity={item.localAppIdentity}
            onClose={() => selectedOrganizationId && closeRailAppMutation.mutate({ organizationId: selectedOrganizationId, app: { key: item.key, path: item.to, title: item.label, identity: item.localAppIdentity } })}
            closePending={closeRailAppMutation.isPending}
          />
        ))}
      </nav>

      <DropdownMenu
        open={messengerContextMenu !== null}
        onOpenChange={(open) => {
          if (!open) setMessengerContextMenu(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed h-px w-px opacity-0"
            style={{
              left: messengerContextMenu?.left ?? -1000,
              top: messengerContextMenu?.top ?? -1000,
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
          className="glass-popover w-52 text-foreground"
          onContextMenu={(event) => event.preventDefault()}
        >
          <DropdownMenuItem
            disabled={!selectedOrganizationId || dismissUnreadsMutation.isPending || (inboxBadge.inbox ?? 0) <= 0}
            onClick={dismissUnreads}
          >
            <InboxIcon className="h-4 w-4" />
            Dismiss Unreads
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(
          "settings-entry-button flex items-center justify-center transition-[transform,background-color,border-color,box-shadow,color]",
          railUtilityButtonClass,
        )}
        onPointerEnter={onWarmSettings}
        onFocus={onWarmSettings}
        onClick={onOpenSettings}
        aria-label={t("common.systemSettings")}
        title={t("common.systemSettings")}
        data-settings-trigger="true"
      >
        <Settings className="h-4 w-4" />
      </Button>
    </aside>
  );
}
