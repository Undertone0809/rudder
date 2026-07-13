import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/context/I18nContext";
import {
  readDesktopShell,
  type DesktopBrowserImportResult,
  type DesktopBrowserImportSource,
} from "@/lib/desktop-shell";
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Cookie,
  KeyRound,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export function BrowserDataImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [sources, setSources] = useState<DesktopBrowserImportSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [importCookies, setImportCookies] = useState(true);
  const [loadingSources, setLoadingSources] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DesktopBrowserImportResult | null>(null);
  const generationRef = useRef(0);

  useLayoutEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setImporting(false);
      return undefined;
    }

    let cancelled = false;
    const desktopShell = readDesktopShell();
    setSources([]);
    setSelectedSourceId("");
    setImportCookies(true);
    setResult(null);
    setError(null);

    if (!desktopShell?.listBrowserImportSources || !desktopShell.importBrowserData) {
      setError(t("browser.import.desktopUnavailable"));
      return undefined;
    }

    setLoadingSources(true);
    void desktopShell.listBrowserImportSources()
      .then((nextSources) => {
        if (cancelled) return;
        setSources(nextSources);
        setSelectedSourceId(nextSources.find((source) => source.supported.cookies)?.id ?? nextSources[0]?.id ?? "");
      })
      .catch(() => {
        if (!cancelled) setError(t("browser.import.failed"));
      })
      .finally(() => {
        if (!cancelled) setLoadingSources(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, t]);

  const selectedSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId) ?? null,
    [selectedSourceId, sources],
  );
  const canImportCookies = selectedSource?.supported.cookies === true;

  async function handleImport() {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.importBrowserData || !selectedSource || !canImportCookies || !importCookies) {
      setError(t("browser.import.desktopUnavailable"));
      return;
    }

    const generation = generationRef.current;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const nextResult = await desktopShell.importBrowserData({
        sourceId: selectedSource.id,
        importCookies: true,
      });
      if (generationRef.current === generation) {
        setResult(nextResult);
      }
    } catch {
      if (generationRef.current === generation) setError(t("browser.import.failed"));
    } finally {
      if (generationRef.current === generation) setImporting(false);
    }
  }

  const skippedIssues = result?.errors?.filter((item) => item.kind === "skipped") ?? [];
  const failedIssues = result?.errors?.filter((item) => item.kind === "failed") ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && importing) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[34rem]"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (importing) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (importing) event.preventDefault();
        }}
      >
        <DialogHeader className="border-b border-border/70 px-5 py-4">
          <DialogTitle className="text-base leading-6">{t("browser.import.title")}</DialogTitle>
          <DialogDescription className="text-[13px] leading-5">
            {t("browser.import.description")}
          </DialogDescription>
        </DialogHeader>

        <div
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4"
          data-testid="browser-import-scroll-region"
        >
          <div className="space-y-2">
            <Label htmlFor="browser-import-source">{t("browser.import.source")}</Label>
            {loadingSources ? (
              <p className="text-[13px] text-muted-foreground">{t("browser.import.loadingSources")}</p>
            ) : sources.length > 0 ? (
              <select
                id="browser-import-source"
                value={selectedSourceId}
                onChange={(event) => {
                  setSelectedSourceId(event.target.value);
                  setResult(null);
                  setError(null);
                }}
                disabled={importing}
                className="h-9 w-full rounded-[var(--control-radius)] border border-input bg-[color:var(--input-background)] px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.displayName}
                  </option>
                ))}
              </select>
            ) : error ? null : (
              <p className="text-[13px] text-muted-foreground">{t("browser.import.noSources")}</p>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-[13px] font-medium text-foreground">{t("browser.import.dataTypes")}</div>
            <div className="divide-y divide-border/70 rounded-[var(--radius-md)] border border-border/70">
              <div className="flex items-center gap-3 px-3 py-3">
                <Cookie className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-foreground">{t("browser.import.cookies")}</div>
                  <div className="text-[12px] leading-4 text-muted-foreground">
                    {t("browser.import.cookiesDescription")}
                  </div>
                </div>
                {selectedSource && !canImportCookies ? (
                  <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                    {t("browser.import.notAvailableFromSource")}
                  </span>
                ) : (
                  <Checkbox
                    checked={importCookies && canImportCookies}
                    disabled={!canImportCookies || importing}
                    aria-label={t("browser.import.cookies")}
                    onCheckedChange={(checked) => setImportCookies(checked === true)}
                  />
                )}
              </div>
              <div className="flex items-center gap-3 px-3 py-3 opacity-70">
                <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-foreground">{t("browser.import.passwords")}</div>
                  <div className="text-[12px] leading-4 text-muted-foreground">
                    {t("browser.import.passwordsDescription")}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                  {t("browser.import.notAvailable")}
                </span>
              </div>
            </div>
          </div>

          <div className="flex gap-2 rounded-[var(--radius-md)] border border-amber-500/25 bg-amber-500/8 px-3 py-2.5 text-[12px] leading-4 text-muted-foreground">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{t("browser.import.disclosure")}</span>
          </div>

          {error ? (
            <p role="alert" className="text-[13px] text-destructive">{error}</p>
          ) : null}

          {result ? (
            <div
              data-testid="browser-import-result-panel"
              className="overflow-hidden rounded-[var(--radius-md)] border border-border/70 bg-muted/20"
            >
              <div role="status" aria-live="polite">
                <div className="flex items-center gap-2 px-3 py-2.5">
                  {result.status === "succeeded" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" aria-hidden />
                  ) : result.status === "partial" ? (
                    <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                  ) : (
                    <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
                  )}
                  <div className="text-[13px] font-medium text-foreground">
                    {t(
                      result.status === "succeeded"
                        ? "browser.import.result.status.succeeded"
                        : result.status === "partial"
                          ? "browser.import.result.status.partial"
                          : "browser.import.result.status.failed",
                    )}
                  </div>
                </div>

                <dl className="grid grid-cols-3 divide-x divide-border/60 border-y border-border/60 bg-background/30">
                  <div
                    className="min-w-0 px-3 py-2"
                    aria-label={t("browser.import.result.imported", { count: result.importedCount })}
                  >
                    <dt className="truncate text-[11px] leading-4 text-muted-foreground">
                      {t("browser.import.result.importedLabel")}
                    </dt>
                    <dd
                      className="mt-0.5 text-base font-semibold leading-5 tabular-nums text-foreground"
                      data-testid="browser-import-result-imported"
                    >
                      {result.importedCount.toLocaleString()}
                    </dd>
                  </div>
                  <div
                    className="min-w-0 px-3 py-2"
                    aria-label={t("browser.import.result.skipped", { count: result.skippedCount })}
                  >
                    <dt className="truncate text-[11px] leading-4 text-muted-foreground">
                      {t("browser.import.result.skippedLabel")}
                    </dt>
                    <dd
                      className="mt-0.5 text-base font-semibold leading-5 tabular-nums text-amber-700 dark:text-amber-400"
                      data-testid="browser-import-result-skipped"
                    >
                      {result.skippedCount.toLocaleString()}
                    </dd>
                  </div>
                  <div
                    className="min-w-0 px-3 py-2"
                    aria-label={t("browser.import.result.failed", { count: result.failedCount })}
                  >
                    <dt className="truncate text-[11px] leading-4 text-muted-foreground">
                      {t("browser.import.result.failedLabel")}
                    </dt>
                    <dd
                      className={
                        result.failedCount > 0
                          ? "mt-0.5 text-base font-semibold leading-5 tabular-nums text-destructive"
                          : "mt-0.5 text-base font-semibold leading-5 tabular-nums text-foreground"
                      }
                      data-testid="browser-import-result-failed"
                    >
                      {result.failedCount.toLocaleString()}
                    </dd>
                  </div>
                </dl>
              </div>

              {skippedIssues.length ? (
                <Collapsible>
                  <CollapsibleTrigger
                    className="group flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                    data-testid="browser-import-skipped-details-trigger"
                  >
                    <span className="flex-1">{t("browser.import.result.skippedReasons")}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {t(
                        skippedIssues.length === 1
                          ? "browser.import.result.skippedReasonCount"
                          : "browser.import.result.skippedReasonsCount",
                        { count: skippedIssues.length },
                      )}
                    </span>
                    <ChevronDown
                      className="motion-disclosure-icon h-3.5 w-3.5 shrink-0 text-muted-foreground group-data-[state=open]:rotate-180"
                      aria-hidden
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent
                    className="border-t border-border/60"
                    data-testid="browser-import-skipped-details-content"
                  >
                    <ul className="divide-y divide-border/60">
                      {skippedIssues.map((item) => (
                        <li
                          key={`skipped-${item.errorCode}`}
                          className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2.5"
                          data-testid="browser-import-skipped-detail"
                        >
                          <div className="min-w-0">
                            <p className="text-[12px] leading-4 text-foreground">{item.message}</p>
                            <code className="mt-0.5 block break-all font-mono text-[10px] leading-4 text-muted-foreground">
                              {item.errorCode}
                            </code>
                          </div>
                          <span className="min-w-10 text-right text-[13px] font-medium leading-5 tabular-nums text-foreground">
                            {item.count.toLocaleString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}

              {failedIssues.length ? (
                <div className="border-t border-border/60">
                  <div className="flex items-center gap-2 px-3 py-2.5 text-[12px] font-medium text-destructive">
                    <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>{t("browser.import.result.failures")}</span>
                  </div>
                  <ul className="divide-y divide-border/60 border-t border-border/60">
                    {failedIssues.map((item) => (
                      <li
                        key={`failed-${item.errorCode}`}
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="text-[12px] leading-4 text-destructive">{item.message}</p>
                          <code className="mt-0.5 block break-all font-mono text-[10px] leading-4 text-muted-foreground">
                            {item.errorCode}
                          </code>
                        </div>
                        <span className="min-w-10 text-right text-[13px] font-medium leading-5 tabular-nums text-destructive">
                          {item.count.toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t border-border/70 px-5 py-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={importing}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void handleImport()}
            disabled={!selectedSource || !canImportCookies || !importCookies || importing}
          >
            {importing ? t("browser.import.importing") : t("browser.import.action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
