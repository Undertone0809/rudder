import { instanceSettingsApi, type ProductAnalyticsSettings } from "@/api/instanceSettings";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import {
  SettingsField,
  SettingsGroup,
  SettingsItem,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/context/I18nContext";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "../lib/settings-prefetch";

function readableTimestamp(value: string | null, neverLabel: string) {
  return value ? formatDateTime(value) : neverLabel;
}

function modeLabel(mode: ProductAnalyticsSettings["mode"]) {
  if (mode === "anonymous") return "privacyTelemetry.mode.anonymous" as const;
  if (mode === "account_linked") return "privacyTelemetry.mode.accountLinked" as const;
  return "privacyTelemetry.mode.off" as const;
}

export function InstancePrivacyTelemetrySettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [showPayload, setShowPayload] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("common.privacyTelemetry") },
    ]);
  }, [setBreadcrumbs, t]);

  const telemetryQuery = useQuery({
    queryKey: queryKeys.instance.productAnalyticsSettings,
    queryFn: () => instanceSettingsApi.getProductAnalytics(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });
  const telemetryMutation = useMutation({
    mutationFn: (mode: ProductAnalyticsSettings["mode"]) => instanceSettingsApi.updateProductAnalytics(mode),
    onSuccess: async () => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.productAnalyticsSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("privacyTelemetry.updateFailed"));
    },
  });

  if (telemetryQuery.isLoading) return <SettingsPageSkeleton dense />;
  if (telemetryQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {telemetryQuery.error instanceof Error ? telemetryQuery.error.message : t("privacyTelemetry.loadFailed")}
      </div>
    );
  }

  const settings = telemetryQuery.data;
  if (!settings) return null;

  const setMode = (mode: ProductAnalyticsSettings["mode"]) => {
    if (settings.mode === mode || telemetryMutation.isPending) return;
    telemetryMutation.mutate(mode);
  };

  return (
    <SettingsPage width="wide" className="gap-4 pb-24 sm:gap-7 sm:pb-10" data-testid="product-analytics-settings">
      <SettingsPageHeader
        eyebrow={t("settings.eyebrow.system")}
        icon={ShieldCheck}
        title={t("privacyTelemetry.title")}
        description={t("privacyTelemetry.description")}
      />

      {actionError ? (
        <div className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <SettingsSection title={t("privacyTelemetry.mode.title")} description={t("privacyTelemetry.mode.description")}>
        <SettingsGroup variant="feature">
          <SettingsItem
            title={t("privacyTelemetry.anonymous.title")}
            description={t("privacyTelemetry.anonymous.description")}
            action={(
              <SettingsToggle
                checked={settings.mode === "anonymous"}
                aria-label={t("privacyTelemetry.anonymous.toggle")}
                disabled={telemetryMutation.isPending}
                onClick={() => setMode(settings.mode === "anonymous" ? "off" : "anonymous")}
              />
            )}
          />
          <SettingsItem
            title={t("privacyTelemetry.accountLinked.title")}
            description={t("privacyTelemetry.accountLinked.description")}
            action={(
              <SettingsToggle
                checked={settings.mode === "account_linked"}
                aria-label={t("privacyTelemetry.accountLinked.toggle")}
                disabled={telemetryMutation.isPending}
                onClick={() => setMode(settings.mode === "account_linked" ? "off" : "account_linked")}
              />
            )}
          />
        </SettingsGroup>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {settings.mode === "off" ? <X className="size-3.5" /> : <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
          <span>{t("privacyTelemetry.currentMode", { mode: t(modeLabel(settings.mode)) })}</span>
        </div>
      </SettingsSection>

      <SettingsSection title={t("privacyTelemetry.disclosure.title")} description={t("privacyTelemetry.disclosure.description")}>
        <SettingsGroup>
          <SettingsField label={t("privacyTelemetry.disclosure.collected")}>
            <ul className="grid gap-1.5 text-[13px] text-muted-foreground sm:grid-cols-2">
              {settings.disclosure.collected.map((item) => <li key={item} className="flex gap-2"><Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />{item}</li>)}
            </ul>
          </SettingsField>
          <SettingsField label={t("privacyTelemetry.disclosure.excluded")}>
            <ul className="grid gap-1.5 text-[13px] text-muted-foreground sm:grid-cols-2">
              {settings.disclosure.excluded.map((item) => <li key={item} className="flex gap-2"><X className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{item}</li>)}
            </ul>
          </SettingsField>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t("privacyTelemetry.delivery.title")} description={t("privacyTelemetry.delivery.description")}>
        <SettingsGroup>
          <SettingsItem
            title={t("privacyTelemetry.delivery.installationId")}
            description={t("privacyTelemetry.delivery.installationIdDescription")}
            action={<code className="rounded bg-muted px-2 py-1 text-xs text-foreground">{settings.maskedInstallationId ?? t("privacyTelemetry.never")}</code>}
          />
          <SettingsItem
            title={t("privacyTelemetry.delivery.lastAttempted")}
            action={<span className="text-xs tabular-nums text-muted-foreground">{readableTimestamp(settings.lastAttemptedAt, t("privacyTelemetry.never"))}</span>}
          />
          <SettingsItem
            title={t("privacyTelemetry.delivery.lastSucceeded")}
            action={<span className="text-xs tabular-nums text-muted-foreground">{readableTimestamp(settings.lastSucceededAt, t("privacyTelemetry.never"))}</span>}
          />
          <SettingsItem
            title={t("privacyTelemetry.delivery.pending")}
            description={settings.coverageGap ? t("privacyTelemetry.delivery.coverageGap") : undefined}
            action={<span className="text-xs tabular-nums text-muted-foreground">{settings.pendingCount}</span>}
          />
          <SettingsItem
            title={t("privacyTelemetry.delivery.lastError")}
            action={<span className={settings.lastErrorCode ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>{settings.lastErrorCode ?? t("privacyTelemetry.none")}</span>}
          />
          <SettingsItem
            title={t("privacyTelemetry.delivery.lastPayload")}
            description={settings.lastPayloadAt ? readableTimestamp(settings.lastPayloadAt, t("privacyTelemetry.never")) : t("privacyTelemetry.delivery.noPayload")}
            action={(
              <Button variant="outline" size="sm" onClick={() => setShowPayload((current) => !current)} disabled={!settings.lastPayload}>
                <Eye className="size-3.5" />
                {showPayload ? t("privacyTelemetry.delivery.hidePayload") : t("privacyTelemetry.delivery.viewPayload")}
              </Button>
            )}
          />
          {showPayload && settings.lastPayload ? (
            <pre className="mx-4 mb-4 max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-5 text-foreground">
              {JSON.stringify(settings.lastPayload, null, 2)}
            </pre>
          ) : null}
        </SettingsGroup>
      </SettingsSection>

      <p className="text-xs leading-5 text-muted-foreground">
        {t("privacyTelemetry.footer")}
      </p>
    </SettingsPage>
  );
}
