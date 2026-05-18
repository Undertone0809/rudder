import { useState } from "react";
import { AlertTriangle, CheckCircle2, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDesktopUpdateProgress } from "@/context/DesktopUpdateProgressContext";
import { useI18n } from "@/context/I18nContext";
import type { TranslationKey } from "@/i18n/locales/en";
import { readDesktopShell, type DesktopUpdateProgressPhase } from "@/lib/desktop-shell";
import { cn } from "@/lib/utils";

const RELEASES_URL = "https://github.com/Undertone0809/rudder/releases";
const PHASE_LABEL_KEYS: Record<DesktopUpdateProgressPhase, TranslationKey> = {
  starting: "about.updates.progress.phase.starting",
  resolving_release: "about.updates.progress.phase.resolving_release",
  downloading_checksums: "about.updates.progress.phase.downloading_checksums",
  downloading_asset: "about.updates.progress.phase.downloading_asset",
  verifying_checksum: "about.updates.progress.phase.verifying_checksum",
  ready_to_install: "about.updates.progress.phase.ready_to_install",
  waiting_for_active_runs: "about.updates.progress.phase.waiting_for_active_runs",
  preparing_restart: "about.updates.progress.phase.preparing_restart",
  closing: "about.updates.progress.phase.closing",
  failed: "about.updates.progress.phase.failed",
};

function formatBytes(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const units = ["B", "KB", "MB", "GB"];
  let next = Math.max(0, value);
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return index === 0 ? `${Math.round(next)} ${units[index]}` : `${next.toFixed(1)} ${units[index]}`;
}

function phaseTone(phase: DesktopUpdateProgressPhase): "active" | "ready" | "failed" {
  if (phase === "failed") return "failed";
  if (phase === "ready_to_install" || phase === "closing") return "ready";
  return "active";
}

export function DesktopUpdateStatusCard() {
  const { progress, dismissProgress } = useDesktopUpdateProgress();
  const { t } = useI18n();
  const [actionError, setActionError] = useState<string | null>(null);
  const [applyPending, setApplyPending] = useState(false);

  if (!progress) return null;
  const currentProgress = progress;

  const tone = phaseTone(currentProgress.phase);
  const transferred = formatBytes(currentProgress.transferredBytes);
  const total = formatBytes(currentProgress.totalBytes);
  const measuredPercent = typeof currentProgress.percent === "number"
    ? Math.max(0, Math.min(100, currentProgress.percent))
    : null;
  const hasMeasuredProgress = measuredPercent !== null;
  const progressLabel = measuredPercent !== null
    ? `${measuredPercent}%`
    : transferred
      ? total
        ? `${transferred} / ${total}`
        : transferred
      : null;
  const showIndeterminateProgress = tone === "active" && !hasMeasuredProgress;

  async function retryUpdate() {
    const desktopShell = readDesktopShell();
    if (!desktopShell) return;
    setActionError(null);
    await desktopShell.installUpdate(currentProgress.version);
  }

  async function applyUpdate() {
    const desktopShell = readDesktopShell();
    setActionError(null);
    if (!desktopShell?.applyUpdate) {
      setActionError(t("about.updates.installUnavailable"));
      return;
    }

    setApplyPending(true);
    try {
      const result = await desktopShell.applyUpdate(currentProgress.updateId);
      if (result.status !== "started") {
        setActionError(result.message || t("about.updates.installFailed"));
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("about.updates.installFailed"));
    } finally {
      setApplyPending(false);
    }
  }

  async function openReleases() {
    const desktopShell = readDesktopShell();
    if (desktopShell) {
      await desktopShell.openExternal(RELEASES_URL);
    } else {
      window.open(RELEASES_URL, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <aside
      aria-live="polite"
      className="pointer-events-none fixed bottom-[calc(1rem+5.75rem)] right-4 z-[1001] w-[min(calc(100vw-2rem),20rem)] md:bottom-4"
    >
      <div
        className={cn(
          "pointer-events-auto overflow-hidden rounded-[var(--radius-md)] border bg-popover text-popover-foreground shadow-[0_16px_40px_rgba(15,23,42,0.16)] backdrop-blur-xl dark:shadow-[0_16px_44px_rgba(0,0,0,0.45)]",
          tone === "failed" ? "border-destructive/35" : "border-border/70",
        )}
      >
        <div className="flex items-start gap-3 px-3.5 py-3">
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-muted text-muted-foreground",
              tone === "failed" && "bg-destructive/10 text-destructive",
              tone === "ready" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            )}
          >
            {tone === "failed" ? <AlertTriangle className="h-4 w-4" /> : tone === "ready" ? <CheckCircle2 className="h-4 w-4" /> : <Download className="h-4 w-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold leading-5">
                {tone === "failed"
                  ? t("about.updates.progress.failedTitle")
                  : currentProgress.phase === "ready_to_install"
                    ? t("about.updates.progress.readyTitle")
                    : t("about.updates.progress.title", { version: currentProgress.version.startsWith("v") ? currentProgress.version : `v${currentProgress.version}` })}
              </p>
              {progressLabel ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{progressLabel}</span>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
              {currentProgress.error ?? t(PHASE_LABEL_KEYS[currentProgress.phase])}
            </p>
            {actionError ? (
              <p className="mt-2 rounded-[var(--radius-sm)] border border-destructive/25 bg-destructive/8 px-2.5 py-2 text-xs leading-4 text-destructive">
                {actionError}
              </p>
            ) : null}
            {hasMeasuredProgress ? (
              <div
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={measuredPercent}
              >
                <div
                  className={cn(
                    "h-full rounded-full bg-emerald-700 transition-[width] duration-300",
                    tone === "failed" && "bg-destructive",
                  )}
                  style={{ width: `${measuredPercent}%` }}
                />
              </div>
            ) : showIndeterminateProgress ? (
              <div
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={t(PHASE_LABEL_KEYS[currentProgress.phase])}
              >
                <div className="h-full w-2/5 rounded-full bg-emerald-700/70 animate-pulse" />
              </div>
            ) : null}
            {currentProgress.phase === "ready_to_install" ? (
              <div className="mt-2">
                <Button type="button" size="sm" className="h-8 px-3 text-xs" disabled={applyPending} onClick={() => void applyUpdate()}>
                  {applyPending ? t("about.updates.installing") : t("about.updates.progress.restartToUpdate")}
                </Button>
              </div>
            ) : null}
            {tone === "failed" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" className="h-8 px-3 text-xs" onClick={() => void retryUpdate()}>
                  {t("about.updates.progress.retry")}
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={() => void openReleases()}>
                  {t("about.updates.progress.openReleases")}
                </Button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={t("about.updates.progress.dismiss")}
            onClick={dismissProgress}
            className="-mr-1 -mt-1 shrink-0 rounded-[var(--radius-sm)] p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
