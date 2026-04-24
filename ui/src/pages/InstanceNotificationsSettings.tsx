import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Accessibility,
  Bell,
  CircleAlert,
  HardDrive,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  SettingsPageHeader,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useI18n } from "@/context/I18nContext";
import type { TranslationKey } from "@/i18n/locales/en";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import {
  readDesktopNotificationPermission,
  requestDesktopNotificationPermission,
  type DesktopNotificationPermissionState,
} from "@/lib/desktop-notification-permission";
import {
  readDesktopShell,
  type DesktopBootState,
} from "@/lib/desktop-shell";

const DEFAULT_NOTIFICATION_SETTINGS = {
  desktopInboxNotifications: true,
  desktopDockBadge: true,
};

type PermissionStatusTone = "ok" | "warn" | "muted";

type SystemPermissionDefinition = {
  id: "fullDiskAccess" | "accessibility" | "automation" | "notifications";
  icon: LucideIcon;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  macSettingsUrl?: string;
};

const SYSTEM_PERMISSIONS: SystemPermissionDefinition[] = [
  {
    id: "fullDiskAccess",
    icon: HardDrive,
    titleKey: "systemPermissions.permission.fullDiskAccess.title",
    descriptionKey: "systemPermissions.permission.fullDiskAccess.description",
    macSettingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  },
  {
    id: "accessibility",
    icon: Accessibility,
    titleKey: "systemPermissions.permission.accessibility.title",
    descriptionKey: "systemPermissions.permission.accessibility.description",
    macSettingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  },
  {
    id: "automation",
    icon: Workflow,
    titleKey: "systemPermissions.permission.automation.title",
    descriptionKey: "systemPermissions.permission.automation.description",
    macSettingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  },
  {
    id: "notifications",
    icon: Bell,
    titleKey: "systemPermissions.permission.notifications.title",
    descriptionKey: "systemPermissions.permission.notifications.description",
  },
];

function getBrowserNotificationStatus(permission: DesktopNotificationPermissionState): {
  labelKey: TranslationKey;
  tone: PermissionStatusTone;
} {
  switch (permission) {
    case "granted":
      return { labelKey: "systemPermissions.status.authorized", tone: "ok" };
    case "denied":
      return { labelKey: "systemPermissions.status.blocked", tone: "warn" };
    case "default":
      return { labelKey: "systemPermissions.status.needsAccess", tone: "warn" };
    default:
      return { labelKey: "systemPermissions.status.unavailable", tone: "muted" };
  }
}

