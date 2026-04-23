import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  SettingsChoiceCard,
  SettingsDivider,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";
import { useTheme } from "../context/ThemeContext";
import { queryKeys } from "../lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";

function ThemePreview({ mode }: { mode: "light" | "system" | "dark" }) {
  return (
    <div className="grid gap-2">
      <div
        className="h-14 rounded-[calc(var(--radius-md)-4px)] border border-white/8"
        style={{
          background:
            mode === "light"
              ? "linear-gradient(180deg, #f4efe7 0%, #ece6dd 100%)"
              : mode === "dark"
                ? "linear-gradient(180deg, #312c28 0%, #262220 100%)"
                : "linear-gradient(90deg, #f1ece5 0%, #f1ece5 50%, #2b2724 50%, #2b2724 100%)",
        }}
      >
        <div className="flex h-full flex-col justify-between p-2.5">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div
                className="h-1.5 w-10 rounded-full"
                style={{ background: mode === "dark" ? "rgb(255 255 255 / 0.28)" : "rgb(50 45 40 / 0.14)" }}
              />
              <div
                className="h-1.5 w-7 rounded-full"
                style={{ background: mode === "dark" ? "rgb(255 255 255 / 0.18)" : "rgb(50 45 40 / 0.10)" }}
              />
            </div>
            <div
              className="rounded-full px-2 py-1"
              style={{ background: mode === "dark" ? "rgb(0 0 0 / 0.38)" : "rgb(255 255 255 / 0.52)" }}
            >
              <div
                className="h-1.5 w-6 rounded-full"
                style={{ background: mode === "dark" ? "rgb(255 255 255 / 0.28)" : "rgb(50 45 40 / 0.14)" }}
              />
            </div>
          </div>
          <div
            className="flex items-center justify-between rounded-[12px] border px-2 py-1.5"
            style={{
              background: mode === "dark" ? "rgb(255 255 255 / 0.10)" : "rgb(255 255 255 / 0.68)",
              borderColor: mode === "dark" ? "rgb(255 255 255 / 0.10)" : "rgb(50 45 40 / 0.08)",
            }}
          >
            <div
              className="h-1.5 w-12 rounded-full"
              style={{ background: mode === "dark" ? "rgb(255 255 255 / 0.20)" : "rgb(50 45 40 / 0.12)" }}
            />
            <div className="h-2.5 w-2.5 rounded-full bg-[color:var(--accent-base)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

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
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const { theme, setTheme } = useTheme();

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

  const toggleMutation = useMutation({
    mutationFn: async (patch: { censorUsernameInLogs?: boolean; locale?: "en" | "zh-CN" }) =>
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
  const locale = generalQuery.data?.locale ?? "en";

  return (
    <div className="mx-auto max-w-4xl space-y-7 px-1 pb-6">
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

      <SettingsDivider />

      <SettingsSection
        title={t("general.language.title")}
        description={t("general.language.description")}
      >
        <div className="space-y-3">
          <div className="text-sm font-medium text-foreground">{t("general.language.label")}</div>
          <div className="flex flex-wrap gap-2.5">
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
          </div>
        </div>
      </SettingsSection>

      <SettingsDivider />

      <SettingsSection
        title={t("general.logs.title")}
        description={t("general.logs.description")}
      >
        <SettingsRow
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
      </SettingsSection>

      <SettingsDivider />

      <SettingsSection
        title={t("general.appearance.title")}
        description={t("general.appearance.description")}
      >
        <div className="space-y-3">
          <div className="text-sm font-medium text-foreground">{t("general.appearance.colorMode")}</div>
          <div className="flex flex-wrap gap-2.5">
            <SettingsChoiceCard
              label={t("general.appearance.light.label")}
              description={t("general.appearance.light.description")}
              selected={theme === "light"}
              onClick={() => setTheme("light")}
              preview={<ThemePreview mode="light" />}
            />
            <SettingsChoiceCard
              label={t("general.appearance.system.label")}
              description={t("general.appearance.system.description")}
              selected={theme === "system"}
              onClick={() => setTheme("system")}
              preview={<ThemePreview mode="system" />}
            />
            <SettingsChoiceCard
              label={t("general.appearance.dark.label")}
              description={t("general.appearance.dark.description")}
              selected={theme === "dark"}
              onClick={() => setTheme("dark")}
              preview={<ThemePreview mode="dark" />}
            />
          </div>
        </div>

      </SettingsSection>
    </div>
  );
}
