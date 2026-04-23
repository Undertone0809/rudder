import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ActivitySquare, AlertTriangle, KeyRound, Link2 } from "lucide-react";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  SettingsDivider,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useI18n } from "@/context/I18nContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";

type FormState = {
  enabled: boolean;
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  environment: string;
};

function normalizeFormState(input: {
  enabled: boolean;
  baseUrl: string;
  publicKey: string;
  environment: string;
}): FormState {
  return {
    enabled: input.enabled,
    baseUrl: input.baseUrl,
    publicKey: input.publicKey,
    secretKey: "",
    environment: input.environment,
  };
}

export function InstanceLangfuseSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>({
    enabled: false,
    baseUrl: "http://localhost:3000",
    publicKey: "",
    secretKey: "",
    environment: "",
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [clearSecretKey, setClearSecretKey] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("common.langfuse") },
    ]);
  }, [setBreadcrumbs, t]);

  const settingsQuery = useQuery({
    queryKey: queryKeys.instance.langfuseSettings,
    queryFn: () => instanceSettingsApi.getLangfuse(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

  useEffect(() => {
    if (!settingsQuery.data) return;
    setForm(normalizeFormState(settingsQuery.data));
    setClearSecretKey(false);
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () =>
      instanceSettingsApi.updateLangfuse({
        enabled: form.enabled,
        baseUrl: form.baseUrl.trim(),
        publicKey: form.publicKey,
        secretKey: form.secretKey,
        environment: form.environment,
        ...(clearSecretKey ? { clearSecretKey: true } : {}),
      }),
    onSuccess: async (next) => {
      setActionError(null);
      setForm(normalizeFormState(next));
      setClearSecretKey(false);
      setRestartRequired(true);
      queryClient.setQueryData(queryKeys.instance.langfuseSettings, next);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.langfuseSettings });
      pushToast({
        title: t("langfuse.saved.title"),
        body: t("langfuse.saved.body"),
        tone: "success",
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : t("langfuse.updateFailed");
      setActionError(message);
      pushToast({
        title: t("langfuse.saveFailed.title"),
        body: message,
        tone: "error",
      });
    },
  });

  const normalizedCurrent = useMemo(
    () => (settingsQuery.data ? normalizeFormState(settingsQuery.data) : null),
    [settingsQuery.data],
  );
  const hasChanges = useMemo(() => {
    if (!normalizedCurrent) return false;
    return (
      form.enabled !== normalizedCurrent.enabled
      || form.baseUrl !== normalizedCurrent.baseUrl
      || form.publicKey !== normalizedCurrent.publicKey
      || form.environment !== normalizedCurrent.environment
      || form.secretKey.trim().length > 0
      || clearSecretKey
    );
  }, [clearSecretKey, form, normalizedCurrent]);

  if (settingsQuery.isLoading) {
    return <SettingsPageSkeleton />;
  }

  if (settingsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {settingsQuery.error instanceof Error
          ? settingsQuery.error.message
          : t("langfuse.loadFailed")}
      </div>
    );
  }

  const settings = settingsQuery.data;
  if (!settings) return null;

  const readOnly = saveMutation.isPending || settings.managedByEnv;
  const instanceTag = `instance:${healthQuery.data?.instanceId ?? "current-instance"}`;
  const releaseTag = `release:${healthQuery.data?.version ?? "current-release"}`;
  const envRestartPending =
    settings.managedByEnv
    && healthQuery.data?.devServer?.enabled
    && healthQuery.data.devServer.restartRequired
    && healthQuery.data.devServer.envFileChanged;
  const currentRuntimeEnvironment = settings.environment || t("langfuse.environment.unset");

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-1 pb-6">
      <SettingsPageHeader
        icon={ActivitySquare}
        title={t("langfuse.title")}
        description={t("langfuse.description")}
      />

      {settings.managedByEnv ? (
        <div className="rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <div className="font-medium">{t("langfuse.envManaged.title")}</div>
              <div>{t("langfuse.envManaged.description")}</div>
            </div>
          </div>
        </div>
      ) : null}

      {envRestartPending ? (
        <div className="rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <div className="font-medium">{t("langfuse.envManagedRestartPending.title")}</div>
              <div>
                {t("langfuse.envManagedRestartPending.description", {
                  environment: currentRuntimeEnvironment,
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {restartRequired ? (
        <div className="rounded-[var(--radius-md)] border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-200">
          <div className="font-medium">{t("langfuse.restartRequired.title")}</div>
          <div className="mt-1">{t("langfuse.restartRequired.description")}</div>
        </div>
      ) : null}

      {actionError ? (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <SettingsDivider />

      <SettingsSection
        title={t("langfuse.section.connection.title")}
        description={t("langfuse.section.connection.description")}
      >
        <SettingsRow
          title={t("langfuse.enabled.title")}
          description={t("langfuse.enabled.description")}
          action={
            <SettingsToggle
              checked={form.enabled}
              aria-label={t("langfuse.enabled.title")}
              disabled={readOnly}
              onClick={() => {
                setRestartRequired(false);
                setForm((current) => ({ ...current, enabled: !current.enabled }));
              }}
            />
          }
        />

        <div className="space-y-5 border-t border-[color:color-mix(in_oklab,var(--border-soft)_82%,transparent)] pt-4">
          <div className="space-y-2">
            <label htmlFor="langfuse-base-url" className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Link2 className="h-4 w-4 text-muted-foreground" />
              {t("langfuse.baseUrl.label")}
            </label>
            <Input
              id="langfuse-base-url"
              value={form.baseUrl}
              disabled={readOnly}
              onChange={(event) => {
                setRestartRequired(false);
                setForm((current) => ({ ...current, baseUrl: event.target.value }));
              }}
              placeholder="https://cloud.langfuse.com"
            />
            <p className="text-xs leading-5 text-muted-foreground">{t("langfuse.baseUrl.help")}</p>
          </div>

          <div className="space-y-2">
            <label htmlFor="langfuse-public-key" className="flex items-center gap-2 text-sm font-medium text-foreground">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              {t("langfuse.publicKey.label")}
            </label>
            <Input
              id="langfuse-public-key"
              value={form.publicKey}
              disabled={readOnly}
              onChange={(event) => {
                setRestartRequired(false);
                setForm((current) => ({ ...current, publicKey: event.target.value }));
              }}
              placeholder="pk-lf-..."
            />
            <p className="text-xs leading-5 text-muted-foreground">{t("langfuse.publicKey.help")}</p>
          </div>

          <div className="space-y-2">
            <label htmlFor="langfuse-secret-key" className="flex items-center gap-2 text-sm font-medium text-foreground">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              {t("langfuse.secretKey.label")}
            </label>
            <Input
              id="langfuse-secret-key"
              type="password"
              value={form.secretKey}
              disabled={readOnly || clearSecretKey}
              onChange={(event) => {
                setRestartRequired(false);
                setClearSecretKey(false);
                setForm((current) => ({ ...current, secretKey: event.target.value }));
              }}
              placeholder="sk-lf-..."
            />
            <p className="text-xs leading-5 text-muted-foreground">{t("langfuse.secretKey.help")}</p>
            <p className="text-xs leading-5 text-muted-foreground">
              {settings.secretKeyConfigured
                ? t("langfuse.secretKey.configured")
                : t("langfuse.secretKey.notConfigured")}
            </p>
            {settings.secretKeyConfigured ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={readOnly}
                  onClick={() => {
                    setRestartRequired(false);
                    setForm((current) => ({ ...current, secretKey: "" }));
                    setClearSecretKey((current) => !current);
                  }}
                >
                  {t("langfuse.secretKey.clear")}
                </Button>
                {clearSecretKey ? (
                  <span className="text-xs text-amber-700 dark:text-amber-300">
                    {t("langfuse.secretKey.clearPending")}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <label htmlFor="langfuse-environment" className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ActivitySquare className="h-4 w-4 text-muted-foreground" />
              {t("langfuse.environment.label")}
            </label>
            <Input
              id="langfuse-environment"
              value={form.environment}
              disabled={readOnly}
              onChange={(event) => {
                setRestartRequired(false);
                setForm((current) => ({ ...current, environment: event.target.value }));
              }}
              placeholder={t("langfuse.environment.placeholder")}
            />
            <p className="text-xs leading-5 text-muted-foreground">{t("langfuse.environment.help")}</p>
            <div className="rounded-[calc(var(--radius-md)-1px)] border border-border/70 bg-card/60 px-3.5 py-3">
              <div className="text-[11px] font-medium text-muted-foreground">{t("langfuse.tags.title")}</div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {t("langfuse.tags.description", {
                  instanceTag,
                  releaseTag,
                })}
              </p>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsDivider />

      <SettingsSection
        title={t("langfuse.section.behavior.title")}
        description={t("langfuse.section.behavior.description")}
      >
        <SettingsRow
          title={t("langfuse.restartRequired.title")}
          description={t("langfuse.restartRequired.description")}
        />

        <div className="flex items-center justify-end pt-2">
          <Button onClick={() => saveMutation.mutate()} disabled={!hasChanges || readOnly}>
            {saveMutation.isPending ? t("langfuse.saving") : t("langfuse.save")}
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
