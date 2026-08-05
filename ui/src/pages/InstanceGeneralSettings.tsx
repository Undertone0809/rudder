import { instanceSettingsApi } from "@/api/instanceSettings";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import {
  SettingsChoiceCard,
  SettingsChoiceGrid,
  SettingsGroup,
  SettingsItem,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import {
  readDesktopShell,
  type DesktopUpdateChannel,
} from "@/lib/desktop-shell";
import { DEFAULT_ORGANIZATION_HOME_PATH } from "@/lib/organization-routes";
import { useNavigate } from "@/lib/router";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Map, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useI18n } from "../context/I18nContext";
import { queryKeys } from "../lib/queryKeys";

function LanguagePreview({
  primary,
  secondary,
}: {
  primary: string;
  secondary: string;
}) {
  return (
    <div className="grid gap-2">
      <div className="rounded-[calc(var(--radius-md)-4px)] border border-white/8 bg-[color:color-mix(in_oklab,var(--surface-shell)_82%,transparent)] p-3">
        <div className="text-sm font-semibold text-foreground">{primary}</div>
        <div className="mt-1 text-xs text-muted-foreground">{secondary}</div>
      </div>
    </div>
  );
}

export function InstanceGeneralSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openProductTour } = useDialog();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [desktopUpdatesSupported, setDesktopUpdatesSupported] = useState(false);
  const [updateChannel, setUpdateChannel] = useState<DesktopUpdateChannel>("stable");
  const [updateChannelPending, setUpdateChannelPending] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("common.general") },
    ]);
  }, [setBreadcrumbs, t]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });
  useEffect(() => {
    const desktopShell = readDesktopShell();
    const supported = Boolean(desktopShell?.getUpdateChannel && desktopShell?.setUpdateChannel);
    setDesktopUpdatesSupported(supported);
    if (!supported || !desktopShell?.getUpdateChannel) return;

    let cancelled = false;
    void desktopShell.getUpdateChannel()
      .then((channel) => {
        if (!cancelled) setUpdateChannel(channel);
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopUpdatesSupported(false);
          setUpdateChannel("stable");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleMutation = useMutation({
    mutationFn: async (patch: { censorUsernameInLogs?: boolean; showDeveloperDiagnostics?: boolean; locale?: "en" | "zh-CN" }) =>
      instanceSettingsApi.updateGeneral(patch),
    onSuccess: async (nextSettings) => {
      setActionError(null);
      queryClient.setQueryData(queryKeys.instance.generalSettings, nextSettings);
      queryClient.setQueryData(queryKeys.health, (current: { uiLocale?: "en" | "zh-CN" } | undefined) =>
        current ? { ...current, uiLocale: nextSettings.locale } : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("general.updateFailed"));
    },
  });
  if (generalQuery.isLoading) {
    return <SettingsPageSkeleton />;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : t("general.loadFailed")}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const showDeveloperDiagnostics = generalQuery.data?.showDeveloperDiagnostics === true;
  const locale = generalQuery.data?.locale ?? "en";

  async function handleUpdateChannelToggle() {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.setUpdateChannel) {
      setActionError(t("general.updates.unavailable"));
      return;
    }

    const nextChannel: DesktopUpdateChannel = updateChannel === "canary" ? "stable" : "canary";
    setUpdateChannelPending(true);
    try {
      const savedChannel = await desktopShell.setUpdateChannel(nextChannel);
      setUpdateChannel(savedChannel);
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("general.updates.updateFailed"));
    } finally {
      setUpdateChannelPending(false);
    }
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        icon={SlidersHorizontal}
        title={t("general.title")}
        description={t("general.description")}
      />

      {actionError ? (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <SettingsSection title={t("general.basics.title")}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3">
            <div className="text-sm font-medium text-foreground">{t("general.language.title")}</div>
            <SettingsChoiceGrid>
              <SettingsChoiceCard
                label={t("general.language.option.en.label")}
                description={t("general.language.option.en.description")}
                selected={locale === "en"}
                onClick={() => toggleMutation.mutate({ locale: "en" })}
                preview={
                  <LanguagePreview
                    primary={t("general.language.preview.en.primary")}
                    secondary={t("general.language.preview.en.secondary")}
                  />
                }
              />
              <SettingsChoiceCard
                label={t("general.language.option.zh-CN.label")}
                description={t("general.language.option.zh-CN.description")}
                selected={locale === "zh-CN"}
                onClick={() => toggleMutation.mutate({ locale: "zh-CN" })}
                preview={
                  <LanguagePreview
                    primary={t("general.language.preview.zh-CN.primary")}
                    secondary={t("general.language.preview.zh-CN.secondary")}
                  />
                }
              />
            </SettingsChoiceGrid>
          </div>

          <SettingsGroup>
            <SettingsItem
              title={t("general.productTour.title")}
              description={t("general.productTour.description")}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigate(DEFAULT_ORGANIZATION_HOME_PATH);
                    window.setTimeout(() => openProductTour({ source: "settings" }), 0);
                  }}
                >
                  <Map data-icon="inline-start" />
                  {t("general.productTour.start")}
                </Button>
              }
            />
          </SettingsGroup>
        </div>
      </SettingsSection>

      {desktopUpdatesSupported ? (
        <SettingsSection title={t("general.updates.title")}>
          <SettingsGroup>
            <SettingsItem
              title={t("general.updates.canary.title")}
              description={updateChannel === "canary"
                ? t("general.updates.canary.enabledDescription")
                : t("general.updates.canary.disabledDescription")}
              action={
                <SettingsToggle
                  checked={updateChannel === "canary"}
                  aria-label="Toggle canary desktop updates"
                  disabled={updateChannelPending}
                  onClick={() => void handleUpdateChannelToggle()}
                />
              }
            />
          </SettingsGroup>
        </SettingsSection>
      ) : null}

      <SettingsSection title={t("general.developer.title")}>
        <SettingsGroup>
          <SettingsItem
            title={t("general.logs.censor.title")}
            description={t("general.logs.censor.description")}
            action={
              <SettingsToggle
                checked={censorUsernameInLogs}
                aria-label="Toggle username log censoring"
                disabled={toggleMutation.isPending}
                onClick={() => toggleMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
              />
            }
          />

          <SettingsItem
            title={t("general.diagnostics.developer.title")}
            description={t("general.diagnostics.developer.description")}
            action={
              <SettingsToggle
                checked={showDeveloperDiagnostics}
                aria-label="Toggle developer diagnostics"
                disabled={toggleMutation.isPending}
                onClick={() => toggleMutation.mutate({ showDeveloperDiagnostics: !showDeveloperDiagnostics })}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
