import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { redactHomePathUserSegments, redactHomePathUserSegmentsInValue } from "@rudderhq/agent-runtime-utils";
import {
  summarizeTokenUsage,
  tokenUsageCacheRatio,
  type AgentSkillEntry,
  type CostTrendPoint,
  type HeartbeatRun,
  type HeartbeatRunEvent,
  type OrganizationSkillCreateRequest,
  type WorkspaceOperation
} from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Loader2,
  Slash,
  Timer,
  XCircle
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState
} from "react";
import { heartbeatsApi } from "../api/heartbeats";
import { type DashboardDatePreset } from "../components/DashboardDateRangeControl";
import { heartbeatRunEventText } from "../lib/run-detail-events";
import { cn, formatTokens, relativeTime, visibleRunCostUsd } from "../lib/utils";

export const runStatusIcons: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  succeeded: { icon: CheckCircle2, color: "text-green-600 dark:text-green-400" },
  failed: { icon: XCircle, color: "text-red-600 dark:text-red-400" },
  running: { icon: Loader2, color: "text-cyan-600 dark:text-cyan-400" },
  queued: { icon: Clock, color: "text-yellow-600 dark:text-yellow-400" },
  timed_out: { icon: Timer, color: "text-orange-600 dark:text-orange-400" },
  cancelled: { icon: Slash, color: "text-neutral-500 dark:text-neutral-400" },
};

export const REDACTED_ENV_VALUE = "***REDACTED***";
export const SECRET_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
export const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;

export function formatDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseDateInputValue(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

export function getRecentDayKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const now = new Date();
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1 - index), 12, 0, 0, 0);
    return formatDateInputValue(date);
  });
}

