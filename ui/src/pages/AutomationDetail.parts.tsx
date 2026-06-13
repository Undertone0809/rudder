import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AutomationTrigger, InstanceLocale } from "@rudderhq/shared";
import {
  ChevronDown,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScheduleEditor, describeSchedule } from "../components/ScheduleEditor";
import { useDialog } from "../context/DialogContext";
import { useI18n } from "../context/I18nContext";
import { translateLegacyString } from "../i18n/legacyPhrases";
import {
  automationPolicyDescription,
  automationPolicyLabel,
  catchUpPolicyDescriptions,
  concurrencyPolicyDescriptions,
} from "../lib/automation-localization";
import { buildAutomationTriggerPatch } from "../lib/automation-trigger-patch";
import { cn, formatDateTime } from "../lib/utils";

export const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
export const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
export const signingModes = ["bearer", "hmac_sha256"];
export { automationPolicyDescription, automationPolicyLabel, catchUpPolicyDescriptions, concurrencyPolicyDescriptions };
export type SecretMessage = {
  title: string;
  webhookUrl: string;
  webhookSecret: string;
};

export function addUniqueId(ids: string[], id: string) {
  return ids.includes(id) ? ids : [...ids, id];
}

export function removeId(ids: string[], id: string) {
  return ids.filter((currentId) => currentId !== id);
}

export function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

export function formatActivityDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map((item) => formatActivityDetailValue(item)).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export function getActivityDetailString(details: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function humanizeToken(value: string, locale: InstanceLocale = "en"): string {
  return translateLegacyString(locale, value.replaceAll("_", " "));
}

export function triggerKindLabel(kind: string | null | undefined, locale: InstanceLocale = "en"): string {
  if (kind === "schedule") return locale === "zh-CN" ? "日程触发器" : "Schedule trigger";
  if (kind === "webhook") return locale === "zh-CN" ? "Webhook 触发器" : "Webhook trigger";
  if (!kind) return locale === "zh-CN" ? "触发器" : "Trigger";
  return locale === "zh-CN" ? `${humanizeToken(kind, locale)}触发器` : `${humanizeToken(kind, locale)} trigger`;
}

export function runSourceLabel(source: string, locale: InstanceLocale = "en"): string {
  if (source === "manual") return locale === "zh-CN" ? "手动运行" : "Manual run";
  if (source === "schedule") return locale === "zh-CN" ? "计划运行" : "Scheduled run";
  if (source === "webhook") return locale === "zh-CN" ? "Webhook 运行" : "Webhook run";
  return humanizeToken(source, locale);
}

export function runStatusTitle(status: string, locale: InstanceLocale = "en"): string {
  switch (status) {
    case "issue_created":
      return locale === "zh-CN" ? "运行创建了任务" : "Run created an issue";
    case "running":
      return locale === "zh-CN" ? "运行正在执行" : "Run in progress";
    case "failed":
      return locale === "zh-CN" ? "运行失败" : "Run failed";
    case "coalesced":
      return locale === "zh-CN" ? "运行已合并到已有运行" : "Run joined an existing run";
    case "skipped":
      return locale === "zh-CN" ? "运行已跳过" : "Run skipped";
    case "completed":
      return locale === "zh-CN" ? "运行已完成" : "Run completed";
    default:
      return locale === "zh-CN" ? `运行 ${humanizeToken(status, locale)}` : `Run ${humanizeToken(status, locale)}`;
  }
}

export function runStatusDetail(status: string, locale: InstanceLocale = "en"): string | null {
  switch (status) {
    case "issue_created":
      return locale === "zh-CN" ? "已创建执行任务" : "Execution issue was opened";
    case "running":
      return locale === "zh-CN" ? "运行处于活跃状态" : "Run is active";
    case "failed":
      return locale === "zh-CN" ? "执行失败" : "Execution failed";
    case "coalesced":
      return locale === "zh-CN" ? "已有实时运行" : "A live run already exists";
    case "skipped":
      return locale === "zh-CN" ? "已有运行处于活跃状态，因此已跳过" : "Skipped because a run is already active";
    case "completed":
      return locale === "zh-CN" ? "运行已完成" : "Run completed";
    default:
      return null;
  }
}

export function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

export function formatAutomationTimestamp(value: Date | string | null | undefined, fallback: string) {
  if (!value) return fallback;
  return formatDateTime(value);
}

export function summarizeTrigger(trigger: Pick<AutomationTrigger, "kind" | "cronExpression" | "label"> | null, locale: InstanceLocale = "en"): string {
  if (!trigger) return "No triggers configured";
  if (trigger.kind === "schedule" && trigger.cronExpression) {
    return describeSchedule(trigger.cronExpression, locale);
  }
  if (trigger.kind === "webhook") {
    return locale === "zh-CN" ? "Webhook 触发器" : "Webhook trigger";
  }
  return triggerKindLabel(trigger.kind, locale);
}

export function automationRiskLabel(input: {
  status: string;
  triggerCount: number;
  hasAssignee: boolean;
  hasLiveRun: boolean;
  latestRunStatus?: string | null;
}): string {
  if (input.triggerCount === 0) return "No trigger";
  if (!input.hasAssignee) return "No owner";
  if (input.latestRunStatus === "failed") return "Last failed";
  if (input.hasLiveRun) return "Active run";
  return "Normal";
}

export function automationNextActionLabel(input: {
  status: string;
  triggerCount: number;
  hasLiveRun: boolean;
}): string {
  if (input.triggerCount === 0) return "Add trigger";
  if (input.status !== "active") return "Enable";
  if (input.hasLiveRun) return "Monitor run";
  return "Run now";
}

export function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

export function SidebarRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right text-foreground">{children}</div>
    </div>
  );
}

