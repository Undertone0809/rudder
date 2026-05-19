import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  RefreshCw,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";
import { buildAutomationTriggerPatch } from "../lib/automation-trigger-patch";
import { formatDateTime } from "../lib/utils";
import { ScheduleEditor, describeSchedule } from "../components/ScheduleEditor";
import { useDialog } from "../context/DialogContext";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { AutomationTrigger } from "@rudderhq/shared";

export const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
export const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
export const signingModes = ["bearer", "hmac_sha256"];
export const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "Keep one follow-up run queued while an active run is still working.",
  always_enqueue: "Queue every trigger occurrence, even if several runs stack up.",
  skip_if_active: "Drop overlapping trigger occurrences while the automation is already active.",
};
export const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "Ignore schedule windows that were missed while the automation or scheduler was paused.",
  enqueue_missed_with_cap: "Catch up missed schedule windows in capped batches after recovery.",
};
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

export function humanizeToken(value: string): string {
  return value.replaceAll("_", " ");
}

export function triggerKindLabel(kind: string | null | undefined): string {
  if (kind === "schedule") return "Schedule trigger";
  if (kind === "webhook") return "Webhook trigger";
  return kind ? `${humanizeToken(kind)} trigger` : "Trigger";
}

export function runSourceLabel(source: string): string {
  if (source === "manual") return "Manual run";
  if (source === "schedule") return "Scheduled run";
  if (source === "webhook") return "Webhook run";
  return humanizeToken(source);
}

export function runStatusTitle(status: string): string {
  switch (status) {
    case "issue_created":
      return "Run created an issue";
    case "running":
      return "Run in progress";
    case "failed":
      return "Run failed";
    case "coalesced":
      return "Run joined an existing issue";
    case "skipped":
      return "Run skipped";
    case "completed":
      return "Run completed";
    default:
      return `Run ${humanizeToken(status)}`;
  }
}

export function runStatusDetail(status: string): string | null {
  switch (status) {
    case "issue_created":
      return "Execution issue was opened";
    case "running":
      return "Execution issue is active";
    case "failed":
      return "Execution failed";
    case "coalesced":
      return "A live execution already exists";
    case "skipped":
      return "Skipped because an execution is already active";
    case "completed":
      return "Execution issue completed";
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

export function summarizeTrigger(trigger: Pick<AutomationTrigger, "kind" | "cronExpression" | "label"> | null): string {
  if (!trigger) return "No triggers configured";
  if (trigger.kind === "schedule" && trigger.cronExpression) {
    return describeSchedule(trigger.cronExpression);
  }
  if (trigger.kind === "webhook") {
    return trigger.label?.trim() || "Webhook trigger";
  }
  return trigger.label?.trim() || trigger.kind;
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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    label: trigger.label ?? "",
    cronExpression: trigger.cronExpression ?? "",
    signingMode: trigger.signingMode ?? "bearer",
    replayWindowSec: String(trigger.replayWindowSec ?? 300),
  });
  const skipNextAutosaveRef = useRef(true);

  useEffect(() => {
    setDraft({
      label: trigger.label ?? "",
      cronExpression: trigger.cronExpression ?? "",
      signingMode: trigger.signingMode ?? "bearer",
      replayWindowSec: String(trigger.replayWindowSec ?? 300),
    });
    skipNextAutosaveRef.current = true;
  }, [trigger]);

  const isTriggerDirty = useMemo(() => {
    if (draft.label !== (trigger.label ?? "")) return true;
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
  const triggerLabel = trigger.label?.trim() || trigger.kind;
  const triggerSummary = trigger.kind === "schedule"
    ? (trigger.cronExpression ? describeSchedule(trigger.cronExpression) : "No schedule")
    : trigger.kind === "webhook"
      ? "Webhook trigger"
      : "API trigger";
  const triggerTimingLabel = trigger.kind === "schedule" && trigger.nextRunAt
    ? `Next: ${formatDateTime(trigger.nextRunAt)}`
    : trigger.kind === "webhook"
      ? "Webhook"
      : "API";
  const syncLabel = isDeleting
    ? "Deleting..."
    : isRotating
      ? "Rotating..."
      : isSaving
        ? "Saving..."
        : saveError
          ? "Save failed"
          : !canAutosaveTrigger
            ? "Needs schedule"
            : isTriggerDirty
              ? "Autosaving..."
              : "In sync";
  const syncClassName = isDeleting || isRotating || isSaving || isTriggerDirty
    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    : saveError
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : !canAutosaveTrigger
        ? "border-border/70 bg-muted/20 text-muted-foreground"
        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";

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
    <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-md border border-border/70 bg-background/45">
      <div className="flex min-w-0 items-start gap-2 p-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span className="mt-0.5 shrink-0 text-muted-foreground">
            {trigger.kind === "schedule" ? <Clock3 className="h-3.5 w-3.5" /> : trigger.kind === "webhook" ? <Webhook className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
          </span>
          <div className="min-w-0 space-y-0.5">
            <div className="truncate text-sm font-medium">{triggerLabel}</div>
            <div className="truncate text-xs text-muted-foreground" title={triggerSummary}>{triggerSummary}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant="outline" className={syncClassName}>
            {syncLabel}
          </Badge>
          <span className="hidden max-w-[8rem] truncate text-xs text-muted-foreground 2xl:inline" title={triggerTimingLabel}>
            {triggerTimingLabel}
          </span>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              aria-label={open ? "Collapse trigger editor" : "Edit trigger"}
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </Button>
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete trigger"
            disabled={isDeleting}
            onClick={async () => {
              const confirmed = await confirm({
                title: `Delete trigger "${triggerLabel}"?`,
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

      <CollapsibleContent
        data-testid="automation-trigger-editor-body"
        className="border-t border-border/60 px-3 pb-3 pt-3 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1"
      >
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Label</Label>
            <Input
              value={draft.label}
              onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
            />
          </div>
          {trigger.kind === "schedule" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Schedule</Label>
              <ScheduleEditor
                value={draft.cronExpression}
                onChange={(cronExpression) => setDraft((current) => ({ ...current, cronExpression }))}
              />
            </div>
          )}
          {trigger.kind === "webhook" && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Signing mode</Label>
                <Select
                  value={draft.signingMode}
                  onValueChange={(signingMode) => setDraft((current) => ({ ...current, signingMode }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {signingModes.map((mode) => (
                      <SelectItem key={mode} value={mode}>{mode}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Replay window (seconds)</Label>
                <Input
                  value={draft.replayWindowSec}
                  onChange={(event) => setDraft((current) => ({ ...current, replayWindowSec: event.target.value }))}
                />
              </div>
            </>
          )}
        </div>

        {(trigger.lastResult || trigger.kind === "webhook" || saveError) ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {trigger.lastResult && <span className="text-xs text-muted-foreground">Last: {trigger.lastResult}</span>}
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
                    Retry save
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              {trigger.kind === "webhook" && (
                <Button variant="outline" size="sm" disabled={isRotating} onClick={() => onRotate(trigger.id)}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  {isRotating ? "Rotating..." : "Rotate secret"}
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
