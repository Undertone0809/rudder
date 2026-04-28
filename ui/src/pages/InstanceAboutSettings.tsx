import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, Mail, RefreshCw } from "lucide-react";
import { healthApi } from "@/api/health";
import {
  SettingsDivider,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useI18n } from "@/context/I18nContext";
import { useToast } from "@/context/ToastContext";
import type { TranslationKey } from "@/i18n/locales/en";
import { queryKeys } from "@/lib/queryKeys";
import {
  readDesktopShell,
  type DesktopBootState,
  type DesktopUpdateCheckResult,
} from "@/lib/desktop-shell";

const RELEASES_URL = "https://github.com/Undertone0809/rudder/releases";
const FEEDBACK_MAILTO = "mailto:zeeland4work@gmail.com";

function formatVersion(value: string | null | undefined, unknownLabel: string): string {
  if (!value) return unknownLabel;
  return value.startsWith("v") ? value : `v${value}`;
}

function formatDesktopValue(value: string | null | undefined, unknownLabel: string): string {
  if (!value) return unknownLabel;
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatEnvironmentValue(value: string | null | undefined, unknownLabel: string): string {
  if (!value) return unknownLabel;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "default":
    case "local":
    case "prod":
    case "prod_local":
    case "production":
      return "Prod";
    case "dev":
    case "development":
      return "Dev";
    case "e2e":
    case "test":
    case "testing":
      return "E2E";
    default:
      return formatDesktopValue(value, unknownLabel);
  }
}

function buildUpdateFeedback(
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
  result: DesktopUpdateCheckResult,
): { title: string; body: string; tone: "info" | "success" | "warn" } {
  if (result.status === "update-available") {
    return {
      title: t("about.updates.available.toastTitle"),
      body: t("about.updates.available.toastBody", {
        latestVersion: formatVersion(result.latestVersion, t("common.unknown")),
      }),
      tone: "warn",
    };
  }
  if (result.status === "up-to-date") {
    return {
      title: t("about.updates.current.toastTitle"),
      body: t("about.updates.current.toastBody", {
        currentVersion: formatVersion(result.currentVersion, t("common.unknown")),
      }),
      tone: "success",
    };
  }
  return {
    title: t("about.updates.unavailable.toastTitle"),
    body: t("about.updates.unavailable.toastBody"),
    tone: "info",
  };
}

