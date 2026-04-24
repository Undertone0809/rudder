import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  SettingsDivider,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useI18n } from "@/context/I18nContext";
import { queryKeys } from "@/lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import {
  formatDesktopNotificationPermission,
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
      { label: t("common.notifications") },
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
  const isDevDesktopShell = isDesktopShell && desktopBootState?.runtime?.localEnv === "dev";
  const notificationSupported = isDesktopShell
    ? (desktopBootState?.capabilities?.notifications ?? false)
    : notificationPermission !== "unsupported";
  const desktopAppName = isDevDesktopShell ? "Rudder-dev" : "Rudder";
  const desktopPermissionHelpKey = isDevDesktopShell
    ? "notifications.permission.access.desktopHelp"
    : "notifications.permission.access.desktopHelpProd";
  const permissionSummary = isDesktopShell
    ? t("notifications.permission.access.summaryDesktop", {
        permission: t("notifications.permission.access.systemManaged"),
        notificationsSupport: notificationSupported
          ? t("notifications.support.available")
          : t("notifications.support.unavailable"),
      })
    : t("notifications.permission.access.summary", {
        permission: formatDesktopNotificationPermission(notificationPermission),
        notificationsSupport: notificationSupported
          ? t("notifications.support.available")
          : t("notifications.support.unavailable"),
      });

  return (
    <div className="mx-auto max-w-4xl space-y-7 px-1 pb-6">
      <SettingsPageHeader
        eyebrow={t("settings.eyebrow.system")}
        icon={Bell}
        title={t("notifications.title")}
        description={t("notifications.description")}
      />

      {actionError ? (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <SettingsDivider />

      <SettingsSection
        title={t("notifications.permission.title")}
        description={t("notifications.permission.description")}
      >
        <SettingsRow
          title={t("notifications.permission.access.title")}
          description={(
            <div className="space-y-1">
              <div>{permissionSummary}</div>
              {isDesktopShell ? (
                <div className="text-[12px]">
                  {t(desktopPermissionHelpKey, {
                    appName: desktopAppName,
                  })}
                </div>
              ) : null}
              {!isDesktopShell && notificationPermission === "default" ? (
                <div className="text-[12px]">{t("notifications.permission.access.default")}</div>
              ) : null}
              {!isDesktopShell && notificationPermission === "denied" ? (
                <div className="text-[12px]">
                  {t("notifications.permission.access.denied.browser")}
                </div>
              ) : null}
            </div>
          )}
          action={(
            <div className="flex flex-col items-end gap-2">
              {!isDesktopShell && notificationPermission === "default" ? (
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
              {isDesktopShell ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleOpenNotificationSettings()}
                >
                  {t("notifications.permission.access.openSettings")}
                </Button>
              ) : null}
            </div>
          )}
        />

        <SettingsRow
          title={t("notifications.environment.title")}
          description={(
            <div className="space-y-1">
              <div>
                {isDesktopShell
                  ? t("notifications.environment.desktop")
                  : t("notifications.environment.browser")}
              </div>
              <div className="text-[12px]">
                {isDesktopShell
                  ? t("notifications.environment.desktopHelp")
                  : t("notifications.environment.browserHelp")}
              </div>
            </div>
          )}
        />
      </SettingsSection>

      <SettingsDivider />

      <SettingsSection
        title={t("notifications.behavior.title")}
        description={t("notifications.behavior.description")}
      >
        <SettingsRow
          title={t("notifications.behavior.inbox.title")}
          description={t("notifications.behavior.inbox.description")}
          action={(
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
          )}
        />
      </SettingsSection>
    </div>
  );
}