export function getDayKeysBetween(from: string, to: string): string[] {
  if (!from || !to) return [];
  const days: string[] = [];
  const cursor = parseDateInputValue(from);
  const end = parseDateInputValue(to);
  while (cursor.getTime() <= end.getTime()) {
    days.push(formatDateInputValue(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function formatRangeLabel(preset: DashboardDatePreset, customFrom: string, customTo: string): string {
  if (preset === "7d") return "Last 7 days";
  if (preset === "15d") return "Last 15 days";
  if (preset === "30d") return "Last 30 days";
  if (!customFrom || !customTo) return "Custom range";

  const fromLabel = parseDateInputValue(customFrom).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const toLabel = parseDateInputValue(customTo).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return fromLabel === toLabel ? fromLabel : `${fromLabel} - ${toLabel}`;
}

export function isWithinRange(value: string | Date | null | undefined, from: string, to: string): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return false;
  if (from && timestamp < new Date(from).getTime()) return false;
  if (to && timestamp > new Date(to).getTime()) return false;
  return true;
}

export function compactSkillText(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[`*_>#-]/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveSkillSummaryText(
  description: string | null | undefined,
  detail: string | null | undefined,
) {
  return description ?? detail ?? "No description provided.";
}

export function isGenericSkillRuntimeDetail(value: string | null | undefined) {
  if (!value) return false;
  const normalized = compactSkillText(value)?.toLowerCase() ?? "";
  return normalized === "will be mounted into the ephemeral claude skill directory on the next run."
    || normalized === "enabled for this agent. rudder will mount this user installed claude skill on the next run."
    || normalized === "installed outside rudder management in the claude skills home.";
}

export function isGenericSkillLocationLabel(value: string | null | undefined) {
  if (!value) return false;
  return /^~\/\.[^/]+(?:\/agent)?\/skills$/i.test(value.trim());
}

export function SkillSwitch({
  checked,
  disabled,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <ToggleSwitch
      checked={checked}
      size="sm"
      tone="success"
      aria-label={label}
      disabled={disabled}
      className={disabled ? "opacity-70" : "cursor-pointer"}
      onClick={() => {
        if (disabled) return;
        onCheckedChange(!checked);
      }}
    />
  );
}

export function CreateAgentSkillDialog({
  open,
  onOpenChange,
  onCreate,
  isPending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (payload: OrganizationSkillCreateRequest) => void;
  isPending: boolean;
  error: string | null;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) {
      setName("");
      setSlug("");
      setDescription("");
    }
  }, [open]);

  function handleCreate() {
    onCreate({
      name,
      slug: slug.trim() || null,
      description: description.trim() || null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create agent skill</DialogTitle>
          <DialogDescription>
            Create a private skill package for this agent under `AGENT_HOME/skills`. It will appear in the Agent skills section after creation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="create-agent-skill-name" className="text-sm font-medium text-foreground">
                Name
              </label>
              <Input
                id="create-agent-skill-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Skill name"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="create-agent-skill-slug" className="text-sm font-medium text-foreground">
                Short name
              </label>
              <Input
                id="create-agent-skill-slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="optional-shortname"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="create-agent-skill-description" className="text-sm font-medium text-foreground">
              Description
            </label>
            <Textarea
              id="create-agent-skill-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Short description"
              className="min-h-24"
            />
          </div>

          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={isPending || name.trim().length === 0}
          >
            {isPending ? "Creating..." : "Create skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function shouldHideExternalSkillEntry(entry: AgentSkillEntry) {
  const candidate = (entry.runtimeName ?? entry.key).trim();
  if (!candidate) return true;
  return candidate === ".DS_Store" || candidate.startsWith(".");
}

export function redactPathText(value: string, censorUsernameInLogs: boolean) {
  return redactHomePathUserSegments(value, { enabled: censorUsernameInLogs });
}

export function redactPathValue<T>(value: T, censorUsernameInLogs: boolean): T {
  return redactHomePathUserSegmentsInValue(value, { enabled: censorUsernameInLogs });
}

export function formatInvocationValueForDisplay(value: unknown, censorUsernameInLogs: boolean): string {
  if (typeof value === "string") return redactPathText(value, censorUsernameInLogs);
  try {
    return JSON.stringify(redactPathValue(value, censorUsernameInLogs), null, 2);
  } catch {
    return redactPathText(String(value), censorUsernameInLogs);
  }
}

export function shouldRedactSecretValue(key: string, value: unknown): boolean {
  if (SECRET_ENV_KEY_RE.test(key)) return true;
  if (typeof value !== "string") return false;
  return JWT_VALUE_RE.test(value);
}

export function redactEnvValue(key: string, value: unknown, censorUsernameInLogs: boolean): string {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref"
  ) {
    return "***SECRET_REF***";
  }
  if (shouldRedactSecretValue(key, value)) return REDACTED_ENV_VALUE;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return redactPathText(value, censorUsernameInLogs);
  try {
    return JSON.stringify(redactPathValue(value, censorUsernameInLogs));
  } catch {
    return redactPathText(String(value), censorUsernameInLogs);
  }
}

export function isMarkdown(pathValue: string) {
  return pathValue.toLowerCase().endsWith(".md");
}

export function formatEnvForDisplay(envValue: unknown, censorUsernameInLogs: boolean): string {
  const env = asRecord(envValue);
  if (!env) return "<unable-to-parse>";

  const keys = Object.keys(env);
  if (keys.length === 0) return "<empty>";

  return keys
    .sort()
    .map((key) => `${key}=${redactEnvValue(key, env[key], censorUsernameInLogs)}`)
    .join("\n");
}

export const LIVE_SCROLL_BOTTOM_TOLERANCE_PX = 32;
export type ScrollContainer = Window | HTMLElement;

export function isWindowContainer(container: ScrollContainer): container is Window {
  return container === window;
}

export function isElementScrollContainer(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

export function findScrollContainer(anchor: HTMLElement | null): ScrollContainer {
  let parent = anchor?.parentElement ?? null;
  while (parent) {
    if (isElementScrollContainer(parent)) return parent;
    parent = parent.parentElement;
  }
  return window;
}

export function readScrollMetrics(container: ScrollContainer): { scrollHeight: number; distanceFromBottom: number } {
  if (isWindowContainer(container)) {
    const pageHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
    );
    const viewportBottom = window.scrollY + window.innerHeight;
    return {
      scrollHeight: pageHeight,
      distanceFromBottom: Math.max(0, pageHeight - viewportBottom),
    };
  }

  const viewportBottom = container.scrollTop + container.clientHeight;
  return {
    scrollHeight: container.scrollHeight,
    distanceFromBottom: Math.max(0, container.scrollHeight - viewportBottom),
  };
}

export function scrollToContainerBottom(container: ScrollContainer, behavior: ScrollBehavior = "auto") {
  if (isWindowContainer(container)) {
    const pageHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
    );
    window.scrollTo({ top: pageHeight, behavior });
    return;
  }

  container.scrollTo({ top: container.scrollHeight, behavior });
}

export type AgentDetailView = "dashboard" | "instructions" | "configuration" | "skills" | "integrations" | "runs" | "budget";

export function parseAgentDetailView(value: string | null): AgentDetailView {
  if (value === "instructions" || value === "prompts") return "instructions";
  if (value === "configure" || value === "configuration") return "configuration";
  if (value === "skills") return "skills";
  if (value === "integrations") return "integrations";
  if (value === "budget") return "budget";
  if (value === "runs") return value;
  return "dashboard";
}

export function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function usageString(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return null;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function setsEqual<T>(left: Set<T>, right: Set<T>) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export function runMetrics(run: HeartbeatRun) {
  const usage = (run.usageJson ?? null) as Record<string, unknown> | null;
  const result = (run.resultJson ?? null) as Record<string, unknown> | null;
  const input = usageNumber(usage, "inputTokens", "input_tokens");
  const output = usageNumber(usage, "outputTokens", "output_tokens");
  const cached =
    usageNumber(usage, "cachedInputTokens", "cached_input_tokens") +
    usageNumber(usage, "cache_read_input_tokens") +
    usageNumber(usage, "cache_creation_input_tokens");
  const provider = usageString(usage, "provider") ?? usageString(result, "provider");
  const cost =
    visibleRunCostUsd(usage, result);
  const summary = summarizeTokenUsage({
    provider,
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
  });
  return {
    input,
    output,
    cached,
    uncachedInput: summary.uncachedInputTokens,
    promptTokens: summary.promptTokens,
    cost,
    totalTokens: summary.totalTokens,
  };
}

export function summarizeRunCostUsage(runs: HeartbeatRun[]) {
  return runs.reduce(
    (summary, run) => {
      const metrics = runMetrics(run);
      summary.promptTokens += metrics.promptTokens;
      summary.outputTokens += metrics.output;
      summary.cachedInputTokens += metrics.cached;
      summary.totalCostCents += Math.round(metrics.cost * 100);
      summary.hasUsage ||= metrics.cost > 0 || metrics.input > 0 || metrics.output > 0 || metrics.cached > 0;
      return summary;
    },
    {
      promptTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalCostCents: 0,
      hasUsage: false,
    },
  );
}

export function summarizeCostTrendUsage(rows: CostTrendPoint[]) {
  return rows.reduce(
    (summary, row) => {
      const usage = summarizeTokenUsage(row);
      summary.promptTokens += usage.promptTokens;
      summary.outputTokens += usage.outputTokens;
      summary.cachedInputTokens += usage.cachedInputTokens;
      summary.totalCostCents += row.costCents;
      summary.hasUsage ||= row.costCents > 0 || usage.totalTokens > 0;
      return summary;
    },
    {
      promptTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalCostCents: 0,
      hasUsage: false,
    },
  );
}

export function formatExactTokens(value: number) {
  return Math.max(0, Math.floor(value)).toLocaleString();
}

export function formatExactTokenLabel(value: number) {
  return `${formatExactTokens(value)} tokens`;
}

export function formatCompactTokenLabel(value: number) {
  return `${formatTokens(value)} tokens`;
}

export function formatCacheRatio(cachedTokens: number, inputTokens: number) {
  const ratio = tokenUsageCacheRatio({ inputTokens, cachedInputTokens: cachedTokens });
  if (ratio == null) return "—";
  return `${Math.round(ratio * 100)}%`;
}

export function formatRunCostUsd(cost: number) {
  return cost > 0 ? `$${cost.toFixed(4)}` : "—";
}

export function shouldShowInlineTokenLabel(value: number, maxTokens: number) {
  return value > 0 && (value / Math.max(1, maxTokens)) * 100 >= 9;
}

export type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string };

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function runLogChunkDedupeKey(chunk: RunLogChunk): string {
  return `${chunk.ts}\u0000${chunk.stream}\u0000${chunk.chunk}`;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readInvocationSkillList(payload: Record<string, unknown> | null | undefined, key: string) {
  const raw = payload?.[key];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const skills: Array<{ key: string; label: string }> = [];
  for (const value of raw) {
    const record = asRecord(value);
    const skillKey = asNonEmptyString(record?.key) ?? asNonEmptyString(record?.runtimeName) ?? asNonEmptyString(record?.name);
    if (!skillKey || seen.has(skillKey)) continue;
    seen.add(skillKey);
    skills.push({
      key: skillKey,
      label: asNonEmptyString(record?.runtimeName) ?? asNonEmptyString(record?.name) ?? skillKey.split(/[/:]/).filter(Boolean).at(-1) ?? skillKey,
    });
  }
  return skills;
}

export function InvocationSkillEvidence({
  invocationPayload,
  usagePayload,
}: {
  invocationPayload: Record<string, unknown> | null | undefined;
  usagePayload?: Record<string, unknown> | null | undefined;
}) {
  const groups = [
    {
      key: "usedSkills",
      label: "Used by reading SKILL.md",
      skills: readInvocationSkillList(usagePayload, "usedSkills"),
    },
    {
      key: "runtimeUsedSkills",
      label: "Runtime reported",
      skills: readInvocationSkillList(invocationPayload, "usedSkills"),
    },
    {
      key: "promptRequestedSkills",
      label: "Prompt requested",
      skills: readInvocationSkillList(invocationPayload, "promptRequestedSkills"),
    },
    {
      key: "loadedSkills",
      label: "Loaded for run",
      skills: readInvocationSkillList(invocationPayload, "loadedSkills"),
    },
  ].filter((group) => group.skills.length > 0);

  if (groups.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">Skill usage</div>
      <div className="space-y-2">
        {groups.map((group) => (
          <div key={group.key} className="rounded-md border border-border/70 bg-background/60 px-2 py-1.5">
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">{group.label}</div>
            <div className="flex flex-wrap gap-1.5">
              {group.skills.map((skill) => (
                <span
                  key={skill.key}
                  className="rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-foreground"
                  title={skill.key}
                >
                  {skill.label}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function parseStoredLogContent(content: string): RunLogChunk[] {
  const parsed: RunLogChunk[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      const stream =
        raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      if (!chunk) continue;
      parsed.push({ ts, stream, chunk });
    } catch {
      // Ignore malformed log lines.
    }
  }
  return parsed;
}

export function RunEventsList({
  events,
  censorUsernameInLogs,
}: {
  events: HeartbeatRunEvent[];
  censorUsernameInLogs: boolean;
}) {
  if (events.length === 0) return null;

  const levelColors: Record<string, string> = {
    info: "text-foreground",
    warn: "text-yellow-600 dark:text-yellow-400",
    error: "text-red-600 dark:text-red-400",
  };

  const streamColors: Record<string, string> = {
    stdout: "text-foreground",
    stderr: "text-red-600 dark:text-red-300",
    system: "text-blue-600 dark:text-blue-300",
  };

  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted-foreground">Events ({events.length})</div>
      <div className="rounded-lg bg-neutral-100 p-3 font-mono text-xs space-y-0.5 dark:bg-neutral-950">
        {events.map((evt) => {
          const color = evt.color
            ?? (evt.level ? levelColors[evt.level] : null)
            ?? (evt.stream ? streamColors[evt.stream] : null)
            ?? "text-foreground";
          const text = heartbeatRunEventText(evt, {
            redactText: (value) => redactPathText(value, censorUsernameInLogs),
            redactValue: (value) => redactPathValue(value, censorUsernameInLogs),
          });

          return (
            <div key={evt.id} className="flex gap-2">
              <span className="text-neutral-400 dark:text-neutral-600 shrink-0 select-none w-16">
                {new Date(evt.createdAt).toLocaleTimeString("en-US", { hourCycle: "h23" })}
              </span>
              <span
                className={cn(
                  "shrink-0 w-14",
                  evt.stream ? (streamColors[evt.stream] ?? "text-neutral-500") : "text-neutral-500",
                )}
              >
                {evt.stream ? `[${evt.stream}]` : ""}
              </span>
              <span className={cn("break-all", color)}>{text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function workspaceOperationPhaseLabel(phase: WorkspaceOperation["phase"]) {
  switch (phase) {
    case "worktree_prepare":
      return "Worktree setup";
    case "workspace_provision":
      return "Provision";
    case "workspace_teardown":
      return "Teardown";
    case "worktree_cleanup":
      return "Worktree cleanup";
    default:
      return phase;
  }
}

export function workspaceOperationStatusTone(status: WorkspaceOperation["status"]) {
  switch (status) {
    case "succeeded":
      return "border-green-500/20 bg-green-500/10 text-green-700 dark:text-green-300";
    case "failed":
      return "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300";
    case "running":
      return "border-cyan-500/20 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300";
    case "skipped":
      return "border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300";
    default:
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

export function WorkspaceOperationStatusBadge({ status }: { status: WorkspaceOperation["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize",
        workspaceOperationStatusTone(status),
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export function WorkspaceOperationLogViewer({
  operation,
  censorUsernameInLogs,
}: {
  operation: WorkspaceOperation;
  censorUsernameInLogs: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data: logData, isLoading, error } = useQuery({
    queryKey: ["workspace-operation-log", operation.id],
    queryFn: () => heartbeatsApi.workspaceOperationLog(operation.id),
    enabled: open && Boolean(operation.logRef),
    refetchInterval: open && operation.status === "running" ? 2000 : false,
  });

  const chunks = useMemo(
    () => (logData?.content ? parseStoredLogContent(logData.content) : []),
    [logData?.content],
  );

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide full log" : "Show full log"}
      </button>
      {open && (
        <div className="rounded-md border border-border bg-background/70 p-2">
          {isLoading && <div className="text-xs text-muted-foreground">Loading log...</div>}
          {error && (
            <div className="text-xs text-destructive">
              {error instanceof Error ? error.message : "Failed to load workspace operation log"}
            </div>
          )}
          {!isLoading && !error && chunks.length === 0 && (
            <div className="text-xs text-muted-foreground">No persisted log lines.</div>
          )}
          {chunks.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded bg-neutral-100 p-2 font-mono text-xs dark:bg-neutral-950">
              {chunks.map((chunk, index) => (
                <div key={`${chunk.ts}-${index}`} className="flex gap-2">
                  <span className="shrink-0 text-neutral-500">
                    {new Date(chunk.ts).toLocaleTimeString("en-US", { hourCycle: "h23" })}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 w-14",
                      chunk.stream === "stderr"
                        ? "text-red-600 dark:text-red-300"
                        : chunk.stream === "system"
                          ? "text-blue-600 dark:text-blue-300"
                          : "text-muted-foreground",
                    )}
                  >
                    [{chunk.stream}]
                  </span>
                  <span className="whitespace-pre-wrap break-all">{redactPathText(chunk.chunk, censorUsernameInLogs)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkspaceOperationsSection({
  operations,
  censorUsernameInLogs,
}: {
  operations: WorkspaceOperation[];
  censorUsernameInLogs: boolean;
}) {
  if (operations.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-background/60 p-3 space-y-3">
      <div className="text-xs font-medium text-muted-foreground">
        Workspace ({operations.length})
      </div>
      <div className="space-y-3">
        {operations.map((operation) => {
          const metadata = asRecord(operation.metadata);
          return (
            <div key={operation.id} className="rounded-md border border-border/70 bg-background/70 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm font-medium">{workspaceOperationPhaseLabel(operation.phase)}</div>
                <WorkspaceOperationStatusBadge status={operation.status} />
                <div className="text-[11px] text-muted-foreground">
                  {relativeTime(operation.startedAt)}
                  {operation.finishedAt && ` to ${relativeTime(operation.finishedAt)}`}
                </div>
              </div>
              {operation.command && (
                <div className="text-xs break-all">
                  <span className="text-muted-foreground">Command: </span>
                  <span className="font-mono">{operation.command}</span>
                </div>
              )}
              {operation.cwd && (
                <div className="text-xs break-all">
                  <span className="text-muted-foreground">Working dir: </span>
                  <span className="font-mono">{operation.cwd}</span>
                </div>
              )}
              {(asNonEmptyString(metadata?.branchName)
                || asNonEmptyString(metadata?.baseRef)
                || asNonEmptyString(metadata?.worktreePath)
                || asNonEmptyString(metadata?.repoRoot)
                || asNonEmptyString(metadata?.cleanupAction)) && (
                <div className="grid gap-1 text-xs sm:grid-cols-2">
                  {asNonEmptyString(metadata?.branchName) && (
                    <div><span className="text-muted-foreground">Branch: </span><span className="font-mono">{metadata?.branchName as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.baseRef) && (
                    <div><span className="text-muted-foreground">Base ref: </span><span className="font-mono">{metadata?.baseRef as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.worktreePath) && (
                    <div className="break-all"><span className="text-muted-foreground">Worktree: </span><span className="font-mono">{metadata?.worktreePath as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.repoRoot) && (
                    <div className="break-all"><span className="text-muted-foreground">Repo root: </span><span className="font-mono">{metadata?.repoRoot as string}</span></div>
                  )}
                  {asNonEmptyString(metadata?.cleanupAction) && (
                    <div><span className="text-muted-foreground">Cleanup: </span><span className="font-mono">{metadata?.cleanupAction as string}</span></div>
                  )}
                </div>
              )}
              {typeof metadata?.created === "boolean" && (
                <div className="text-xs text-muted-foreground">
                  {metadata.created ? "Created by this run" : "Reused existing workspace"}
                </div>
              )}
              {operation.stderrExcerpt && operation.stderrExcerpt.trim() && (
                <div>
                  <div className="mb-1 text-xs text-red-700 dark:text-red-300">stderr excerpt</div>
                  <pre className="rounded-md bg-red-50 p-2 text-xs whitespace-pre-wrap break-all text-red-800 dark:bg-neutral-950 dark:text-red-100">
                    {redactPathText(operation.stderrExcerpt, censorUsernameInLogs)}
                  </pre>
                </div>
              )}
              {operation.stdoutExcerpt && operation.stdoutExcerpt.trim() && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">stdout excerpt</div>
                  <pre className="rounded-md bg-neutral-100 p-2 text-xs whitespace-pre-wrap break-all dark:bg-neutral-950">
                    {redactPathText(operation.stdoutExcerpt, censorUsernameInLogs)}
                  </pre>
                </div>
              )}
              {operation.logRef && (
                <WorkspaceOperationLogViewer
                  operation={operation}
                  censorUsernameInLogs={censorUsernameInLogs}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

export function useRunDurationNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  return now;
}
