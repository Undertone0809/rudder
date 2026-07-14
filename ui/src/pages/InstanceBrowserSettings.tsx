import { instanceSettingsApi } from "@/api/instanceSettings";
import { BrowserDataImportDialog } from "@/components/BrowserDataImportDialog";
import { SettingsPageSkeleton } from "@/components/settings/SettingsPageSkeleton";
import {
  SettingsGroup,
  SettingsItem,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialog } from "@/context/DialogContext";
import { useI18n } from "@/context/I18nContext";
import { readDesktopShell } from "@/lib/desktop-shell";
import { queryKeys } from "@/lib/queryKeys";
import { SETTINGS_PREFETCH_STALE_TIME_MS } from "@/lib/settings-prefetch";
import type { PatchInstanceBrowserSettings } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Database, Globe2, Import, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function InstanceBrowserSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { confirm } = useDialog();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [clearSucceeded, setClearSucceeded] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const importTriggerRef = useRef<HTMLButtonElement | null>(null);

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

  function handleLinkDestinationChange(openLinksIn: string) {
    if (openLinksIn !== "built_in" && openLinksIn !== "default_browser") return;
    updateMutation.mutate({ openLinksIn });
  }

  return (
    <SettingsPage
      data-testid="browser-settings-page"
    >
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

      <SettingsGroup variant="feature" data-testid="browser-access-group">
        <SettingsItem
          icon={AppWindow}
          headingLevel={2}
          title={t("browser.enable.title")}
          description={settings.enabled
            ? t("browser.enable.enabledDescription")
            : t("browser.enable.disabledDescription")}
          action={
            <SettingsToggle
              checked={settings.enabled}
              aria-label={t("browser.enable.toggle")}
              disabled={updateMutation.isPending}
              onClick={() => updateMutation.mutate({ enabled: !settings.enabled })}
            />
          }
        />
      </SettingsGroup>

      <SettingsSection title={t("common.general")}>
        <SettingsGroup data-testid="browser-general-group">
          <SettingsItem
            title={t("browser.links.title")}
            description={t("browser.links.description")}
            action={
              <Select
                value={settings.openLinksIn}
                disabled={updateMutation.isPending}
                onValueChange={handleLinkDestinationChange}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={t("browser.links.title")}
                  className="w-full sm:w-[14.5rem]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  <SelectGroup>
                    <SelectItem value="built_in">{t("browser.links.builtIn")}</SelectItem>
                    <SelectItem value="default_browser">{t("browser.links.default")}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title={t("browser.data.title")}>
        <div className="flex items-start gap-2 px-1 text-[12px] leading-4 text-muted-foreground">
          <Database className="mt-px size-4 shrink-0" />
          <span>{t("browser.data.trustDisclosure")}</span>
        </div>

        <SettingsGroup data-testid="browser-data-group">
          <SettingsItem
            title={t("browser.data.import")}
            description={settings.enabled
              ? t("browser.import.description")
              : t("browser.import.disabledDescription")}
            action={
              <Button
                ref={importTriggerRef}
                type="button"
                variant="outline"
                size="sm"
                disabled={!canImport || !settings.enabled}
                onClick={() => setImportOpen(true)}
              >
                <Import data-icon="inline-start" />
                {t("browser.data.import")}
              </Button>
            }
          />

          <SettingsItem
            title={t("browser.data.clear")}
            description={t("browser.data.clearDescription")}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canClear || clearing}
                onClick={() => void handleClear()}
              >
                <Trash2 data-icon="inline-start" />
                {clearing ? t("browser.data.clearing") : t("browser.data.clear")}
              </Button>
            }
          />
        </SettingsGroup>

        {nativeActionsUnavailable ? (
          <p className="px-1 text-[12px] leading-4 text-muted-foreground">
            {desktopShell ? t("browser.desktopActionsUnavailable") : t("browser.desktopUnavailable")}
          </p>
        ) : null}
      </SettingsSection>

      <BrowserDataImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        returnFocusRef={importTriggerRef}
      />
    </SettingsPage>
  );
}
