import {
  useEffect,
  useRef,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  MessageCirclePlus,
  FolderKanban,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  Network,
  Plus,
  Repeat,
  Search,
  Settings,
  CircleCheckBig,
} from "lucide-react";
import { NavLink, useLocation, useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDialog } from "@/context/DialogContext";
import { useInboxBadge } from "@/hooks/useInboxBadge";
import { useOrganization } from "@/context/OrganizationContext";
import { readRememberedIssueNavigationPath } from "@/lib/issue-navigation";
import { readDesktopShell } from "@/lib/desktop-shell";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  readDesktopNotificationPermission,
  requestDesktopNotificationPermission,
} from "@/lib/desktop-notification-permission";
import { queryKeys } from "@/lib/queryKeys";
import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { useI18n } from "@/context/I18nContext";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";

const DEFAULT_NOTIFICATION_SETTINGS = {
  desktopInboxNotifications: true,
  desktopDockBadge: true,
};

const RUDDER_NOTIFICATION_ICON = "/rudder-logo.png";

const railUtilityButtonClass = [
  "h-9 w-9 translate-x-1 rounded-lg border shadow-[0_6px_18px_-16px_rgba(15,23,42,0.55)] backdrop-blur-[22px]",
  "border-[color:color-mix(in_oklab,var(--sidebar-border)_76%,white)]",
  "bg-[color:color-mix(in_oklab,var(--sidebar)_72%,white)]",
  "text-[color:color-mix(in_oklab,var(--sidebar-foreground)_88%,var(--sidebar))]",
  "dark:border-white/20 dark:bg-white/10 dark:text-white/78",
].join(" ");

function RailNavItem({
  to,
  label,
  icon: Icon,
  badge,
  badgeTone = "default",
  badgeTestId,
  active,
}: {
  to: string;
  label: string;
  icon: typeof Inbox;
  badge?: number;
  badgeTone?: "default" | "danger";
  badgeTestId?: string;
  active?: boolean;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "relative flex min-h-[56px] w-[66px] translate-x-1 flex-col items-center justify-center gap-1 rounded-[var(--radius-sm)] px-1 py-2 text-[9px] font-medium leading-[1.05] transition-colors",
          (active ?? isActive)
            ? "bg-[#43584f]/88 text-[#def4eb] dark:bg-[#43584f]/88 dark:text-[#def4eb]"
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
        <Icon className="h-[17px] w-[17px]" />
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
      <span className="max-w-full text-center whitespace-normal">{label}</span>
    </NavLink>
  );
}

export function PrimaryRail({
  onOpenSettings,
  onWarmSettings,
}: {
  onOpenSettings: () => void;
  onWarmSettings: () => void;
}) {
  const { t } = useI18n();
  const { openNewIssue, openNewAgent, openNewProject } = useDialog();
  const { selectedOrganizationId } = useOrganization();
  const inboxBadge = useInboxBadge(selectedOrganizationId);
  const notificationsSettingsQuery = useQuery({
    queryKey: queryKeys.instance.notificationSettings,
    queryFn: () => instanceSettingsApi.getNotifications(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });
  const location = useLocation();
  const navigate = useNavigate();
  const relativePath = toOrganizationRelativePath(location.pathname);
  const isDesktopShell = readDesktopShell() !== null;
  const previousInboxCountRef = useRef<number | null>(null);
  const requestedNotificationPermissionRef = useRef(false);
  const orgGroupActive = /^\/(?:org|projects|resources|heartbeats|workspaces|goals|skills|costs|activity)(?:\/|$)/.test(relativePath);
  const issueEntryPath = readRememberedIssueNavigationPath(selectedOrganizationId);

  useEffect(() => {
    if (notificationsSettingsQuery.isLoading) return;

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
        && nextCount > 0
        && browserPermission === "default"
        && !requestedNotificationPermissionRef.current
        && notificationSettings.desktopInboxNotifications;

      if (shouldRequestBrowserPermission) {
        requestedNotificationPermissionRef.current = true;
        browserPermission = await requestDesktopNotificationPermission();
      }

      if (cancelled) return;

      const previousCount = previousInboxCountRef.current;
      if (
        previousCount != null
        && nextCount > previousCount
        && notificationSettings.desktopInboxNotifications
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
      previousInboxCountRef.current = nextCount;
    }

    void syncDesktopInboxSignals();
    return () => {
      cancelled = true;
    };
  }, [
    inboxBadge.inbox,
    inboxBadge.notificationContent,
    notificationsSettingsQuery.data,
    notificationsSettingsQuery.isLoading,
  ]);

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  return (
    <aside
      data-testid="primary-rail"
      className={cn(
        "my-2 flex h-[calc(100%-1rem)] shrink-0 flex-col items-center py-1.5 text-[color:color-mix(in_oklab,var(--foreground)_78%,white)]",
        isDesktopShell ? "ml-3 mr-1 w-[40px]" : "ml-2 mr-3 px-5 w-[50px]",
      )}
    >
      <div className="flex w-full flex-col items-center gap-4">
        <div className="translate-x-1">
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
              className={railUtilityButtonClass}
              title={t("common.create")}
              aria-label={t("common.create")}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="surface-overlay w-48 text-foreground">
            <DropdownMenuItem onClick={() => navigate("/messenger/chat")}>
              <MessageCirclePlus className="h-4 w-4" />
              Create new chat
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openNewIssue()}>
              <CircleCheckBig className="h-4 w-4" />
              Create new issue
            </DropdownMenuItem>
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

      <nav className="mt-2.5 flex w-full flex-1 flex-col items-center gap-0.5">
        <RailNavItem
          to="/messenger"
          label="Messenger"
          icon={MessageSquare}
          badge={inboxBadge.inbox}
          badgeTone="danger"
          badgeTestId="rail-badge-messenger"
        />
        <RailNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} />
        <RailNavItem to="/agents" label="Agents" icon={Bot} />
        <RailNavItem to="/org" label="Organization" icon={Network} active={orgGroupActive} />
        <RailNavItem to={issueEntryPath} label="Issue" icon={CircleCheckBig} />
        <RailNavItem to="/automations" label="Auto" icon={Repeat} />
      </nav>

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
        onPointerDown={onWarmSettings}
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