export function SidebarPropertyRow({
  label,
  children,
  align = "center",
}: {
  label: string;
  children: ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div
      className={cn(
        "flex gap-3 py-1.5",
        align === "start" ? "items-start" : "items-center",
      )}
    >
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

export function SidebarSelectValue({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
    </>
  );
}

export function OverviewMetaPill({
  label,
  value,
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2 py-1.5 text-xs text-foreground ${className ?? ""}`}
    >
      {icon ? <span className="shrink-0 text-muted-foreground">{icon}</span> : null}
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}

export function TriggerEditor({
  trigger,
  onSave,
  onRotate,
  onDelete,
  isSaving,
  isDeleting,
  isRotating,
  saveError,
}: {
  trigger: AutomationTrigger;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
  isSaving?: boolean;
  isDeleting?: boolean;
  isRotating?: boolean;
  saveError?: string | null;
}) {
  const { confirm } = useDialog();
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    cronExpression: trigger.cronExpression ?? "",
    signingMode: trigger.signingMode ?? "bearer",
    replayWindowSec: String(trigger.replayWindowSec ?? 300),
  });
  const skipNextAutosaveRef = useRef(true);

  useEffect(() => {
    setDraft({
      cronExpression: trigger.cronExpression ?? "",
      signingMode: trigger.signingMode ?? "bearer",
      replayWindowSec: String(trigger.replayWindowSec ?? 300),
    });
    skipNextAutosaveRef.current = true;
  }, [trigger]);

  const isTriggerDirty = useMemo(() => {
    if (trigger.kind === "schedule") {
      return draft.cronExpression !== (trigger.cronExpression ?? "");
    }
    if (trigger.kind === "webhook") {
      return (
        draft.signingMode !== (trigger.signingMode ?? "bearer") ||
        draft.replayWindowSec !== String(trigger.replayWindowSec ?? 300)
      );
    }
    return false;
  }, [draft, trigger]);

  const canAutosaveTrigger =
    trigger.kind !== "schedule" || draft.cronExpression.trim().length > 0;
  const triggerSummary = trigger.kind === "schedule"
    ? (trigger.cronExpression ? describeSchedule(trigger.cronExpression, locale) : (locale === "zh-CN" ? "未设置日程" : "No schedule"))
    : trigger.kind === "webhook"
      ? (locale === "zh-CN" ? "Webhook 触发器" : "Webhook trigger")
      : (locale === "zh-CN" ? "API 触发器" : "API trigger");
  const triggerTimingLabel = trigger.kind === "schedule" && trigger.nextRunAt
    ? `${locale === "zh-CN" ? "下次：" : "Next: "}${formatDateTime(trigger.nextRunAt)}`
    : trigger.kind === "webhook"
      ? "Webhook"
      : "API";
  const primaryTriggerLabel = triggerSummary;
  const secondaryTriggerLabel = triggerTimingLabel;
  const syncLabel = isDeleting
    ? (locale === "zh-CN" ? "删除中..." : "Deleting...")
    : isRotating
      ? (locale === "zh-CN" ? "轮换中..." : "Rotating...")
      : isSaving
        ? (locale === "zh-CN" ? "保存中..." : "Saving...")
        : saveError
          ? (locale === "zh-CN" ? "保存失败" : "Save failed")
          : !canAutosaveTrigger
            ? (locale === "zh-CN" ? "需要日程" : "Needs schedule")
            : isTriggerDirty
              ? (locale === "zh-CN" ? "自动保存中..." : "Autosaving...")
              : (locale === "zh-CN" ? "已同步" : "In sync");
  const syncClassName = isDeleting || isRotating || isSaving || isTriggerDirty
    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    : saveError
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : !canAutosaveTrigger
        ? "border-border/70 bg-muted/20 text-muted-foreground"
        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  const showSyncBadge = syncLabel !== (locale === "zh-CN" ? "已同步" : "In sync");

  useEffect(() => {
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    if (!isTriggerDirty || !canAutosaveTrigger) return;

    const timeoutId = window.setTimeout(() => {
      onSave(trigger.id, buildAutomationTriggerPatch(trigger, draft, getLocalTimezone()));
    }, 650);

    return () => window.clearTimeout(timeoutId);
  }, [canAutosaveTrigger, draft, isTriggerDirty, onSave, trigger]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex min-h-12 min-w-0 items-center gap-2 rounded-md border border-border/60 bg-background/25 px-3 py-2">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="group flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Edit trigger"
            data-testid="automation-trigger-menu-button"
          >
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="block truncate text-sm font-medium" title={primaryTriggerLabel}>{primaryTriggerLabel}</span>
              <span className="block truncate text-xs text-muted-foreground" title={secondaryTriggerLabel}>{secondaryTriggerLabel}</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
          </button>
        </PopoverTrigger>
        <div className="flex shrink-0 items-center gap-1.5">
          {showSyncBadge ? (
            <Badge variant="outline" className={syncClassName}>
              {syncLabel}
            </Badge>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete trigger"
            disabled={isDeleting}
            onClick={async () => {
              const confirmed = await confirm({
                title: `Delete ${trigger.kind === "schedule" ? "schedule" : trigger.kind} trigger?`,
                description: `It will stop new ${trigger.kind} activations.`,
                confirmLabel: "Delete",
                tone: "destructive",
              });
              if (!confirmed) return;
              onDelete(trigger.id);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <PopoverContent
        data-testid="automation-trigger-editor-body"
        align="end"
        side="left"
        sideOffset={8}
        className="automation-trigger-menu-content glass-popover w-[min(320px,calc(100vw-2rem))] space-y-3 rounded-md p-3 text-foreground"
      >
        <div className="px-1 text-sm font-medium text-muted-foreground">
          {trigger.kind === "schedule" ? (locale === "zh-CN" ? "日程" : "Schedule") : triggerKindLabel(trigger.kind, locale)}
        </div>
        <div className="grid gap-2">
          {trigger.kind === "schedule" && (
            <div className="grid gap-1.5">
              <Label className="px-1 text-xs text-muted-foreground">{locale === "zh-CN" ? "日程" : "Schedule"}</Label>
              <ScheduleEditor
                variant="compact"
                value={draft.cronExpression}
                onChange={(cronExpression) => setDraft((current) => ({ ...current, cronExpression }))}
              />
            </div>
          )}
          {trigger.kind === "webhook" && (
            <>
              <div className="grid gap-1.5">
                <Label className="px-1 text-xs text-muted-foreground">{locale === "zh-CN" ? "签名模式" : "Signing mode"}</Label>
                <Select
                  value={draft.signingMode}
                  onValueChange={(signingMode) => setDraft((current) => ({ ...current, signingMode }))}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {signingModes.map((mode) => (
                      <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="px-1 text-xs text-muted-foreground">{locale === "zh-CN" ? "重放窗口" : "Replay window"}</Label>
                <Input
                  value={draft.replayWindowSec}
                  className="h-8"
                  onChange={(event) => setDraft((current) => ({ ...current, replayWindowSec: event.target.value }))}
                />
              </div>
            </>
          )}
        </div>

        {(trigger.lastResult || trigger.kind === "webhook" || saveError) ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {trigger.lastResult && <span className="text-xs text-muted-foreground">{locale === "zh-CN" ? "最近：" : "Last: "}{trigger.lastResult}</span>}
            {saveError ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">
                <span>{saveError}</span>
                {canAutosaveTrigger ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-6 px-2 text-destructive hover:text-destructive"
                    onClick={() => onSave(trigger.id, buildAutomationTriggerPatch(trigger, draft, getLocalTimezone()))}
                  >
                    {locale === "zh-CN" ? "重试保存" : "Retry save"}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              {trigger.kind === "webhook" && (
                <Button variant="outline" size="sm" disabled={isRotating} onClick={() => onRotate(trigger.id)}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  {isRotating ? (locale === "zh-CN" ? "轮换中..." : "Rotating...") : (locale === "zh-CN" ? "轮换密钥" : "Rotate secret")}
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
