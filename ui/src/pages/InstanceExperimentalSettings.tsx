import { instanceSettingsApi } from "@/api/instanceSettings";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import {
  SettingsGroup,
  SettingsItem,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { useI18n } from "@/context/I18nContext";
import { readDesktopShell } from "@/lib/desktop-shell";
import { queryKeys } from "@/lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Beaker, FlaskConical, Target } from "lucide-react";
import { useEffect, useState } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";

export function InstanceExperimentalSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("common.experimental") },
    ]);
  }, [setBreadcrumbs, t]);

  const settingsQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });
  const updateMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const nextSettings = await instanceSettingsApi.updateGeneral({
        experimentalSitesEnabled: enabled,
      });
      if (!enabled) {
        const localApps = readDesktopShell()?.localApps;
        if (localApps?.supported) {
          const definitions = await localApps.list();
          await Promise.all(definitions.map(async (definition) => {
            const status = await localApps.status(definition.id);
            if (["running", "starting", "stopping"].includes(status.status)) {
              await localApps.stop(definition.id);
            }
          }));
        }
      }
      return nextSettings;
    },
    onSuccess: async (nextSettings) => {
      setActionError(null);
      queryClient.setQueryData(queryKeys.instance.generalSettings, nextSettings);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.instance.generalSettings,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    },
    onError: (error) => {
      setActionError(
        error instanceof Error ? error.message : t("experimental.updateFailed"),
      );
    },
  });
  const goalsUpdateMutation = useMutation({
    mutationFn: (enabled: boolean) => instanceSettingsApi.updateGeneral({
      experimentalGoalsEnabled: enabled,
    }),
    onSuccess: async (nextSettings) => {
      setActionError(null);
      queryClient.setQueryData(queryKeys.instance.generalSettings, nextSettings);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.instance.generalSettings,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    },
    onError: (error) => {
      setActionError(
        error instanceof Error ? error.message : t("experimental.updateFailed"),
      );
    },
  });

  if (settingsQuery.isLoading) return <SettingsPageSkeleton />;
  if (settingsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {settingsQuery.error instanceof Error
          ? settingsQuery.error.message
          : t("experimental.loadFailed")}
      </div>
    );
  }

  const enabled = settingsQuery.data?.experimentalSitesEnabled === true;
  const goalsEnabled = settingsQuery.data?.experimentalGoalsEnabled === true;

  return (
    <SettingsPage>
      <SettingsPageHeader
        icon={Beaker}
        title={t("experimental.title")}
        description={t("experimental.description")}
      />

      {actionError ? (
        <div
          className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {actionError}
        </div>
      ) : null}

      <SettingsSection title={t("experimental.sites.section")}>
        <SettingsGroup>
          <SettingsItem
            title={t("experimental.sites.title")}
            description={enabled
              ? t("experimental.sites.enabledDescription")
              : t("experimental.sites.disabledDescription")}
            icon={FlaskConical}
            action={
              <SettingsToggle
                checked={enabled}
                disabled={updateMutation.isPending}
                aria-label={t("experimental.sites.toggle")}
                data-testid="experimental-sites-toggle"
                onClick={() => updateMutation.mutate(!enabled)}
              />
            }
          />
        </SettingsGroup>
        <p className="mt-3 max-w-3xl text-xs leading-5 text-muted-foreground">
          {t("experimental.sites.notice")}
        </p>
      </SettingsSection>

      <SettingsSection title={t("experimental.goals.section")}>
        <SettingsGroup>
          <SettingsItem
            title={t("experimental.goals.title")}
            description={goalsEnabled
              ? t("experimental.goals.enabledDescription")
              : t("experimental.goals.disabledDescription")}
            icon={Target}
            action={
              <SettingsToggle
                checked={goalsEnabled}
                disabled={goalsUpdateMutation.isPending}
                aria-label={t("experimental.goals.toggle")}
                data-testid="experimental-goals-toggle"
                onClick={() => goalsUpdateMutation.mutate(!goalsEnabled)}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
