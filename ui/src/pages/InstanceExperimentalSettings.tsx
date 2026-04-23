import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  SettingsDivider,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";
import { queryKeys } from "../lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";

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

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

  const toggleMutation = useMutation({
    mutationFn: async (patch: { autoRestartDevServerWhenIdle?: boolean }) =>
      instanceSettingsApi.updateExperimental(patch),
    onSuccess: async () => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("experimental.updateFailed"));
    },
  });

  if (experimentalQuery.isLoading) {
    return <SettingsPageSkeleton dense />;
  }

  if (experimentalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {experimentalQuery.error instanceof Error
          ? experimentalQuery.error.message
          : t("experimental.loadFailed")}
      </div>
    );
  }

  const autoRestartDevServerWhenIdle = experimentalQuery.data?.autoRestartDevServerWhenIdle === true;

  return (
    <div className="mx-auto max-w-4xl space-y-7 px-1 pb-6">
      <SettingsPageHeader
        eyebrow={t("settings.eyebrow.labs")}
        icon={FlaskConical}
        title={t("experimental.title")}
        description={t("experimental.description")}
      />

      {actionError ? (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <SettingsDivider />

      <SettingsSection
        title={t("experimental.developer.title")}
        description={t("experimental.developer.description")}
      >
        <SettingsRow
          title={t("experimental.developer.autorestart.title")}
          description={t("experimental.developer.autorestart.description")}
          action={
            <SettingsToggle
              checked={autoRestartDevServerWhenIdle}
              aria-label="Toggle guarded dev-server auto-restart"
              disabled={toggleMutation.isPending}
              onClick={() =>
                toggleMutation.mutate({ autoRestartDevServerWhenIdle: !autoRestartDevServerWhenIdle })
              }
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
