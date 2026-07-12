import { instanceSettingsApi } from "@/api/instanceSettings";
import { BrowserDataImportDialog } from "@/components/BrowserDataImportDialog";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import {
  SettingsDivider,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialog } from "@/context/DialogContext";
import { useI18n } from "@/context/I18nContext";
import { readDesktopShell } from "@/lib/desktop-shell";
import { queryKeys } from "@/lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import type { PatchInstanceBrowserSettings } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Globe2, Import, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

export function InstanceBrowserSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { confirm } = useDialog();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [clearSucceeded, setClearSucceeded] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("common.browser") },
    ]);
  }, [setBreadcrumbs, t]);

  const browserQuery = useQuery({
    queryKey: queryKeys.instance.browserSettings,
    queryFn: () => instanceSettingsApi.getBrowser(),
    staleTime: SETTINGS_PREFETCH_STALE_TIME_MS,
  });

  const updateMutation = useMutation({
    mutationFn: (patch: PatchInstanceBrowserSettings) => instanceSettingsApi.updateBrowser(patch),
    onSuccess: async (nextSettings, patch) => {
      setActionError(null);
      setClearSucceeded(false);
      queryClient.setQueryData(queryKeys.instance.browserSettings, nextSettings);

      if (typeof patch.enabled === "boolean") {
        const desktopShell = readDesktopShell();
        if (desktopShell?.setBrowserEnabled) {
          try {
            await desktopShell.setBrowserEnabled(patch.enabled);
          } catch {
            setActionError(t("browser.updateFailed"));
          }
        }
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.browserSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("browser.updateFailed"));
    },
  });

  if (browserQuery.isLoading) return <SettingsPageSkeleton dense />;

  if (browserQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {browserQuery.error instanceof Error ? browserQuery.error.message : t("browser.loadFailed")}
      </div>
    );
  }

  const settings = browserQuery.data ?? { enabled: true, openLinksIn: "built_in" as const };
  const desktopShell = readDesktopShell();
  const canImport = Boolean(desktopShell?.listBrowserImportSources && desktopShell.importBrowserData);
  const canClear = Boolean(desktopShell?.clearBrowserData);
  const nativeActionsUnavailable = !canImport || !canClear;

  async function handleClear() {
    const currentDesktopShell = readDesktopShell();
    if (!currentDesktopShell?.clearBrowserData) {
      setActionError(t("browser.desktopUnavailable"));
      return;
    }

    const confirmed = await confirm({
      title: t("browser.data.clearConfirmTitle"),
      description: t("browser.data.clearConfirmDescription"),
      confirmLabel: t("browser.data.clear"),
      tone: "destructive",
    });
    if (!confirmed) return;

    setClearing(true);
    setActionError(null);
    setClearSucceeded(false);
    try {
      await currentDesktopShell.clearBrowserData();
      setClearSucceeded(true);
    } catch {
      setActionError(t("browser.data.clearFailed"));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-7 px-1 pb-6">
      <SettingsPageHeader
        icon={Globe2}
        title={t("browser.title")}
        description={t("browser.description")}
      />

      {actionError ? (
        <div role="alert" className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/8 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}
      {clearSucceeded ? (
        <div aria-live="polite" className="rounded-[var(--radius-md)] border border-emerald-500/25 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          {t("browser.data.cleared")}
        </div>
      ) : null}

      <SettingsDivider />

      <SettingsSection title={t("browser.title")}>
        <SettingsRow
          title={t("browser.enable.title")}
          description={settings.enabled
            ? t("browser.enable.enabledDescription")
            : t("browser.enable.disabledDescription")}
          className="border-t-0 pt-0"
          action={
            <SettingsToggle
              checked={settings.enabled}
              aria-label={t("browser.enable.toggle")}
              disabled={updateMutation.isPending}
              onClick={() => updateMutation.mutate({ enabled: !settings.enabled })}
            />
          }
        />

        <SettingsRow
          title={t("browser.links.title")}
          description={t("browser.links.description")}
          action={
            <div className="grid w-[20rem] grid-cols-2 overflow-hidden rounded-[var(--control-radius)] border border-border/80 bg-muted/30 p-0.5">
              {([
                ["built_in", t("browser.links.builtIn")],
                ["default_browser", t("browser.links.default")],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={settings.openLinksIn === value}
                  disabled={updateMutation.isPending}
                  onClick={() => updateMutation.mutate({ openLinksIn: value })}
                  className="h-8 whitespace-nowrap rounded-[calc(var(--control-radius)-2px)] px-2 text-[12px] font-medium text-muted-foreground transition-colors aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm disabled:opacity-50"
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
      </SettingsSection>

      <SettingsDivider />

      <SettingsSection title={t("browser.data.title")} description={t("browser.data.description")}>
        <div className="flex gap-2 rounded-[var(--radius-md)] border border-border/70 bg-muted/20 px-3 py-2.5 text-[13px] leading-5 text-muted-foreground">
          <Database className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("browser.data.trustDisclosure")}</span>
        </div>

        {nativeActionsUnavailable ? (
          <p className="text-[12px] leading-4 text-muted-foreground">
            {desktopShell ? t("browser.desktopActionsUnavailable") : t("browser.desktopUnavailable")}
          </p>
        ) : null}

        <SettingsRow
          title={t("browser.data.import")}
          description={settings.enabled
            ? t("browser.import.description")
            : t("browser.import.disabledDescription")}
          className="border-t-0 pt-0"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canImport || !settings.enabled}
              onClick={() => setImportOpen(true)}
            >
              <Import className="h-4 w-4" />
              {t("browser.data.import")}
            </Button>
          }
        />

        <SettingsRow
          title={t("browser.data.clear")}
          description={t("browser.data.clearDescription")}
          action={
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={!canClear || clearing}
              onClick={() => void handleClear()}
            >
              <Trash2 className="h-4 w-4" />
              {clearing ? t("browser.data.clearing") : t("browser.data.clear")}
            </Button>
          }
        />
      </SettingsSection>

      <BrowserDataImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