function PermissionStatusBadge({
  children,
  tone,
}: {
  children: string;
  tone: PermissionStatusTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[calc(var(--radius-sm)-1px)] border px-2 py-0.5 text-[11px] font-medium",
        tone === "ok"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : tone === "warn"
            ? "border-amber-500/32 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            : "border-border/80 bg-muted/40 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function InstanceNotificationsSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [desktopBootState, setDesktopBootState] = useState<DesktopBootState | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<DesktopNotificationPermissionState>(
    () => readDesktopNotificationPermission(),
  );
  const [notificationPermissionPending, setNotificationPermissionPending] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("common.systemPermissions") },
    ]);
  }, [setBreadcrumbs, t]);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    setNotificationPermission(readDesktopNotificationPermission());
    if (!desktopShell) return undefined;

    const unsubscribe = desktopShell.onBootState(setDesktopBootState);
    void desktopShell.getBootState().then(setDesktopBootState).catch(() => setDesktopBootState(null));
    return unsubscribe;
  }, []);

  const notificationsQuery = useQuery({
    queryKey: queryKeys.instance.notificationSettings,
    queryFn: () => instanceSettingsApi.getNotifications(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

  const toggleMutation = useMutation({
    mutationFn: async (patch: {
      desktopInboxNotifications?: boolean;
    }) => instanceSettingsApi.updateNotifications(patch),
    onSuccess: async (nextSettings) => {
      setActionError(null);
      queryClient.setQueryData(queryKeys.instance.notificationSettings, nextSettings);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.notificationSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("notifications.updateFailed"));
    },
  });

  async function handleRequestNotificationPermission() {
    setActionError(null);
    setNotificationPermissionPending(true);
    try {
      const nextPermission = await requestDesktopNotificationPermission();
      setNotificationPermission(nextPermission);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("notifications.permission.requestFailed"));
    } finally {
      setNotificationPermissionPending(false);
    }
  }

  async function handleOpenNotificationSettings() {
    const desktopShell = readDesktopShell();
    if (!desktopShell) return;

    setActionError(null);
    try {
      await desktopShell.openNotificationSettings();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("notifications.permission.openSettingsFailed"));
    }
  }

  async function handleOpenSystemPermissionSettings(targetUrl: string) {
    const desktopShell = readDesktopShell();
    if (!desktopShell) return;

    setActionError(null);
    try {
      await desktopShell.openExternal(targetUrl);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("systemPermissions.openSettingsFailed"));
    }
  }

  if (notificationsQuery.isLoading) {
    return <SettingsPageSkeleton dense />;
  }

  if (notificationsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {notificationsQuery.error instanceof Error
          ? notificationsQuery.error.message
          : t("notifications.loadFailed")}
      </div>
    );
  }

  const settings = notificationsQuery.data ?? DEFAULT_NOTIFICATION_SETTINGS;
  const desktopShell = readDesktopShell();
  const isDesktopShell = desktopShell !== null;
  const notificationSupported = isDesktopShell
    ? (desktopBootState?.capabilities?.notifications ?? false)
    : notificationPermission !== "unsupported";

  return (
    <div className="mx-auto max-w-4xl space-y-7 px-1 pb-6">
      <SettingsPageHeader
        eyebrow={t("settings.eyebrow.system")}
        icon={ShieldCheck}
        title={t("systemPermissions.title")}
        description={t("systemPermissions.description")}
      />

      {actionError ? (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <SettingsSection
        title={t("systemPermissions.section.title")}
        description={t("systemPermissions.section.description")}
      >
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-border/70 bg-card/45">
          {SYSTEM_PERMISSIONS.map((permission) => {
            const Icon = permission.icon;
            const isNotificationPermission = permission.id === "notifications";
            const browserNotificationStatus = getBrowserNotificationStatus(notificationPermission);
            const status: { labelKey: TranslationKey; tone: PermissionStatusTone } = isNotificationPermission
              ? isDesktopShell
                ? {
                  labelKey: notificationSupported
                    ? "systemPermissions.status.systemManaged"
                    : "systemPermissions.status.unavailable",
                  tone: notificationSupported ? "muted" as const : "warn" as const,
                }
                : browserNotificationStatus
              : isDesktopShell
                ? { labelKey: "systemPermissions.status.systemManaged", tone: "muted" as const }
                : { labelKey: "systemPermissions.status.desktopOnly", tone: "muted" as const };
            const showSystemSettingsAction = !isNotificationPermission
              && isDesktopShell
              && Boolean(permission.macSettingsUrl);
            const showBrowserNotificationRequest = isNotificationPermission
              && !isDesktopShell
              && notificationPermission === "default";
            const showDesktopNotificationSettings = isNotificationPermission && isDesktopShell;
            const showBrowserManagedNotice = isNotificationPermission
              && !isDesktopShell
              && notificationPermission !== "default";
            const hasAction = showSystemSettingsAction
              || showBrowserNotificationRequest
              || showDesktopNotificationSettings
              || showBrowserManagedNotice;

            return (
              <div
                key={permission.id}
                className="grid gap-3 border-t border-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)] px-4 py-3.5 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-[color:color-mix(in_oklab,var(--surface-inset)_88%,transparent)] text-muted-foreground">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[14px] font-medium text-foreground">{t(permission.titleKey)}</h3>
                      <PermissionStatusBadge tone={status.tone}>
                        {t(status.labelKey)}
                      </PermissionStatusBadge>
                    </div>
                    <p className="max-w-2xl text-[13px] leading-5 text-muted-foreground">
                      {t(permission.descriptionKey)}
                    </p>
                    {isNotificationPermission ? (
                      <div className="pt-1">
                        <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
                          <span>{t("systemPermissions.permission.notifications.inboxLabel")}</span>
                          <SettingsToggle
                            checked={settings.desktopInboxNotifications}
                            aria-label={t("notifications.behavior.inbox.toggle")}
                            disabled={toggleMutation.isPending}
                            onClick={() =>
                              toggleMutation.mutate({
                                desktopInboxNotifications: !settings.desktopInboxNotifications,
                              })
                            }
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                {hasAction ? (
                  <div className="flex items-center justify-start gap-2 sm:justify-end">
                    {showSystemSettingsAction ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleOpenSystemPermissionSettings(permission.macSettingsUrl!)}
                      >
                        {t("systemPermissions.action.openSettings")}
                      </Button>
                    ) : null}

                    {showBrowserNotificationRequest ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleRequestNotificationPermission()}
                        disabled={notificationPermissionPending}
                      >
                        {notificationPermissionPending
                          ? t("notifications.permission.access.requesting")
                          : t("notifications.permission.access.enable")}
                      </Button>
                    ) : null}

                    {showDesktopNotificationSettings ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleOpenNotificationSettings()}
                      >
                        {t("systemPermissions.action.openSettings")}
                      </Button>
                    ) : null}

                    {showBrowserManagedNotice ? (
                      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                        <CircleAlert className="h-3.5 w-3.5" />
                        {t("systemPermissions.action.browserManaged")}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </SettingsSection>
    </div>
  );
}
