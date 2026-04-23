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
  const [desktopTestNotificationPending, setDesktopTestNotificationPending] = useState(false);
  const [desktopBadgePreviewPending, setDesktopBadgePreviewPending] = useState(false);

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
      desktopDockBadge?: boolean;
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

  async function handleSendDesktopTestNotification() {
    const desktopShell = readDesktopShell();
    if (!desktopShell) return;

    setActionError(null);
    setDesktopTestNotificationPending(true);
    try {
      await desktopShell.showNotification({
        title: t("notifications.permission.access.testNotificationTitle"),
        body: t("notifications.permission.access.testNotificationBody"),
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("notifications.permission.requestFailed"));
    } finally {
      setDesktopTestNotificationPending(false);
    }
  }

  async function handlePreviewDesktopBadge() {
    const desktopShell = readDesktopShell();
    if (!desktopShell) return;

    const restoreCount = desktopBootState?.diagnostics?.lastBadgeCount ?? 0;
    setActionError(null);
    setDesktopBadgePreviewPending(true);
    try {
      await desktopShell.setBadgeCount(3);
      window.setTimeout(() => {
        void desktopShell.setBadgeCount(restoreCount).catch((error) => {
          console.warn("[rudder-ui] failed to restore desktop badge preview count", error);
        });
      }, 3000);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("notifications.updateFailed"));
    } finally {
      setDesktopBadgePreviewPending(false);
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
  const badgeSupported = isDesktopShell
    ? (desktopBootState?.capabilities?.badgeCount ?? false)
    : false;
  const lastBadgeCount = desktopBootState?.diagnostics?.lastBadgeCount;
  const badgeSyncSucceeded = desktopBootState?.diagnostics?.badgeSyncSucceeded;
  const lastNotificationTitle = desktopBootState?.diagnostics?.lastNotificationTitle;
  const lastNotificationTriggeredAt = desktopBootState?.diagnostics?.lastNotificationTriggeredAt;
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
        badgeSupport: badgeSupported
          ? t("notifications.support.available")
          : t("notifications.support.unavailable"),
      })
    : t("notifications.permission.access.summary", {
        permission: formatDesktopNotificationPermission(notificationPermission),
        notificationsSupport: notificationSupported
          ? t("notifications.support.available")
          : t("notifications.support.unavailable"),
        badgeSupport: badgeSupported
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
              {isDevDesktopShell && lastNotificationTitle && lastNotificationTriggeredAt ? (
                <div className="text-[12px]">
                  {t("notifications.permission.access.lastTest", {
                    title: lastNotificationTitle,
                    timestamp: lastNotificationTriggeredAt,
                  })}
                </div>
              ) : null}
            </div>
          )}
          action={(
            <div className="flex flex-col items-end gap-2">
              {isDevDesktopShell ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleSendDesktopTestNotification()}
                  disabled={desktopTestNotificationPending || !notificationSupported}
                >
                  {desktopTestNotificationPending
                    ? t("notifications.permission.access.testing")
                    : t("notifications.permission.access.testNotification")}
                </Button>
              ) : null}
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

        <SettingsRow
          title={t("notifications.behavior.badge.title")}
          description={(
            <div className="space-y-1">
              <div>{t("notifications.behavior.badge.description")}</div>
              {!isDesktopShell ? (
                <div className="text-[12px]">{t("notifications.behavior.badge.browserOnly")}</div>
              ) : null}
              {lastBadgeCount != null && typeof badgeSyncSucceeded === "boolean" ? (
                <div className="text-[12px]">
                  {t("notifications.behavior.badge.lastSync", {
                    count: lastBadgeCount,
                    result: badgeSyncSucceeded
                      ? t("notifications.support.accepted")
                      : t("notifications.support.rejected"),
                  })}
                </div>
              ) : null}
              {isDevDesktopShell ? (
                <div className="text-[12px]">{t("notifications.behavior.badge.desktopDebug")}</div>
              ) : null}
            </div>
          )}
          action={(
            <div className="flex flex-col items-end gap-2">
              {isDevDesktopShell ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePreviewDesktopBadge()}
                  disabled={desktopBadgePreviewPending || !badgeSupported}
                >
                  {desktopBadgePreviewPending
                    ? t("notifications.behavior.badge.previewing")
                    : t("notifications.behavior.badge.preview")}
                </Button>
              ) : null}
              <SettingsToggle
                checked={settings.desktopDockBadge}
                aria-label={t("notifications.behavior.badge.toggle")}
                disabled={toggleMutation.isPending}
                onClick={() =>
                  toggleMutation.mutate({
                    desktopDockBadge: !settings.desktopDockBadge,
                  })
                }
              />
            </div>
          )}
        />
      </SettingsSection>
    </div>
  );
}