export function InstanceAboutSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [desktopBootState, setDesktopBootState] = useState<DesktopBootState | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<DesktopUpdateCheckResult | null>(null);
  const [checkUpdatesPending, setCheckUpdatesPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("common.about") },
    ]);
  }, [setBreadcrumbs, t]);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell) return undefined;

    const unsubscribe = desktopShell.onBootState(setDesktopBootState);

    void Promise.allSettled([
      desktopShell.getBootState().then(setDesktopBootState),
      desktopShell.getAppVersion().then(setAppVersion),
    ]).then((results) => {
      if (results[0]?.status === "rejected") setDesktopBootState(null);
      if (results[1]?.status === "rejected") setAppVersion(null);
    });
    return unsubscribe;
  }, []);

  const currentVersion = useMemo(
    () => appVersion ?? desktopBootState?.runtime?.version ?? healthQuery.data?.version ?? null,
    [appVersion, desktopBootState?.runtime?.version, healthQuery.data?.version],
  );

  const environment = healthQuery.data?.localEnv ?? null;
  const instance = healthQuery.data?.instanceId ?? null;
  const runtimeMode = desktopBootState?.runtime?.mode ?? null;
  const ownerKind = desktopBootState?.runtime?.ownerKind ?? healthQuery.data?.runtimeOwnerKind ?? null;
  const instanceRoot = desktopBootState?.paths?.instanceRoot ?? null;

  async function openExternal(target: string) {
    const desktopShell = readDesktopShell();
    if (desktopShell) {
      await desktopShell.openExternal(target);
      return;
    }
    window.open(target, "_blank", "noopener,noreferrer");
  }

  async function handleCheckForUpdates() {
    const desktopShell = readDesktopShell();
    setActionError(null);

    if (!desktopShell) {
      setUpdateResult(null);
      await openExternal(RELEASES_URL);
      pushToast({
        title: t("about.updates.browserFallback.toastTitle"),
        body: t("about.updates.browserFallback.toastBody"),
        tone: "info",
      });
      return;
    }

    setCheckUpdatesPending(true);
    try {
      const result = await desktopShell.checkForUpdates();
      setUpdateResult(result);
      const feedback = buildUpdateFeedback(t, result);
      pushToast(feedback);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("about.updates.failed");
      setActionError(message);
      pushToast({
        title: t("about.updates.failedToastTitle"),
        body: message,
        tone: "error",
      });
    } finally {
      setCheckUpdatesPending(false);
    }
  }

  async function handleSendFeedback() {
    const desktopShell = readDesktopShell();
    setActionError(null);

    try {
      if (desktopShell) {
        await desktopShell.sendFeedback();
      } else {
        window.location.href = FEEDBACK_MAILTO;
      }
      pushToast({
        title: t("about.feedback.toastTitle"),
        body: t("about.feedback.toastBody"),
        tone: "info",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("about.feedback.failed");
      setActionError(message);
      pushToast({
        title: t("about.feedback.failedToastTitle"),
        body: message,
        tone: "error",
      });
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-7 px-1 pb-6">
      <SettingsPageHeader
        icon={Info}
        title={t("about.title")}
        description={t("about.description")}
      />

      {actionError ? (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <SettingsDivider />

      <SettingsSection
        title={t("about.version.title")}
        description={t("about.version.description")}
      >
        <div className="grid gap-2.5">
          <div className="rounded-[calc(var(--radius-md)-1px)] border border-border/70 bg-card/60 px-3.5 py-3">
            <div className="text-[11px] font-medium text-muted-foreground">{t("about.version.current")}</div>
            <div className="mt-2 text-sm font-medium text-foreground">
              {formatVersion(currentVersion, t("common.unknown"))}
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsDivider />

      <SettingsSection
        title={t("about.desktop.title")}
        description={t("about.desktop.description")}
      >
        <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-[calc(var(--radius-md)-1px)] border border-border/70 bg-card/60 px-3.5 py-3">
            <div className="text-[11px] font-medium text-muted-foreground">{t("about.desktop.profile")}</div>
            <div className="mt-2 text-sm font-medium text-foreground">
              {formatEnvironmentValue(environment, t("common.unknown"))}
            </div>
          </div>
          <div className="rounded-[calc(var(--radius-md)-1px)] border border-border/70 bg-card/60 px-3.5 py-3">
            <div className="text-[11px] font-medium text-muted-foreground">{t("about.desktop.instance")}</div>
            <div className="mt-2 text-sm font-medium text-foreground">{instance ?? t("common.unknown")}</div>
          </div>
          {runtimeMode ? (
            <div className="rounded-[calc(var(--radius-md)-1px)] border border-border/70 bg-card/60 px-3.5 py-3">
              <div className="text-[11px] font-medium text-muted-foreground">{t("about.desktop.runtime")}</div>
              <div className="mt-2 text-sm font-medium text-foreground">
                {formatDesktopValue(runtimeMode, t("common.unknown"))}
              </div>
            </div>
          ) : null}
          {ownerKind ? (
            <div className="rounded-[calc(var(--radius-md)-1px)] border border-border/70 bg-card/60 px-3.5 py-3">
              <div className="text-[11px] font-medium text-muted-foreground">{t("about.desktop.owner")}</div>
              <div className="mt-2 text-sm font-medium text-foreground">
                {formatDesktopValue(ownerKind, t("common.unknown"))}
              </div>
            </div>
          ) : null}
          {instanceRoot ? (
            <div className="rounded-[calc(var(--radius-md)-1px)] border border-border/70 bg-card/60 px-3.5 py-3 md:col-span-2 xl:col-span-3">
              <div className="text-[11px] font-medium text-muted-foreground">{t("about.desktop.instanceDataPath")}</div>
              <div className="mt-2 break-all font-mono text-sm text-foreground">
                {instanceRoot}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsDivider />

      <SettingsSection
        title={t("about.actions.title")}
        description={t("about.actions.description")}
      >
        <SettingsRow
          title={t("about.updates.title")}
          description={(
            <div className="space-y-1">
              <div>{t("about.updates.description")}</div>
              {updateResult ? (
                <div className="text-[12px]">
                  {updateResult.status === "update-available"
                    ? t("about.updates.available.inline", {
                      latestVersion: formatVersion(updateResult.latestVersion, t("common.unknown")),
                    })
                    : updateResult.status === "up-to-date"
                      ? t("about.updates.current.inline", {
                        currentVersion: formatVersion(updateResult.currentVersion, t("common.unknown")),
                      })
                      : t("about.updates.unavailable.inline")}
                </div>
              ) : null}
            </div>
          )}
          action={(
            <div className="flex items-center gap-2">
              {updateResult?.status === "update-available" && updateResult.releaseUrl ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openExternal(updateResult.releaseUrl!)}
                >
                  {t("about.updates.openRelease")}
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleCheckForUpdates()}
                disabled={checkUpdatesPending}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${checkUpdatesPending ? "animate-spin" : ""}`} />
                {t("about.updates.check")}
              </Button>
            </div>
          )}
        />

        <SettingsRow
          title={t("about.feedback.title")}
          description={t("about.feedback.description")}
          action={(
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleSendFeedback()}
            >
              <Mail className="mr-2 h-4 w-4" />
              {t("about.feedback.send")}
            </Button>
          )}
        />
      </SettingsSection>
    </div>
  );
}
