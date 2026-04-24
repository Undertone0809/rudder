import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useParams, useNavigate, Link, Navigate, useBeforeUnload } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  agentsApi,
  type AgentKey,
  type ClaudeLoginResult,
  type AgentPermissionUpdate,
} from "../api/agents";
import { organizationSkillsApi } from "../api/organizationSkills";
import { budgetsApi } from "../api/budgets";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { ApiError } from "../api/client";
import {
  ChartCard,
  RunActivityChart,
  PriorityChart,
  IssueStatusChart,
  SuccessRateChart,
  SkillsUsageChart,
} from "../components/ActivityCharts";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useOrganization } from "../context/OrganizationContext";
import { useToast } from "../context/ToastContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { retryHeartbeatRun } from "../lib/heartbeat-retry";
import { queryKeys } from "../lib/queryKeys";
import { findOrganizationByPrefix } from "../lib/organization-routes";
import { AgentConfigForm } from "../components/AgentConfigForm";
import { PageTabBar } from "../components/PageTabBar";
import { roleLabels, help } from "../components/agent-config-primitives";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { assetsApi } from "../api/assets";
import { getUIAdapter, buildTranscript } from "../agent-runtimes";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { MarkdownBody } from "../components/MarkdownBody";
import { CopyText } from "../components/CopyText";
import { EntityRow } from "../components/EntityRow";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { RunButton, PauseResumeButton } from "../components/AgentActionButtons";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { PackageFileTree, buildFileTree } from "../components/PackageFileTree";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { formatCents, formatDate, relativeTime, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs } from "@/components/ui/tabs";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MoreHorizontal,
  CheckCircle2,
  XCircle,
  Clock,
  Timer,
  Loader2,
  Slash,
  RotateCcw,
  Trash2,
  Plus,
  Key,
  Eye,
  EyeOff,
  Copy,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  HelpCircle,
  FolderOpen,
  Search,
  MessageSquare,
  CalendarDays,
  Maximize2,
} from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  semanticBadgeToneClasses,
  semanticNoticeToneClasses,
} from "@/components/ui/semanticTones";
import { AgentIcon, AgentIconPicker } from "../components/AgentIconPicker";
import { RunTranscriptView, type TranscriptMode } from "../components/transcript/RunTranscriptView";
import {
  getBundledRudderSkillSlug,
  isUuidLike,
  type Agent,
  type AgentSkillAnalytics,
  type AgentSkillEntry,
  type AgentSkillSnapshot,
  type AgentDetail as AgentDetailRecord,
  type BudgetPolicySummary,
  type HeartbeatRun,
  type HeartbeatRunEvent,
  type AgentRuntimeState,
  type LiveEvent,
  type OrganizationSkillCreateRequest,
  type WorkspaceOperation,
} from "@rudder/shared";
import { redactHomePathUserSegments, redactHomePathUserSegmentsInValue } from "@rudder/agent-runtime-utils";
import { agentRouteRef } from "../lib/utils";
import { heartbeatRunEventText, heartbeatRunEventToTranscriptEntry, mergeTranscriptEntries } from "../lib/run-detail-events";
import {
  arraysEqual,
  canManageSkillEntry,
  isExternalSkillEntry,
  sortSkillRowsByPinnedSelectionKey,
  sortUnique,
  toggleSkillSelection,
} from "../lib/agent-skills-state";

const runStatusIcons: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  succeeded: { icon: CheckCircle2, color: "text-green-600 dark:text-green-400" },
  failed: { icon: XCircle, color: "text-red-600 dark:text-red-400" },
  running: { icon: Loader2, color: "text-cyan-600 dark:text-cyan-400" },
  queued: { icon: Clock, color: "text-yellow-600 dark:text-yellow-400" },
  timed_out: { icon: Timer, color: "text-orange-600 dark:text-orange-400" },
  cancelled: { icon: Slash, color: "text-neutral-500 dark:text-neutral-400" },
};

const REDACTED_ENV_VALUE = "***REDACTED***";
const SECRET_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
type DashboardDatePreset = "7d" | "15d" | "30d" | "custom";

const DASHBOARD_DATE_PRESETS: Array<{ key: DashboardDatePreset; label: string }> = [
  { key: "7d", label: "7D" },
  { key: "15d", label: "15D" },
  { key: "30d", label: "1M" },
];

function formatDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInputValue(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function getRecentDayKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const now = new Date();
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1 - index), 12, 0, 0, 0);
    return formatDateInputValue(date);
  });
}

function getDayKeysBetween(from: string, to: string): string[] {
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

function formatRangeLabel(preset: DashboardDatePreset, customFrom: string, customTo: string): string {
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

function isWithinRange(value: string | Date | null | undefined, from: string, to: string): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return false;
  if (from && timestamp < new Date(from).getTime()) return false;
  if (to && timestamp > new Date(to).getTime()) return false;
  return true;
}

function DashboardDateRangeControl({
  preset,
  customFrom,
  customTo,
  customOpen,
  onCustomOpenChange,
  onPresetSelect,
  onCustomFromChange,
  onCustomToChange,
}: {
  preset: DashboardDatePreset;
  customFrom: string;
  customTo: string;
  customOpen: boolean;
  onCustomOpenChange: (open: boolean) => void;
  onPresetSelect: (preset: DashboardDatePreset) => void;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
}) {
  return (
    <div className="flex justify-end">
      <div className="flex items-center gap-1 rounded-full border border-border/70 bg-background/90 p-1 shadow-sm">
        {DASHBOARD_DATE_PRESETS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => onPresetSelect(option.key)}
            className={cn(
              "h-8 rounded-full px-3 text-xs font-medium transition-colors",
              preset === option.key
                ? "bg-background text-foreground shadow-sm ring-1 ring-border/70"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            aria-pressed={preset === option.key}
          >
            {option.label}
          </button>
        ))}
        <Popover open={customOpen} onOpenChange={onCustomOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={() => onPresetSelect("custom")}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors",
                preset === "custom"
                  ? "bg-background text-foreground shadow-sm ring-1 ring-border/70"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              aria-pressed={preset === "custom"}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Custom
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[24rem] p-3">
            <div className="space-y-3">
              <div>
                <div className="text-sm font-medium text-foreground">Custom range</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Filter dashboard charts and skills analytics by a specific date window.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
                  <span>From</span>
                  <input
                    aria-label="From"
                    type="date"
                    value={customFrom}
                    onChange={(event) => onCustomFromChange(event.target.value)}
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  />
                </label>
                <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
                  <span>To</span>
                  <input
                    aria-label="To"
                    type="date"
                    value={customTo}
                    onChange={(event) => onCustomToChange(event.target.value)}
                    className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  />
                </label>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function compactSkillText(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[`*_>#-]/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveSkillSummaryText(
  description: string | null | undefined,
  detail: string | null | undefined,
) {
  return description ?? detail ?? "No description provided.";
}

function isGenericSkillRuntimeDetail(value: string | null | undefined) {
  if (!value) return false;
  const normalized = compactSkillText(value)?.toLowerCase() ?? "";
  return normalized === "will be mounted into the ephemeral claude skill directory on the next run."
    || normalized === "enabled for this agent. rudder will mount this user installed claude skill on the next run."
    || normalized === "installed outside rudder management in the claude skills home.";
}

function isGenericSkillLocationLabel(value: string | null | undefined) {
  if (!value) return false;
  return /^~\/\.[^/]+(?:\/agent)?\/skills$/i.test(value.trim());
}

function SkillSwitch({
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

function CreateAgentSkillDialog({
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

function shouldHideExternalSkillEntry(entry: AgentSkillEntry) {
  const candidate = (entry.runtimeName ?? entry.key).trim();
  if (!candidate) return true;
  return candidate === ".DS_Store" || candidate.startsWith(".");
}

function redactPathText(value: string, censorUsernameInLogs: boolean) {
  return redactHomePathUserSegments(value, { enabled: censorUsernameInLogs });
}

function redactPathValue<T>(value: T, censorUsernameInLogs: boolean): T {
  return redactHomePathUserSegmentsInValue(value, { enabled: censorUsernameInLogs });
}

function formatInvocationValueForDisplay(value: unknown, censorUsernameInLogs: boolean): string {
  if (typeof value === "string") return redactPathText(value, censorUsernameInLogs);
  try {
    return JSON.stringify(redactPathValue(value, censorUsernameInLogs), null, 2);
  } catch {
    return redactPathText(String(value), censorUsernameInLogs);
  }
}

function shouldRedactSecretValue(key: string, value: unknown): boolean {
  if (SECRET_ENV_KEY_RE.test(key)) return true;
  if (typeof value !== "string") return false;
  return JWT_VALUE_RE.test(value);
}

function redactEnvValue(key: string, value: unknown, censorUsernameInLogs: boolean): string {
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

function isMarkdown(pathValue: string) {
  return pathValue.toLowerCase().endsWith(".md");
}

function formatEnvForDisplay(envValue: unknown, censorUsernameInLogs: boolean): string {
  const env = asRecord(envValue);
  if (!env) return "<unable-to-parse>";

  const keys = Object.keys(env);
  if (keys.length === 0) return "<empty>";

  return keys
    .sort()
    .map((key) => `${key}=${redactEnvValue(key, env[key], censorUsernameInLogs)}`)
    .join("\n");
}

const sourceLabels: Record<string, string> = {
  timer: "Timer",
  assignment: "Assignment",
  on_demand: "On-demand",
  automation: "Automation",
};

const LIVE_SCROLL_BOTTOM_TOLERANCE_PX = 32;
type ScrollContainer = Window | HTMLElement;

function isWindowContainer(container: ScrollContainer): container is Window {
  return container === window;
}

function isElementScrollContainer(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

function findScrollContainer(anchor: HTMLElement | null): ScrollContainer {
  let parent = anchor?.parentElement ?? null;
  while (parent) {
    if (isElementScrollContainer(parent)) return parent;
    parent = parent.parentElement;
  }
  return window;
}

function readScrollMetrics(container: ScrollContainer): { scrollHeight: number; distanceFromBottom: number } {
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

function scrollToContainerBottom(container: ScrollContainer, behavior: ScrollBehavior = "auto") {
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

type AgentDetailView = "dashboard" | "instructions" | "configuration" | "skills" | "runs" | "budget";

function parseAgentDetailView(value: string | null): AgentDetailView {
  if (value === "instructions" || value === "prompts") return "instructions";
  if (value === "configure" || value === "configuration") return "configuration";
  if (value === "skills") return "skills";
  if (value === "budget") return "budget";
  if (value === "runs") return value;
  return "dashboard";
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function setsEqual<T>(left: Set<T>, right: Set<T>) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function runMetrics(run: HeartbeatRun) {
  const usage = (run.usageJson ?? null) as Record<string, unknown> | null;
  const result = (run.resultJson ?? null) as Record<string, unknown> | null;
  const input = usageNumber(usage, "inputTokens", "input_tokens");
  const output = usageNumber(usage, "outputTokens", "output_tokens");
  const cached = usageNumber(
    usage,
    "cachedInputTokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
  );
  const cost =
    visibleRunCostUsd(usage, result);
  return {
    input,
    output,
    cached,
    cost,
    totalTokens: input + output,
  };
}

type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string };

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function runLogChunkDedupeKey(chunk: RunLogChunk): string {
  return `${chunk.ts}\u0000${chunk.stream}\u0000${chunk.chunk}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseStoredLogContent(content: string): RunLogChunk[] {
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

function RunEventsList({
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
                {new Date(evt.createdAt).toLocaleTimeString("en-US", { hour12: false })}
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

function workspaceOperationPhaseLabel(phase: WorkspaceOperation["phase"]) {
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

function workspaceOperationStatusTone(status: WorkspaceOperation["status"]) {
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

function WorkspaceOperationStatusBadge({ status }: { status: WorkspaceOperation["status"] }) {
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

function WorkspaceOperationLogViewer({
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
                    {new Date(chunk.ts).toLocaleTimeString("en-US", { hour12: false })}
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

function WorkspaceOperationsSection({
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

export function AgentDetail() {
  const { orgPrefix, agentId, tab: urlTab, runId: urlRunId } = useParams<{
    orgPrefix?: string;
    agentId: string;
    tab?: string;
    runId?: string;
  }>();
  const { organizations, selectedOrganizationId, setSelectedOrganizationId } = useOrganization();
  const { closePanel } = usePanel();
  const { openNewIssue } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [terminateConfirmOpen, setTerminateConfirmOpen] = useState(false);
  const activeView = urlRunId ? "runs" as AgentDetailView : parseAgentDetailView(urlTab ?? null);
  const needsDashboardData = activeView === "dashboard";
  const needsRunData = activeView === "runs" || Boolean(urlRunId);
  const shouldLoadHeartbeats = needsDashboardData || needsRunData;
  const [datePreset, setDatePreset] = useState<DashboardDatePreset>("7d");
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const saveConfigActionRef = useRef<(() => void) | null>(null);
  const cancelConfigActionRef = useRef<(() => void) | null>(null);
  const { isMobile } = useSidebar();
  const routeAgentRef = agentId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!orgPrefix) return null;
    return findOrganizationByPrefix({
      organizations,
      organizationPrefix: orgPrefix,
    })?.id ?? null;
  }, [organizations, orgPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedOrganizationId ?? undefined;
  const canFetchAgent = routeAgentRef.length > 0 && (isUuidLike(routeAgentRef) || Boolean(lookupCompanyId));
  const setSaveConfigAction = useCallback((fn: (() => void) | null) => { saveConfigActionRef.current = fn; }, []);
  const setCancelConfigAction = useCallback((fn: (() => void) | null) => { cancelConfigActionRef.current = fn; }, []);

  const { data: agent, isLoading, error } = useQuery<AgentDetailRecord>({
    queryKey: [...queryKeys.agents.detail(routeAgentRef), lookupCompanyId ?? null],
    queryFn: () => agentsApi.get(routeAgentRef, lookupCompanyId),
    enabled: canFetchAgent,
  });
  const resolvedCompanyId = agent?.orgId ?? selectedOrganizationId;
  const canonicalAgentRef = agent ? agentRouteRef(agent) : routeAgentRef;
  const agentLookupRef = agent?.id ?? routeAgentRef;
  const resolvedAgentId = agent?.id ?? null;

  const { data: runtimeState } = useQuery({
    queryKey: queryKeys.agents.runtimeState(resolvedAgentId ?? routeAgentRef),
    queryFn: () => agentsApi.runtimeState(resolvedAgentId!, resolvedCompanyId ?? undefined),
    enabled: Boolean(resolvedAgentId) && needsDashboardData,
  });

  const { from, to, customReady } = useMemo(() => {
    const now = new Date();

    if (datePreset === "custom") {
      const fromDate = customFrom ? new Date(`${customFrom}T00:00:00`) : null;
      const toDate = customTo ? new Date(`${customTo}T23:59:59.999`) : null;
      return {
        from: fromDate ? fromDate.toISOString() : "",
        to: toDate ? toDate.toISOString() : "",
        customReady: !!customFrom && !!customTo,
      };
    }

    const days = datePreset === "7d" ? 7 : datePreset === "15d" ? 15 : 30;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0);
    return {
      from: start.toISOString(),
      to: now.toISOString(),
      customReady: true,
    };
  }, [customFrom, customTo, datePreset]);

  const chartDays = useMemo(() => {
    if (datePreset === "7d") return getRecentDayKeys(7);
    if (datePreset === "15d") return getRecentDayKeys(15);
    if (datePreset === "30d") return getRecentDayKeys(30);
    return getDayKeysBetween(customFrom, customTo);
  }, [customFrom, customTo, datePreset]);

  const rangeLabel = useMemo(
    () => formatRangeLabel(datePreset, customFrom, customTo),
    [customFrom, customTo, datePreset],
  );

  const { data: skillAnalytics } = useQuery({
    queryKey: [
      ...queryKeys.agents.skillsAnalytics(resolvedAgentId ?? routeAgentRef),
      datePreset,
      customFrom,
      customTo,
    ],
    queryFn: () => agentsApi.skillsAnalytics(resolvedAgentId!, {
      orgId: resolvedCompanyId ?? undefined,
      ...(datePreset === "custom" && customReady
        ? { startDate: customFrom, endDate: customTo }
        : { windowDays: datePreset === "7d" ? 7 : datePreset === "15d" ? 15 : 30 }),
    }),
    enabled: Boolean(resolvedAgentId) && needsDashboardData && (datePreset !== "custom" || customReady),
  });

  const { data: heartbeats } = useQuery({
    queryKey: queryKeys.heartbeats(resolvedCompanyId!, agent?.id ?? undefined),
    queryFn: () => heartbeatsApi.list(resolvedCompanyId!, agent?.id ?? undefined),
    enabled: !!resolvedCompanyId && !!agent?.id && shouldLoadHeartbeats,
  });

  const { data: allIssues } = useQuery({
    queryKey: [...queryKeys.issues.list(resolvedCompanyId!), "participant-agent", resolvedAgentId ?? "__none__"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { participantAgentId: resolvedAgentId! }),
    enabled: !!resolvedCompanyId && !!resolvedAgentId && needsDashboardData,
  });

  const { data: allAgents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId && needsDashboardData,
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(resolvedCompanyId ?? "__none__"),
    queryFn: () => budgetsApi.overview(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const assignedIssues = (allIssues ?? [])
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const filteredRuns = useMemo(
    () => (heartbeats ?? []).filter((run) => isWithinRange(run.createdAt, from, to)),
    [from, heartbeats, to],
  );
  const filteredAssignedIssues = useMemo(
    () => assignedIssues.filter((issue) => isWithinRange(issue.createdAt, from, to)),
    [assignedIssues, from, to],
  );
  const handleDashboardPresetSelect = useCallback((nextPreset: DashboardDatePreset) => {
    if (nextPreset === "custom") {
      if (!customFrom || !customTo) {
        const today = new Date();
        const lastWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
        setCustomFrom(formatDateInputValue(lastWeek));
        setCustomTo(formatDateInputValue(today));
      }
      setDatePreset("custom");
      setCustomRangeOpen(true);
      return;
    }

    setCustomRangeOpen(false);
    setDatePreset(nextPreset);
  }, [customFrom, customTo]);
  const reportsToAgent = (allAgents ?? []).find((a) => a.id === agent?.reportsTo);
  const directReports = (allAgents ?? []).filter((a) => a.reportsTo === agent?.id && a.status !== "terminated");
  const agentBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "agent" && policy.scopeId === (agent?.id ?? routeAgentRef),
    );
    if (matched) return matched;
    const budgetMonthlyCents = agent?.budgetMonthlyCents ?? 0;
    const spentMonthlyCents = agent?.spentMonthlyCents ?? 0;
    return {
      policyId: "",
      orgId: resolvedCompanyId ?? "",
      scopeType: "agent",
      scopeId: agent?.id ?? routeAgentRef,
      scopeName: agent?.name ?? "Agent",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: budgetMonthlyCents,
      observedAmount: spentMonthlyCents,
      remainingAmount: Math.max(0, budgetMonthlyCents - spentMonthlyCents),
      utilizationPercent:
        budgetMonthlyCents > 0 ? Number(((spentMonthlyCents / budgetMonthlyCents) * 100).toFixed(2)) : 0,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: budgetMonthlyCents > 0,
      status: budgetMonthlyCents > 0 && spentMonthlyCents >= budgetMonthlyCents ? "hard_stop" : "ok",
      paused: agent?.status === "paused",
      pauseReason: agent?.pauseReason ?? null,
      windowStart: new Date(),
      windowEnd: new Date(),
    } satisfies BudgetPolicySummary;
  }, [agent, budgetOverview?.policies, resolvedCompanyId, routeAgentRef]);
  const mobileLiveRun = useMemo(
    () => (heartbeats ?? []).find((r) => r.status === "running" || r.status === "queued") ?? null,
    [heartbeats],
  );

  useEffect(() => {
    if (!agent) return;
    if (urlRunId) {
      if (routeAgentRef !== canonicalAgentRef) {
        navigate(`/agents/${canonicalAgentRef}/runs/${urlRunId}`, { replace: true });
      }
      return;
    }
    const canonicalTab =
      activeView === "instructions"
        ? "instructions"
        : activeView === "configuration"
          ? "configuration"
          : activeView === "skills"
            ? "skills"
            : activeView === "runs"
              ? "runs"
              : activeView === "budget"
                ? "budget"
              : "dashboard";
    if (routeAgentRef !== canonicalAgentRef || urlTab !== canonicalTab) {
      navigate(`/agents/${canonicalAgentRef}/${canonicalTab}`, { replace: true });
      return;
    }
  }, [agent, routeAgentRef, canonicalAgentRef, urlRunId, urlTab, activeView, navigate]);

  useEffect(() => {
    if (!agent?.orgId || agent.orgId === selectedOrganizationId) return;
    setSelectedOrganizationId(agent.orgId, { source: "route_sync" });
  }, [agent?.orgId, selectedOrganizationId, setSelectedOrganizationId]);

  const agentAction = useMutation({
    mutationFn: async (action: "invoke" | "pause" | "resume" | "terminate") => {
      if (!agentLookupRef) return Promise.reject(new Error("No agent reference"));
      switch (action) {
        case "invoke": return agentsApi.invoke(agentLookupRef, resolvedCompanyId ?? undefined);
        case "pause": return agentsApi.pause(agentLookupRef, resolvedCompanyId ?? undefined);
        case "resume": return agentsApi.resume(agentLookupRef, resolvedCompanyId ?? undefined);
        case "terminate": return agentsApi.terminate(agentLookupRef, resolvedCompanyId ?? undefined);
      }
    },
    onSuccess: (data, action) => {
      setActionError(null);
      if (action === "terminate") {
        setTerminateConfirmOpen(false);
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
        if (agent?.id) {
          queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(resolvedCompanyId, agent.id) });
        }
      }
      if (action === "invoke" && data && typeof data === "object" && "id" in data) {
        navigate(`/agents/${canonicalAgentRef}/runs/${(data as HeartbeatRun).id}`);
      }
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Action failed");
    },
  });

  const budgetMutation = useMutation({
    mutationFn: (amount: number) =>
      budgetsApi.upsertPolicy(resolvedCompanyId!, {
        scopeType: "agent",
        scopeId: agent?.id ?? routeAgentRef,
        amount,
        windowKind: "calendar_month_utc",
      }),
    onSuccess: () => {
      if (!resolvedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(resolvedCompanyId) });
    },
  });

  const updateIcon = useMutation({
    mutationFn: (icon: string) => agentsApi.update(agentLookupRef, { icon }, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
  });

  const resetTaskSession = useMutation({
    mutationFn: (taskKey: string | null) =>
      agentsApi.resetSession(agentLookupRef, taskKey, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agentLookupRef) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reset session");
    },
  });

  const updatePermissions = useMutation({
    mutationFn: (permissions: AgentPermissionUpdate) =>
      agentsApi.updatePermissions(agentLookupRef, permissions, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to update permissions");
    },
  });

  useEffect(() => {
    const crumbs: { label: string; href?: string }[] = [
      { label: "Agents", href: "/agents" },
    ];
    const agentName = agent?.name ?? routeAgentRef ?? "Agent";
    if (activeView === "dashboard" && !urlRunId) {
      crumbs.push({ label: agentName });
    } else {
      crumbs.push({ label: agentName, href: `/agents/${canonicalAgentRef}/dashboard` });
      if (urlRunId) {
        crumbs.push({ label: "Runs", href: `/agents/${canonicalAgentRef}/runs` });
        crumbs.push({ label: `Run ${urlRunId.slice(0, 8)}` });
      } else if (activeView === "instructions") {
        crumbs.push({ label: "Instructions" });
      } else if (activeView === "configuration") {
        crumbs.push({ label: "Configuration" });
      // } else if (activeView === "skills") { // TODO: bring back later
      //   crumbs.push({ label: "Skills" });
      } else if (activeView === "runs") {
        crumbs.push({ label: "Runs" });
      } else if (activeView === "budget") {
        crumbs.push({ label: "Budget" });
      } else {
        crumbs.push({ label: "Dashboard" });
      }
    }
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, agent, routeAgentRef, canonicalAgentRef, activeView, urlRunId]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useBeforeUnload(
    useCallback((event) => {
      if (!configDirty) return;
      event.preventDefault();
      event.returnValue = "";
    }, [configDirty]),
  );

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!agent) return null;
  if (!urlRunId && !urlTab) {
    return <Navigate to={`/agents/${canonicalAgentRef}/dashboard`} replace />;
  }
  const isPendingApproval = agent.status === "pending_approval";
  const showConfigActionBar = (activeView === "configuration" || activeView === "instructions") && (configDirty || configSaving);

  return (
    <>
      <Dialog open={terminateConfirmOpen} onOpenChange={setTerminateConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Terminate agent</DialogTitle>
            <DialogDescription>
              Stop this agent permanently. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">{agent.name}</span> will be marked as terminated and can no longer run or resume.
            </p>
            <p>
              Future heartbeats will stay disabled until you create or replace it.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setTerminateConfirmOpen(false)}
              disabled={agentAction.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => agentAction.mutate("terminate")}
              disabled={agentAction.isPending}
            >
              {agentAction.isPending ? "Terminating..." : "Terminate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className={cn("space-y-6", isMobile && showConfigActionBar && "pb-24")}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <AgentIconPicker
            value={agent.icon}
            onChange={(icon) => updateIcon.mutate(icon)}
          >
            <button className="shrink-0 flex items-center justify-center h-12 w-12 rounded-lg bg-accent hover:bg-accent/80 transition-colors">
              <AgentIcon icon={agent.icon} className="h-6 w-6" />
            </button>
          </AgentIconPicker>
          <div className="min-w-0">
            <h2 className="text-2xl font-bold truncate">{agent.name}</h2>
            <p className="text-sm text-muted-foreground truncate">
              {roleLabels[agent.role] ?? agent.role}
              {agent.title ? ` - ${agent.title}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openNewIssue({ assigneeAgentId: agent.id })}
          >
            <Plus className="h-3.5 w-3.5 sm:mr-1" />
            <span className="hidden sm:inline">Assign Task</span>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link
              to={{
                pathname: "/messenger/chat",
                search: `?agentId=${encodeURIComponent(agent.id)}`,
              }}
            >
              <MessageSquare className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">Chat</span>
            </Link>
          </Button>
          <RunButton
            onClick={() => agentAction.mutate("invoke")}
            disabled={agentAction.isPending || isPendingApproval}
            label="Run Heartbeat"
          />
          <PauseResumeButton
            isPaused={agent.status === "paused"}
            onPause={() => agentAction.mutate("pause")}
            onResume={() => agentAction.mutate("resume")}
            disabled={agentAction.isPending || isPendingApproval}
          />
          <span className="hidden sm:inline"><StatusBadge status={agent.status} /></span>
          {mobileLiveRun && (
            <Link
              to={`/agents/${canonicalAgentRef}/runs/${mobileLiveRun.id}`}
              className="sm:hidden flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
            >
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">Live</span>
            </Link>
          )}

          {/* Overflow menu */}
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Agent actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="end">
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                onClick={() => {
                  navigator.clipboard.writeText(agent.id);
                  setMoreOpen(false);
                }}
              >
                <Copy className="h-3 w-3" />
                Copy Agent ID
              </button>
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                onClick={() => {
                  resetTaskSession.mutate(null);
                  setMoreOpen(false);
                }}
              >
                <RotateCcw className="h-3 w-3" />
                Reset Sessions
              </button>
              <button
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
                onClick={() => {
                  setMoreOpen(false);
                  setTerminateConfirmOpen(true);
                }}
              >
                <Trash2 className="h-3 w-3" />
                Terminate
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {!urlRunId && (
        <Tabs
          value={activeView}
          onValueChange={(value) => navigate(`/agents/${canonicalAgentRef}/${value}`)}
        >
          <div className="flex items-start justify-between gap-4">
            <PageTabBar
              items={[
                { value: "dashboard", label: "Dashboard" },
                { value: "instructions", label: "Instructions" },
                { value: "skills", label: "Skills" },
                { value: "configuration", label: "Configuration" },
                { value: "runs", label: "Runs" },
                { value: "budget", label: "Budget" },
              ]}
              value={activeView}
              onValueChange={(value) => navigate(`/agents/${canonicalAgentRef}/${value}`)}
            />
            {activeView === "dashboard" ? (
              <div className="hidden lg:block shrink-0">
                <DashboardDateRangeControl
                  preset={datePreset}
                  customFrom={customFrom}
                  customTo={customTo}
                  customOpen={customRangeOpen}
                  onCustomOpenChange={setCustomRangeOpen}
                  onPresetSelect={handleDashboardPresetSelect}
                  onCustomFromChange={setCustomFrom}
                  onCustomToChange={setCustomTo}
                />
              </div>
            ) : null}
          </div>
        </Tabs>
      )}

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {isPendingApproval && (
        <p className="text-sm text-amber-500">
          This agent is pending board approval and cannot be invoked yet.
        </p>
      )}

      {/* Floating Save/Cancel (desktop) */}
      {!isMobile && (
        <div
          className={cn(
            "sticky top-6 z-10 float-right transition-opacity duration-150",
            showConfigActionBar
              ? "opacity-100"
              : "opacity-0 pointer-events-none"
          )}
        >
          <div className="flex items-center gap-2 bg-background/90 backdrop-blur-sm border border-border rounded-lg px-3 py-1.5 shadow-lg">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelConfigActionRef.current?.()}
              disabled={configSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => saveConfigActionRef.current?.()}
              disabled={configSaving}
            >
              {configSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* Mobile bottom Save/Cancel bar */}
      {isMobile && showConfigActionBar && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur-sm">
          <div
            className="flex items-center justify-end gap-2 px-3 py-2"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelConfigActionRef.current?.()}
              disabled={configSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => saveConfigActionRef.current?.()}
              disabled={configSaving}
            >
              {configSaving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* View content */}
      {activeView === "dashboard" && (
        <AgentOverview
          agent={agent}
          runs={heartbeats ?? []}
          chartRuns={filteredRuns}
          assignedIssues={assignedIssues}
          chartIssues={filteredAssignedIssues}
          runtimeState={runtimeState}
          skillAnalytics={skillAnalytics}
          agentId={agent.id}
          agentRouteId={canonicalAgentRef}
          rangeLabel={rangeLabel}
          chartDays={chartDays}
          showDashboardFilters={datePreset !== "custom" || customReady}
          dateFilterControl={(
            <div className="lg:hidden">
              <DashboardDateRangeControl
                preset={datePreset}
                customFrom={customFrom}
                customTo={customTo}
                customOpen={customRangeOpen}
                onCustomOpenChange={setCustomRangeOpen}
                onPresetSelect={handleDashboardPresetSelect}
                onCustomFromChange={setCustomFrom}
                onCustomToChange={setCustomTo}
              />
            </div>
          )}
        />
      )}

      {activeView === "instructions" && (
        <PromptsTab
          agent={agent}
          orgId={resolvedCompanyId ?? undefined}
          onDirtyChange={setConfigDirty}
          onSaveActionChange={setSaveConfigAction}
          onCancelActionChange={setCancelConfigAction}
          onSavingChange={setConfigSaving}
        />
      )}

      {activeView === "configuration" && (
        <AgentConfigurePage
          agent={agent}
          agentId={agent.id}
          orgId={resolvedCompanyId ?? undefined}
          onDirtyChange={setConfigDirty}
          onSaveActionChange={setSaveConfigAction}
          onCancelActionChange={setCancelConfigAction}
          onSavingChange={setConfigSaving}
          updatePermissions={updatePermissions}
        />
      )}

      {activeView === "skills" && (
        <AgentSkillsTab
          agent={agent}
          orgId={resolvedCompanyId ?? undefined}
        />
      )}

      {activeView === "runs" && (
        <RunsTab
          runs={heartbeats ?? []}
          orgId={resolvedCompanyId!}
          agentId={agent.id}
          agentRouteId={canonicalAgentRef}
          selectedRunId={urlRunId ?? null}
          agentRuntimeType={agent.agentRuntimeType}
        />
      )}

      {activeView === "budget" && resolvedCompanyId ? (
        <div className="max-w-3xl">
          <BudgetPolicyCard
            summary={agentBudgetSummary}
            isSaving={budgetMutation.isPending}
            onSave={(amount) => budgetMutation.mutate(amount)}
            variant="plain"
          />
        </div>
      ) : null}
      </div>
    </>
  );
}

/* ---- Helper components ---- */

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function LatestRunCard({ runs, agentId }: { runs: HeartbeatRun[]; agentId: string }) {
  if (runs.length === 0) return null;

  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const liveRun = sorted.find((r) => r.status === "running" || r.status === "queued");
  const run = liveRun ?? sorted[0];
  const isLive = run.status === "running" || run.status === "queued";
  const statusInfo = runStatusIcons[run.status] ?? { icon: Clock, color: "text-neutral-400" };
  const StatusIcon = statusInfo.icon;
  const summary = run.resultJson
    ? String((run.resultJson as Record<string, unknown>).summary ?? (run.resultJson as Record<string, unknown>).result ?? "")
    : run.error ?? "";

  return (
    <div className="space-y-3">
      <div className="flex w-full items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {isLive && (
            <span className="relative flex h-2 w-2">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
            </span>
          )}
          {isLive ? "Live Run" : "Latest Run"}
        </h3>
        <Link
          to={`/agents/${agentId}/runs/${run.id}`}
          className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors no-underline"
        >
          View details &rarr;
        </Link>
      </div>

      <Link
        to={`/agents/${agentId}/runs/${run.id}`}
        className={cn(
          "block border rounded-lg p-4 space-y-2 w-full no-underline transition-colors hover:bg-muted/50 cursor-pointer",
          isLive ? "border-cyan-500/30 shadow-[0_0_12px_rgba(6,182,212,0.08)]" : "border-border"
        )}
      >
        <div className="flex items-center gap-2">
          <StatusIcon className={cn("h-3.5 w-3.5", statusInfo.color, run.status === "running" && "animate-spin")} />
          <StatusBadge status={run.status} />
          <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
          <span className={cn(
            "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            run.invocationSource === "timer" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
              : run.invocationSource === "assignment" ? "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"
              : run.invocationSource === "on_demand" ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"
              : "bg-muted text-muted-foreground"
          )}>
            {sourceLabels[run.invocationSource] ?? run.invocationSource}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">{relativeTime(run.createdAt)}</span>
        </div>

        {summary && (
          <div className="overflow-hidden max-h-16">
            <MarkdownBody className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{summary}</MarkdownBody>
          </div>
        )}
      </Link>
    </div>
  );
}

/* ---- Agent Overview (main single-page view) ---- */

function AgentOverview({
  agent,
  runs,
  chartRuns,
  assignedIssues,
  chartIssues,
  runtimeState,
  skillAnalytics,
  agentId,
  agentRouteId,
  rangeLabel,
  chartDays,
  showDashboardFilters,
  dateFilterControl,
}: {
  agent: AgentDetailRecord;
  runs: HeartbeatRun[];
  chartRuns: HeartbeatRun[];
  assignedIssues: { id: string; title: string; status: string; priority: string; identifier?: string | null; createdAt: Date }[];
  chartIssues: { id: string; title: string; status: string; priority: string; identifier?: string | null; createdAt: Date }[];
  runtimeState?: AgentRuntimeState;
  skillAnalytics?: AgentSkillAnalytics;
  agentId: string;
  agentRouteId: string;
  rangeLabel: string;
  chartDays: string[];
  showDashboardFilters: boolean;
  dateFilterControl?: React.ReactNode;
}) {
  const visibleSkillAnalytics = skillAnalytics && skillAnalytics.totalRunsWithSkills > 0
    ? skillAnalytics
    : null;
  const shouldShowSkills = visibleSkillAnalytics !== null;

  return (
    <div className="space-y-8">
      {dateFilterControl}

      {/* Latest Run */}
      <LatestRunCard runs={runs} agentId={agentRouteId} />

      {/* Charts */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <ChartCard title="Run Activity" subtitle={`${rangeLabel} · relative daily run volume · hover for details`}>
          <RunActivityChart runs={chartRuns} days={chartDays} />
        </ChartCard>
        <ChartCard title="Issues by Priority" subtitle={`${rangeLabel} · relative daily issue volume · hover for details`}>
          <PriorityChart issues={chartIssues} days={chartDays} />
        </ChartCard>
        <ChartCard title="Issues by Status" subtitle={`${rangeLabel} · relative daily issue volume · hover for details`}>
          <IssueStatusChart issues={chartIssues} days={chartDays} />
        </ChartCard>
        <ChartCard title="Success Rate" subtitle={`${rangeLabel} · daily success rate · hover for details`}>
          <SuccessRateChart runs={chartRuns} days={chartDays} />
        </ChartCard>
      </div>

      {showDashboardFilters && shouldShowSkills ? (
        <div className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Skills</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Loaded skills per run for {rangeLabel}. Hover a day to inspect the breakdown.
              </p>
            </div>
            <div className="text-right text-[11px] text-muted-foreground tabular-nums">
              <div>{visibleSkillAnalytics.totalCount} skill loads</div>
              <div>{visibleSkillAnalytics.totalRunsWithSkills} runs with skill metadata</div>
            </div>
          </div>
          <div className="border border-border rounded-lg p-4">
            <SkillsUsageChart analytics={visibleSkillAnalytics} />
          </div>
        </div>
      ) : null}

      {/* Recent Issues */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent Issues</h3>
          <Link
            to={`/issues?participantAgentId=${agentId}`}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            See All &rarr;
          </Link>
        </div>
        {assignedIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent issues.</p>
        ) : (
          <div className="border border-border rounded-lg">
            {assignedIssues.slice(0, 10).map((issue) => (
              <EntityRow
                key={issue.id}
                identifier={issue.identifier ?? issue.id.slice(0, 8)}
                title={issue.title}
                to={`/issues/${issue.identifier ?? issue.id}`}
                trailing={<StatusBadge status={issue.status} />}
              />
            ))}
            {assignedIssues.length > 10 && (
              <div className="px-3 py-2 text-xs text-muted-foreground text-center border-t border-border">
                +{assignedIssues.length - 10} more issues
              </div>
            )}
          </div>
        )}
      </div>

      {/* Costs */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Costs</h3>
        <CostsSection runtimeState={runtimeState} runs={runs} />
      </div>
    </div>
  );
}

/* ---- Costs Section (inline) ---- */

function CostsSection({
  runtimeState,
  runs,
}: {
  runtimeState?: AgentRuntimeState;
  runs: HeartbeatRun[];
}) {
  const runsWithCost = runs
    .filter((r) => {
      const metrics = runMetrics(r);
      return metrics.cost > 0 || metrics.input > 0 || metrics.output > 0 || metrics.cached > 0;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="space-y-4">
      {runtimeState && (
        <div className="border border-border rounded-lg p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 tabular-nums">
            <div>
              <span className="text-xs text-muted-foreground block">Input tokens</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeState.totalInputTokens)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Output tokens</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeState.totalOutputTokens)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Cached tokens</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeState.totalCachedInputTokens)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Total cost</span>
              <span className="text-lg font-semibold">{formatCents(runtimeState.totalCostCents)}</span>
            </div>
          </div>
        </div>
      )}
      {runsWithCost.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-accent/20">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Run</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Input</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Output</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Cost</th>
              </tr>
            </thead>
            <tbody>
              {runsWithCost.slice(0, 10).map((run) => {
                const metrics = runMetrics(run);
                return (
                  <tr key={run.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">{formatDate(run.createdAt)}</td>
                    <td className="px-3 py-2 font-mono">{run.id.slice(0, 8)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatTokens(metrics.input)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatTokens(metrics.output)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {metrics.cost > 0
                        ? `$${metrics.cost.toFixed(4)}`
                        : "-"
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---- Agent Configure Page ---- */

function AgentConfigurePage({
  agent,
  agentId,
  orgId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
  updatePermissions,
}: {
  agent: AgentDetailRecord;
  agentId: string;
  orgId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
  updatePermissions: { mutate: (permissions: AgentPermissionUpdate) => void; isPending: boolean };
}) {
  const queryClient = useQueryClient();
  const [revisionsOpen, setRevisionsOpen] = useState(false);

  const { data: configRevisions } = useQuery({
    queryKey: queryKeys.agents.configRevisions(agent.id),
    queryFn: () => agentsApi.listConfigRevisions(agent.id, orgId),
  });

  const rollbackConfig = useMutation({
    mutationFn: (revisionId: string) => agentsApi.rollbackConfigRevision(agent.id, revisionId, orgId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
    },
  });

  return (
    <div className="max-w-3xl space-y-6">
      <ConfigurationTab
        agent={agent}
        onDirtyChange={onDirtyChange}
        onSaveActionChange={onSaveActionChange}
        onCancelActionChange={onCancelActionChange}
        onSavingChange={onSavingChange}
        updatePermissions={updatePermissions}
        orgId={orgId}
        hidePromptTemplate
        hideInstructionsFile
      />
      <div>
        <h3 className="text-sm font-medium mb-3">API Keys</h3>
        <KeysTab agentId={agentId} orgId={orgId} />
      </div>

      {/* Configuration Revisions — collapsible at the bottom */}
      <div>
        <button
          className="flex items-center gap-2 text-sm font-medium hover:text-foreground transition-colors"
          onClick={() => setRevisionsOpen((v) => !v)}
        >
          {revisionsOpen
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          }
          Configuration Revisions
          <span className="text-xs font-normal text-muted-foreground">{configRevisions?.length ?? 0}</span>
        </button>
        {revisionsOpen && (
          <div className="mt-3">
            {(configRevisions ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No configuration revisions yet.</p>
            ) : (
              <div className="space-y-2">
                {(configRevisions ?? []).slice(0, 10).map((revision) => (
                  <div key={revision.id} className="border border-border/70 rounded-md p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs text-muted-foreground">
                        <span className="font-mono">{revision.id.slice(0, 8)}</span>
                        <span className="mx-1">·</span>
                        <span>{formatDate(revision.createdAt)}</span>
                        <span className="mx-1">·</span>
                        <span>{revision.source}</span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        onClick={() => rollbackConfig.mutate(revision.id)}
                        disabled={rollbackConfig.isPending}
                      >
                        Restore
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Changed:{" "}
                      {revision.changedKeys.length > 0 ? revision.changedKeys.join(", ") : "no tracked changes"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Configuration Tab ---- */

function ConfigurationTab({
  agent,
  orgId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
  updatePermissions,
  hidePromptTemplate,
  hideInstructionsFile,
}: {
  agent: AgentDetailRecord;
  orgId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
  updatePermissions: { mutate: (permissions: AgentPermissionUpdate) => void; isPending: boolean };
  hidePromptTemplate?: boolean;
  hideInstructionsFile?: boolean;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [awaitingRefreshAfterSave, setAwaitingRefreshAfterSave] = useState(false);
  const lastAgentRef = useRef(agent);

  const { data: adapterModels } = useQuery({
    queryKey:
      orgId
        ? queryKeys.agents.adapterModels(orgId, agent.agentRuntimeType)
        : ["agents", "none", "adapter-models", agent.agentRuntimeType],
    queryFn: () => agentsApi.adapterModels(orgId!, agent.agentRuntimeType),
    enabled: Boolean(orgId),
  });

  const updateAgent = useMutation({
    mutationFn: (data: Record<string, unknown>) => agentsApi.update(agent.id, data, orgId),
    onMutate: () => {
      setAwaitingRefreshAfterSave(true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agent.orgId) });
    },
    onError: (err) => {
      setAwaitingRefreshAfterSave(false);
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not save agent";
      pushToast({ title: "Save failed", body: message, tone: "error" });
    },
  });

  useEffect(() => {
    if (awaitingRefreshAfterSave && agent !== lastAgentRef.current) {
      setAwaitingRefreshAfterSave(false);
    }
    lastAgentRef.current = agent;
  }, [agent, awaitingRefreshAfterSave]);
  const isConfigSaving = updateAgent.isPending || awaitingRefreshAfterSave;

  useEffect(() => {
    onSavingChange(isConfigSaving);
  }, [onSavingChange, isConfigSaving]);

  const canCreateAgents = Boolean(agent.permissions?.canCreateAgents);
  const canAssignTasks = Boolean(agent.access?.canAssignTasks);
  const taskAssignSource = agent.access?.taskAssignSource ?? "none";
  const taskAssignLocked = agent.role === "ceo" || canCreateAgents;
  const taskAssignHint =
    taskAssignSource === "ceo_role"
      ? "Enabled automatically for CEO agents."
      : taskAssignSource === "agent_creator"
        ? "Enabled automatically while this agent can create new agents."
        : taskAssignSource === "explicit_grant"
          ? "Enabled via explicit organization permission grant."
          : "Disabled unless explicitly granted.";

  return (
    <div className="space-y-6">
      <AgentConfigForm
        mode="edit"
        agent={agent}
        onSave={(patch) => updateAgent.mutate(patch)}
        isSaving={isConfigSaving}
        adapterModels={adapterModels}
        onDirtyChange={onDirtyChange}
        onSaveActionChange={onSaveActionChange}
        onCancelActionChange={onCancelActionChange}
        hideInlineSave
        hidePromptTemplate={hidePromptTemplate}
        hideInstructionsFile={hideInstructionsFile}
        sectionLayout="cards"
      />

      <div>
        <h3 className="text-sm font-medium mb-3">Permissions</h3>
        <div className="border border-border rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between gap-4 text-sm">
            <div className="space-y-1">
              <div>Can create new agents</div>
              <p className="text-xs text-muted-foreground">
                Lets this agent create or hire agents and implicitly assign tasks.
              </p>
            </div>
            <ToggleSwitch
              checked={canCreateAgents}
              size="sm"
              tone="success"
              aria-label="Can create new agents"
              className="shrink-0"
              onClick={() =>
                updatePermissions.mutate({
                  canCreateAgents: !canCreateAgents,
                  canAssignTasks: !canCreateAgents ? true : canAssignTasks,
                })
              }
              disabled={updatePermissions.isPending}
            />
          </div>
          <div className="flex items-center justify-between gap-4 text-sm">
            <div className="space-y-1">
              <div>Can assign tasks</div>
              <p className="text-xs text-muted-foreground">
                {taskAssignHint}
              </p>
            </div>
            <ToggleSwitch
              checked={canAssignTasks}
              size="sm"
              tone="success"
              aria-label="Can assign tasks"
              className="shrink-0"
              onClick={() =>
                updatePermissions.mutate({
                  canCreateAgents,
                  canAssignTasks: !canAssignTasks,
                })
              }
              disabled={updatePermissions.isPending || taskAssignLocked}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Prompts Tab ---- */

function PromptsTab({
  agent,
  orgId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
}: {
  agent: Agent;
  orgId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const { isMobile } = useSidebar();
  const [selectedFile, setSelectedFile] = useState<string>("AGENTS.md");
  const [showFilePanel, setShowFilePanel] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [bundleDraft, setBundleDraft] = useState<{
    mode: "managed" | "external";
    rootPath: string;
    entryFile: string;
  } | null>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<string[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [filePanelWidth, setFilePanelWidth] = useState(260);
  const containerRef = useRef<HTMLDivElement>(null);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const lastFileVersionRef = useRef<string | null>(null);
  const externalBundleRef = useRef<{
    rootPath: string;
    entryFile: string;
    selectedFile: string;
  } | null>(null);

  useEffect(() => {
    setSelectedFile("AGENTS.md");
    setShowFilePanel(false);
    setDraft(null);
    setBundleDraft(null);
    setNewFilePath("");
    setShowNewFileInput(false);
    setPendingFiles([]);
    setExpandedDirs(new Set());
    setAwaitingRefresh(false);
    lastFileVersionRef.current = null;
    externalBundleRef.current = null;
  }, [agent.id]);

  const isLocal =
    agent.agentRuntimeType === "claude_local" ||
    agent.agentRuntimeType === "codex_local" ||
    agent.agentRuntimeType === "opencode_local" ||
    agent.agentRuntimeType === "pi_local" ||
    agent.agentRuntimeType === "hermes_local" ||
    agent.agentRuntimeType === "cursor";

  const { data: bundle, isLoading: bundleLoading } = useQuery({
    queryKey: queryKeys.agents.instructionsBundle(agent.id),
    queryFn: () => agentsApi.instructionsBundle(agent.id, orgId),
    enabled: Boolean(orgId && isLocal),
  });

  const persistedMode = bundle?.mode ?? "managed";
  const persistedRootPath = persistedMode === "managed"
    ? (bundle?.managedRootPath ?? bundle?.rootPath ?? "")
    : (bundle?.rootPath ?? "");
  const currentMode = bundleDraft?.mode ?? persistedMode;
  const currentEntryFile = bundleDraft?.entryFile ?? bundle?.entryFile ?? "AGENTS.md";
  const currentRootPath = bundleDraft?.rootPath ?? persistedRootPath;
  const fileOptions = useMemo(
    () => bundle?.files.map((file) => file.path) ?? [],
    [bundle],
  );
  const bundleMatchesDraft = Boolean(
    bundle &&
    currentMode === persistedMode &&
    currentEntryFile === bundle.entryFile &&
    currentRootPath === persistedRootPath,
  );
  const visibleFilePaths = useMemo(
    () => bundleMatchesDraft
      ? [...new Set([currentEntryFile, ...fileOptions, ...pendingFiles])]
      : [currentEntryFile, ...pendingFiles],
    [bundleMatchesDraft, currentEntryFile, fileOptions, pendingFiles],
  );
  const fileTree = useMemo(
    () => buildFileTree(Object.fromEntries(visibleFilePaths.map((filePath) => [filePath, ""]))),
    [visibleFilePaths],
  );
  const selectedOrEntryFile = selectedFile || currentEntryFile;
  const selectedFileExists = bundleMatchesDraft && fileOptions.includes(selectedOrEntryFile);
  const selectedFileSummary = bundle?.files.find((file) => file.path === selectedOrEntryFile) ?? null;

  const { data: selectedFileDetail, isLoading: fileLoading } = useQuery({
    queryKey: queryKeys.agents.instructionsFile(agent.id, selectedOrEntryFile),
    queryFn: () => agentsApi.instructionsFile(agent.id, selectedOrEntryFile, orgId),
    enabled: Boolean(orgId && isLocal && selectedFileExists),
  });

  const updateBundle = useMutation({
    mutationFn: (data: {
      mode?: "managed" | "external";
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    }) => agentsApi.updateInstructionsBundle(agent.id, data, orgId),
    onMutate: () => setAwaitingRefresh(true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    },
    onError: () => setAwaitingRefresh(false),
  });

  const saveFile = useMutation({
    mutationFn: (data: { path: string; content: string; clearLegacyPromptTemplate?: boolean }) =>
      agentsApi.saveInstructionsFile(agent.id, data, orgId),
    onMutate: () => setAwaitingRefresh(true),
    onSuccess: (_, variables) => {
      setPendingFiles((prev) => prev.filter((f) => f !== variables.path));
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsFile(agent.id, variables.path) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    },
    onError: () => setAwaitingRefresh(false),
  });

  const deleteFile = useMutation({
    mutationFn: (relativePath: string) => agentsApi.deleteInstructionsFile(agent.id, relativePath, orgId),
    onMutate: () => setAwaitingRefresh(true),
    onSuccess: (_, relativePath) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agent.id) });
      queryClient.removeQueries({ queryKey: queryKeys.agents.instructionsFile(agent.id, relativePath) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    },
    onError: () => setAwaitingRefresh(false),
  });

  const uploadMarkdownImage = useMutation({
    mutationFn: async ({ file, namespace }: { file: File; namespace: string }) => {
      if (!selectedOrganizationId) throw new Error("Select a organization to upload images");
      return assetsApi.uploadImage(selectedOrganizationId, file, namespace);
    },
  });

  useEffect(() => {
    if (!bundle) return;
    if (!bundleMatchesDraft) {
      if (selectedFile !== currentEntryFile) setSelectedFile(currentEntryFile);
      return;
    }
    const availablePaths = bundle.files.map((file) => file.path);
    if (availablePaths.length === 0) {
      if (selectedFile !== bundle.entryFile) setSelectedFile(bundle.entryFile);
      return;
    }
    if (!availablePaths.includes(selectedFile) && selectedFile !== currentEntryFile && !pendingFiles.includes(selectedFile)) {
      setSelectedFile(availablePaths.includes(bundle.entryFile) ? bundle.entryFile : availablePaths[0]!);
    }
  }, [bundle, bundleMatchesDraft, currentEntryFile, pendingFiles, selectedFile]);

  useEffect(() => {
    const nextExpanded = new Set<string>();
    for (const filePath of visibleFilePaths) {
      const parts = filePath.split("/");
      let currentPath = "";
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i]!;
        nextExpanded.add(currentPath);
      }
    }
    setExpandedDirs((current) => (setsEqual(current, nextExpanded) ? current : nextExpanded));
  }, [visibleFilePaths]);

  useEffect(() => {
    const versionKey = selectedFileExists && selectedFileDetail
      ? `${selectedFileDetail.path}:${selectedFileDetail.content}`
      : `draft:${currentMode}:${currentRootPath}:${selectedOrEntryFile}`;
    if (awaitingRefresh) {
      setAwaitingRefresh(false);
      setBundleDraft(null);
      setDraft(null);
      lastFileVersionRef.current = versionKey;
      return;
    }
    if (lastFileVersionRef.current !== versionKey) {
      setDraft(null);
      lastFileVersionRef.current = versionKey;
    }
  }, [awaitingRefresh, currentMode, currentRootPath, selectedFileDetail, selectedFileExists, selectedOrEntryFile]);

  useEffect(() => {
    if (!bundle) return;
    setBundleDraft((current) => {
      if (current) return current;
      return {
        mode: persistedMode,
        rootPath: persistedRootPath,
        entryFile: bundle.entryFile,
      };
    });
  }, [bundle, persistedMode, persistedRootPath]);

  useEffect(() => {
    if (!bundle || currentMode !== "external") return;
    externalBundleRef.current = {
      rootPath: currentRootPath,
      entryFile: currentEntryFile,
      selectedFile: selectedOrEntryFile,
    };
  }, [bundle, currentEntryFile, currentMode, currentRootPath, selectedOrEntryFile]);

  const currentContent = selectedFileExists ? (selectedFileDetail?.content ?? "") : "";
  const displayValue = draft ?? currentContent;
  const bundleDirty = Boolean(
    bundleDraft &&
      (
        bundleDraft.mode !== persistedMode ||
        bundleDraft.rootPath !== persistedRootPath ||
        bundleDraft.entryFile !== (bundle?.entryFile ?? "AGENTS.md")
      ),
  );
  const fileDirty = draft !== null && draft !== currentContent;
  const isDirty = bundleDirty || fileDirty;
  const isSaving = updateBundle.isPending || saveFile.isPending || deleteFile.isPending || awaitingRefresh;

  useEffect(() => { onSavingChange(isSaving); }, [onSavingChange, isSaving]);
  useEffect(() => { onDirtyChange(isDirty); }, [onDirtyChange, isDirty]);

  useEffect(() => {
    onSaveActionChange(isDirty ? () => {
      const save = async () => {
        const shouldClearLegacy =
          Boolean(bundle?.legacyPromptTemplateActive) || Boolean(bundle?.legacyBootstrapPromptTemplateActive);
        if (bundleDirty && bundleDraft) {
          await updateBundle.mutateAsync({
            mode: bundleDraft.mode,
            rootPath: bundleDraft.mode === "external" ? bundleDraft.rootPath : null,
            entryFile: bundleDraft.entryFile,
          });
        }
        if (fileDirty) {
          await saveFile.mutateAsync({
            path: selectedOrEntryFile,
            content: displayValue,
            clearLegacyPromptTemplate: shouldClearLegacy,
          });
        }
      };
      void save().catch(() => undefined);
    } : null);
  }, [
    bundle,
    bundleDirty,
    bundleDraft,
    displayValue,
    fileDirty,
    isDirty,
    onSaveActionChange,
    saveFile,
    selectedOrEntryFile,
    updateBundle,
  ]);

  useEffect(() => {
    onCancelActionChange(isDirty ? () => {
      setDraft(null);
      if (bundle) {
        setBundleDraft({
          mode: persistedMode,
          rootPath: persistedRootPath,
          entryFile: bundle.entryFile,
        });
      }
    } : null);
  }, [bundle, isDirty, onCancelActionChange, persistedMode, persistedRootPath]);

  const handleSeparatorDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = filePanelWidth;
    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const next = Math.max(180, Math.min(500, startWidth + delta));
      setFilePanelWidth(next);
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [filePanelWidth]);

  if (!isLocal) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-muted-foreground">
          Instructions bundles are only available for local adapters.
        </p>
      </div>
    );
  }

  if (bundleLoading && !bundle) {
    return <PromptsTabSkeleton />;
  }

  return (
    <div className="max-w-6xl space-y-6">
      {(bundle?.warnings ?? []).length > 0 && (
        <div className="space-y-2">
          {(bundle?.warnings ?? []).map((warning) => (
            <div
              key={warning}
              className={cn("rounded-md border px-3 py-2 text-xs", semanticNoticeToneClasses.info)}
            >
              {warning}
            </div>
          ))}
        </div>
      )}

      <Collapsible defaultOpen={currentMode === "external"}>
        <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors group">
          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4 pb-6">
          <TooltipProvider>
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-[auto_1fr_1fr]">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Mode
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={4}>
                      Managed: Rudder stores and serves the instructions bundle. External: you provide a path on disk where the instructions live.
                    </TooltipContent>
                  </Tooltip>
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={currentMode === "managed" ? "default" : "outline"}
                    onClick={() => {
                      if (currentMode === "external") {
                        externalBundleRef.current = {
                          rootPath: currentRootPath,
                          entryFile: currentEntryFile,
                          selectedFile: selectedOrEntryFile,
                        };
                      }
                      const nextEntryFile = currentEntryFile || "AGENTS.md";
                      setBundleDraft({
                        mode: "managed",
                        rootPath: bundle?.managedRootPath ?? currentRootPath,
                        entryFile: nextEntryFile,
                      });
                      setSelectedFile(nextEntryFile);
                    }}
                  >
                    Managed
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={currentMode === "external" ? "default" : "outline"}
                    onClick={() => {
                      const externalBundle = externalBundleRef.current;
                      const nextEntryFile = externalBundle?.entryFile ?? currentEntryFile ?? "AGENTS.md";
                      setBundleDraft({
                        mode: "external",
                        rootPath: externalBundle?.rootPath ?? (bundle?.mode === "external" ? (bundle.rootPath ?? "") : ""),
                        entryFile: nextEntryFile,
                      });
                      setSelectedFile(externalBundle?.selectedFile ?? nextEntryFile);
                    }}
                  >
                    External
                  </Button>
                </div>
              </label>
              <label className="space-y-1.5 min-w-0">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Root path
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={4}>
                      The absolute directory on disk where the instructions bundle lives. In managed mode this is set by Rudder automatically.
                    </TooltipContent>
                  </Tooltip>
                </span>
                {currentMode === "managed" ? (
                  <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground pt-1.5">
                    <span className="min-w-0 truncate" title={currentRootPath || undefined}>{currentRootPath || "(managed)"}</span>
                    {currentRootPath && (
                      <CopyText text={currentRootPath} className="shrink-0">
                        <Copy className="h-3.5 w-3.5" />
                      </CopyText>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={currentRootPath}
                      onChange={(event) => {
                        const nextRootPath = event.target.value;
                        externalBundleRef.current = {
                          rootPath: nextRootPath,
                          entryFile: currentEntryFile,
                          selectedFile: selectedOrEntryFile,
                        };
                        setBundleDraft({
                          mode: "external",
                          rootPath: nextRootPath,
                          entryFile: currentEntryFile,
                        });
                      }}
                      className="font-mono text-sm"
                      placeholder="/absolute/path/to/agent/prompts"
                    />
                    {currentRootPath && (
                      <CopyText text={currentRootPath} className="shrink-0">
                        <Copy className="h-3.5 w-3.5" />
                      </CopyText>
                    )}
                  </div>
                )}
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  Entry file
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={4}>
                      The main file the agent reads first when loading instructions. Defaults to AGENTS.md.
                    </TooltipContent>
                  </Tooltip>
                </span>
                <Input
                  value={currentEntryFile}
                  onChange={(event) => {
                    const nextEntryFile = event.target.value || "AGENTS.md";
                    const nextSelectedFile = selectedOrEntryFile === currentEntryFile
                      ? nextEntryFile
                      : selectedOrEntryFile;
                    if (currentMode === "external") {
                      externalBundleRef.current = {
                        rootPath: currentRootPath,
                        entryFile: nextEntryFile,
                        selectedFile: nextSelectedFile,
                      };
                    }
                    if (selectedOrEntryFile === currentEntryFile) setSelectedFile(nextEntryFile);
                    setBundleDraft({
                      mode: currentMode,
                      rootPath: currentRootPath,
                      entryFile: nextEntryFile,
                    });
                  }}
                  className="font-mono text-sm"
                />
              </label>
            </div>
          </TooltipProvider>
        </CollapsibleContent>
      </Collapsible>

      <div ref={containerRef} className={cn("flex gap-0", isMobile && "flex-col gap-3")}>
        <div className={cn(
          "border border-border rounded-lg p-3 space-y-3 shrink-0",
          isMobile && showFilePanel && "block",
          isMobile && !showFilePanel && "hidden",
        )} style={isMobile ? undefined : { width: filePanelWidth }}>
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Files</h4>
            <div className="flex items-center gap-1">
              {!showNewFileInput && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  onClick={() => setShowNewFileInput(true)}
                >
                  +
                </Button>
              )}
              {isMobile && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => setShowFilePanel(false)}
                >
                  ✕
                </Button>
              )}
            </div>
          </div>
          {showNewFileInput && (
            <div className="space-y-2">
              <Input
                value={newFilePath}
                onChange={(event) => setNewFilePath(event.target.value)}
                placeholder="TOOLS.md"
                className="font-mono text-sm"
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setShowNewFileInput(false);
                    setNewFilePath("");
                  }
                }}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  className="flex-1"
                  disabled={!newFilePath.trim() || newFilePath.includes("..")}
                  onClick={() => {
                    const candidate = newFilePath.trim();
                    if (!candidate || candidate.includes("..")) return;
                    setPendingFiles((prev) => prev.includes(candidate) ? prev : [...prev, candidate]);
                    setSelectedFile(candidate);
                    setDraft("");
                    setNewFilePath("");
                    setShowNewFileInput(false);
                  }}
                >
                  Create
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setShowNewFileInput(false);
                    setNewFilePath("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <PackageFileTree
            nodes={fileTree}
            selectedFile={selectedOrEntryFile}
            expandedDirs={expandedDirs}
            checkedFiles={new Set()}
            onToggleDir={(dirPath) => setExpandedDirs((current) => {
              const next = new Set(current);
              if (next.has(dirPath)) next.delete(dirPath);
              else next.add(dirPath);
              return next;
            })}
            onSelectFile={(filePath) => {
              setSelectedFile(filePath);
              if (!fileOptions.includes(filePath)) setDraft("");
              if (isMobile) setShowFilePanel(false);
            }}
            onToggleCheck={() => {}}
            showCheckboxes={false}
            renderFileExtra={(node) => {
              const file = bundle?.files.find((entry) => entry.path === node.path);
              if (!file) return null;
              if (file.deprecated) {
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          "ml-3 shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide cursor-help",
                          semanticBadgeToneClasses.warn,
                        )}
                      >
                        virtual file
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={4}>
                      Legacy inline prompt — this deprecated virtual file preserves the old promptTemplate content
                    </TooltipContent>
                  </Tooltip>
                );
              }
              return (
                <span className="ml-3 shrink-0 rounded border border-border text-muted-foreground px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {file.isEntryFile ? "entry" : `${file.size}b`}
                </span>
              );
            }}
          />
        </div>

        {/* Draggable separator */}
        {!isMobile && (
          <div
            className="w-1 shrink-0 cursor-col-resize hover:bg-border active:bg-primary/50 rounded transition-colors mx-1"
            onMouseDown={handleSeparatorDrag}
          />
        )}

        <div className={cn("border border-border rounded-lg p-4 space-y-3 min-w-0 flex-1", isMobile && showFilePanel && "hidden")}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {isMobile && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7 shrink-0"
                  onClick={() => setShowFilePanel(true)}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              )}
              <div className="min-w-0">
                <h4 className="text-sm font-medium font-mono truncate">{selectedOrEntryFile}</h4>
                <p className="text-xs text-muted-foreground">
                  {selectedFileExists
                    ? selectedFileSummary?.deprecated
                      ? "Deprecated virtual file"
                      : `${selectedFileDetail?.language ?? "text"} file`
                    : "New file in this bundle"}
                </p>
              </div>
            </div>
            {selectedFileExists && !selectedFileSummary?.deprecated && selectedOrEntryFile !== currentEntryFile && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (confirm(`Delete ${selectedOrEntryFile}?`)) {
                    deleteFile.mutate(selectedOrEntryFile, {
                      onSuccess: () => {
                        setSelectedFile(currentEntryFile);
                        setDraft(null);
                      },
                    });
                  }
                }}
                disabled={deleteFile.isPending}
              >
                Delete
              </Button>
            )}
          </div>

          {selectedFileExists && fileLoading && !selectedFileDetail ? (
            <PromptEditorSkeleton />
          ) : isMarkdown(selectedOrEntryFile) ? (
            <MarkdownEditor
              key={selectedOrEntryFile}
              value={displayValue}
              onChange={(value) => setDraft(value ?? "")}
              placeholder="# Agent instructions"
              contentClassName="min-h-[420px] text-sm font-mono"
              imageUploadHandler={async (file) => {
                const namespace = `agents/${agent.id}/instructions/${selectedOrEntryFile.replaceAll("/", "-")}`;
                const asset = await uploadMarkdownImage.mutateAsync({ file, namespace });
                return asset.contentPath;
              }}
            />
          ) : (
            <textarea
              value={displayValue}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[420px] w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-sm outline-none"
              placeholder="File contents"
            />
          )}
        </div>
      </div>

    </div>
  );
}

function PromptsTabSkeleton() {
  return (
    <div className="max-w-5xl space-y-4">
      <div className="rounded-lg border border-border p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-[30rem] max-w-full" />
          </div>
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="rounded-lg border border-border p-3 space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-8 w-16" />
          </div>
          <Skeleton className="h-10 w-full" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full rounded-none" />
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-28" />
          </div>
          <PromptEditorSkeleton />
        </div>
      </div>
    </div>
  );
}

function PromptEditorSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}

function AgentSkillsTab({
  agent,
  orgId,
}: {
  agent: Agent;
  orgId?: string;
}) {
  type SkillRow = {
    id: string;
    selectionKey: string;
    key: string;
    name: string;
    description: string | null;
    detail: string | null;
    locationLabel: string | null;
    badgeLabel: string | null;
    metadataTokens: string[];
    linkTo: string | null;
    workspaceEditPath: string | null;
    alwaysEnabled: boolean;
    configurable: boolean;
    entry: AgentSkillEntry;
  };

  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [skillDraft, setSkillDraft] = useState<string[]>([]);
  const [lastSavedSkills, setLastSavedSkills] = useState<string[]>([]);
  const [skillFilter, setSkillFilter] = useState("");
  const [externalSectionOpen, setExternalSectionOpen] = useState(false);
  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const skillDraftRef = useRef<string[]>([]);
  const lastSavedSkillsRef = useRef<string[]>([]);
  const hasHydratedSkillSnapshotRef = useRef(false);
  const initialDesiredSkillKeysRef = useRef<string[] | null>(null);
  const initialDesiredSkillKeysAgentIdRef = useRef<string | null>(null);

  const { data: skillSnapshot, isLoading } = useQuery({
    queryKey: queryKeys.agents.skills(agent.id),
    queryFn: () => agentsApi.skills(agent.id, orgId),
    enabled: Boolean(orgId),
  });

  const { data: organizationSkills, isLoading: organizationSkillsLoading } = useQuery({
    queryKey: queryKeys.organizationSkills.list(orgId ?? ""),
    queryFn: () => organizationSkillsApi.list(orgId!),
    enabled: Boolean(orgId),
  });

  if (initialDesiredSkillKeysAgentIdRef.current !== agent.id) {
    initialDesiredSkillKeysAgentIdRef.current = agent.id;
    initialDesiredSkillKeysRef.current = null;
  }
  // Freeze the pinned order for this visit so toggling a skill does not reshuffle the list in-place.
  if (initialDesiredSkillKeysRef.current === null && skillSnapshot) {
    initialDesiredSkillKeysRef.current = sortUnique(skillSnapshot.desiredSkills);
  }

  const syncSkills = useMutation({
    mutationFn: (desiredSkills: string[]) => agentsApi.syncSkills(agent.id, desiredSkills, orgId),
    onSuccess: async (snapshot) => {
      queryClient.setQueryData(queryKeys.agents.skills(agent.id), snapshot);
      lastSavedSkillsRef.current = snapshot.desiredSkills;
      setLastSavedSkills(snapshot.desiredSkills);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) }),
      ]);
    },
  });

  const createPrivateSkill = useMutation({
    mutationFn: (payload: OrganizationSkillCreateRequest) =>
      agentsApi.createPrivateSkill(agent.id, payload, orgId),
    onSuccess: async (entry) => {
      setCreateSkillOpen(false);
      setSkillFilter("");
      pushToast({
        title: `Created ${entry.key}`,
        body: "Enable it from the Agent skills section when you want Rudder to load it.",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.skills(agent.id) });
    },
  });

  useEffect(() => {
    setSkillDraft([]);
    skillDraftRef.current = [];
    setLastSavedSkills([]);
    setSkillFilter("");
    setExternalSectionOpen(false);
    lastSavedSkillsRef.current = [];
    hasHydratedSkillSnapshotRef.current = false;
  }, [agent.id]);

  useEffect(() => {
    skillDraftRef.current = skillDraft;
  }, [skillDraft]);

  useEffect(() => {
    if (!skillSnapshot) return;
    const normalizedDesiredSkills = sortUnique(skillSnapshot.desiredSkills);
    const currentDraft = skillDraftRef.current;
    const previousLastSaved = lastSavedSkillsRef.current;
    const shouldReplaceDraft = !hasHydratedSkillSnapshotRef.current
      || arraysEqual(currentDraft, previousLastSaved);

    hasHydratedSkillSnapshotRef.current = true;
    lastSavedSkillsRef.current = normalizedDesiredSkills;
    setLastSavedSkills((current) => (
      arraysEqual(current, normalizedDesiredSkills) ? current : normalizedDesiredSkills
    ));

    if (!shouldReplaceDraft) return;

    skillDraftRef.current = normalizedDesiredSkills;
    setSkillDraft((current) => (
      arraysEqual(current, normalizedDesiredSkills) ? current : normalizedDesiredSkills
    ));
  }, [skillSnapshot]);

  const snapshotEntries = skillSnapshot?.entries ?? [];
  const entryBySelectionKey = useMemo(
    () => new Map(snapshotEntries.map((entry) => [entry.selectionKey, entry])),
    [snapshotEntries],
  );

  const getOrganizationSelectionKey = useCallback((skillKey: string) => (
    getBundledRudderSkillSlug(skillKey) ? `bundled:${skillKey}` : `org:${skillKey}`
  ), []);

  const getOrganizationBadgeLabel = useCallback((sourceBadge: string | null | undefined, alwaysEnabled: boolean) => {
    if (alwaysEnabled) return "Bundled by Rudder";
    switch (sourceBadge) {
      case "community":
        return "Community preset";
      case "github":
        return "GitHub";
      case "local":
        return "Local";
      case "url":
        return "URL";
      case "skills_sh":
        return "skills.sh";
      case "catalog":
        return "Catalog";
      case "rudder":
        return "Rudder workspace";
      default:
        return null;
    }
  }, []);

  const buildFallbackOrganizationEntry = useCallback((skill: {
    key: string;
    slug: string;
    description?: string | null;
  }): AgentSkillEntry => {
    const alwaysEnabled = getBundledRudderSkillSlug(skill.key) !== null;
    return {
      key: skill.slug,
      selectionKey: getOrganizationSelectionKey(skill.key),
      runtimeName: skill.slug,
      description: skill.description ?? null,
      desired: alwaysEnabled,
      configurable: !alwaysEnabled,
      alwaysEnabled,
      managed: true,
      state: alwaysEnabled ? "configured" : "available",
      sourceClass: alwaysEnabled ? "bundled" : "organization",
    };
  }, [getOrganizationSelectionKey]);

  const organizationSkillRows = useMemo<SkillRow[]>(
    () =>
      (organizationSkills ?? [])
        .map((skill) => {
          const entry = entryBySelectionKey.get(getOrganizationSelectionKey(skill.key))
            ?? buildFallbackOrganizationEntry(skill);
          const badgeLabel = getOrganizationBadgeLabel(skill.sourceBadge, entry.alwaysEnabled);
          return {
            id: entry.selectionKey,
            selectionKey: entry.selectionKey,
            key: entry.key,
            name: skill.name,
            description: compactSkillText(skill.description ?? entry.description ?? null),
            detail: compactSkillText(entry.detail ?? null),
            locationLabel: entry.locationLabel ?? null,
            badgeLabel,
            metadataTokens: [skill.sourceLabel]
              .filter((value): value is string => Boolean(value))
              .filter((value) => value !== badgeLabel),
            linkTo: `/skills/${skill.id}`,
            workspaceEditPath: skill.workspaceEditPath,
            alwaysEnabled: entry.alwaysEnabled,
            configurable: canManageSkillEntry(entry),
            entry,
          };
        })
        .sort((left, right) => {
          if (left.alwaysEnabled !== right.alwaysEnabled) return left.alwaysEnabled ? -1 : 1;
          return left.name.localeCompare(right.name) || left.selectionKey.localeCompare(right.selectionKey);
        }),
    [buildFallbackOrganizationEntry, entryBySelectionKey, getOrganizationBadgeLabel, getOrganizationSelectionKey, organizationSkills],
  );

  const discoveredSkillRows = useMemo<SkillRow[]>(
    () =>
      snapshotEntries
        .filter((entry) => isExternalSkillEntry(entry))
        .filter((entry) => !shouldHideExternalSkillEntry(entry))
        .map((entry) => ({
          id: entry.selectionKey,
          selectionKey: entry.selectionKey,
          key: entry.key,
          name: entry.runtimeName ?? entry.key,
          description: compactSkillText(entry.description ?? null),
          detail: compactSkillText(
            entry.detail
              ?? (entry.sourceClass === "agent_home"
                ? "Discovered in AGENT_HOME/skills. Enable it here to load it for this agent."
                : entry.sourceClass === "global"
                  ? "Discovered in ~/.agents/skills. Enable it here to load it for this agent."
                  : "Discovered in the current runtime adapter home. Enable it here to load it for this agent."),
          ),
          locationLabel: entry.locationLabel ?? null,
          badgeLabel: entry.sourceClass === "agent_home"
            ? "Agent skill"
            : entry.sourceClass === "global"
              ? "Global skill"
              : "Adapter skill",
          metadataTokens: [entry.locationLabel].filter((value): value is string => Boolean(value)),
          linkTo: null,
          workspaceEditPath: entry.workspaceEditPath ?? null,
          alwaysEnabled: entry.alwaysEnabled,
          configurable: canManageSkillEntry(entry),
          entry,
        }))
        .sort((left, right) => left.name.localeCompare(right.name) || left.selectionKey.localeCompare(right.selectionKey)),
    [snapshotEntries],
  );

  const pinnedAgentSkillSelectionKeys = useMemo(
    () => new Set(initialDesiredSkillKeysRef.current ?? []),
    [agent.id, skillSnapshot],
  );

  const agentSkillRows = useMemo(
    () => sortSkillRowsByPinnedSelectionKey(
      discoveredSkillRows.filter((skill) => skill.entry.sourceClass === "agent_home"),
      pinnedAgentSkillSelectionKeys,
    ),
    [discoveredSkillRows, pinnedAgentSkillSelectionKeys],
  );

  const externalSkillRows = useMemo(
    () => discoveredSkillRows.filter((skill) => skill.entry.sourceClass !== "agent_home"),
    [discoveredSkillRows],
  );

  const globalSkillRows = useMemo(
    () => externalSkillRows.filter((skill) => skill.entry.sourceClass === "global"),
    [externalSkillRows],
  );

  const adapterSkillRows = useMemo(
    () => externalSkillRows.filter((skill) => skill.entry.sourceClass === "adapter_home"),
    [externalSkillRows],
  );

  const filteredOrganizationSkillRows = useMemo(() => {
    const normalizedFilter = skillFilter.trim().toLowerCase();
    return organizationSkillRows.filter((skill) => {
      if (!normalizedFilter) return true;
      const haystack = [
        skill.name,
        skill.key,
        skill.description ?? "",
        skill.detail ?? "",
        ...skill.metadataTokens,
      ].join(" ").toLowerCase();
      return haystack.includes(normalizedFilter);
    });
  }, [organizationSkillRows, skillFilter]);

  const filterSkillRows = useCallback((rows: SkillRow[]) => {
    const normalizedFilter = skillFilter.trim().toLowerCase();
    return rows.filter((skill) => {
      if (!normalizedFilter) return true;
      const haystack = [
        skill.name,
        skill.key,
        skill.description ?? "",
        skill.detail ?? "",
        ...skill.metadataTokens,
      ].join(" ").toLowerCase();
      return haystack.includes(normalizedFilter);
    });
  }, [skillFilter]);

  const filteredGlobalSkillRows = useMemo(
    () => filterSkillRows(globalSkillRows),
    [filterSkillRows, globalSkillRows],
  );

  const filteredAgentSkillRows = useMemo(
    () => filterSkillRows(agentSkillRows),
    [agentSkillRows, filterSkillRows],
  );

  const filteredAdapterSkillRows = useMemo(
    () => filterSkillRows(adapterSkillRows),
    [adapterSkillRows, filterSkillRows],
  );

  const visibleManageableSkillKeys = useMemo(
    () => [
      ...filteredOrganizationSkillRows.filter((skill) => !skill.alwaysEnabled).map((skill) => skill.selectionKey),
      ...filteredAgentSkillRows
        .filter((skill) => skill.configurable)
        .map((skill) => skill.selectionKey),
      ...(externalSectionOpen
        ? [...filteredGlobalSkillRows, ...filteredAdapterSkillRows]
            .filter((skill) => skill.configurable)
            .map((skill) => skill.selectionKey)
        : []),
    ],
    [externalSectionOpen, filteredAdapterSkillRows, filteredAgentSkillRows, filteredGlobalSkillRows, filteredOrganizationSkillRows],
  );

  const availableSkillKeys = useMemo(
    () => new Set(snapshotEntries.map((entry) => entry.selectionKey)),
    [snapshotEntries],
  );

  const unavailableEnabledSkills = useMemo(
    () => skillDraft.filter((selectionKey) => !availableSkillKeys.has(selectionKey)),
    [availableSkillKeys, skillDraft],
  );

  const unsupportedSkillMessage = useMemo(() => {
    if (skillSnapshot?.mode !== "unsupported") return null;
    if (agent.agentRuntimeType === "openclaw_gateway") {
      return "Rudder cannot manage OpenClaw skills here. Visit your OpenClaw instance to manage this agent's skills.";
    }
    return "Rudder cannot manage skills for this runtime yet. Manage them in the runtime directly.";
  }, [agent.agentRuntimeType, skillSnapshot?.mode]);

  const hasEnabledExternalSkill = useMemo(
    () => externalSkillRows.some((skill) => skillDraft.includes(skill.selectionKey)),
    [externalSkillRows, skillDraft],
  );

  const isSkillsLoading = isLoading || organizationSkillsLoading;
  const saveStatusLabel = syncSkills.isPending ? "Saving..." : null;

  const controlsHelperText = "Rudder always loads the bundled Rudder skills. Agent, organization, global, and adapter skills load only when enabled on this page.";
  const agentSectionHelperText = "Agent-private skills belong to this agent only. Edit them in Workspaces, then enable them here when you want Rudder to load them.";
  const organizationSectionHelperText = "Bundled Rudder skills are locked on. Community presets and other organization skills stay optional; workspace-backed skills can be edited from Workspaces.";
  const externalSectionHelperText = "Global and adapter skills are discovered from ~/.agents/skills and the current runtime adapter home. Discovery does not enable them; only the selections on this page determine runtime loading.";

  const updateSkillDraft = useCallback((updater: (current: string[]) => string[]) => {
    const current = skillDraftRef.current;
    const next = sortUnique(updater(current));
    if (arraysEqual(current, next)) return;
    skillDraftRef.current = next;
    setSkillDraft(next);
    if (!arraysEqual(next, lastSavedSkillsRef.current)) {
      syncSkills.mutate(next);
    }
  }, [syncSkills]);

  const setSkillRowEnabledState = useCallback((row: SkillRow, enabled: boolean) => {
    updateSkillDraft((current) => toggleSkillSelection(current, row.entry, enabled, snapshotEntries));
  }, [snapshotEntries, updateSkillDraft]);

  const setSkillEnabledState = useCallback((rows: SkillRow[], enabled: boolean) => {
    if (rows.length === 0) return;
    updateSkillDraft((current) =>
      rows.reduce(
        (draft, row) => toggleSkillSelection(draft, row.entry, enabled, snapshotEntries),
        current,
      ),
    );
  }, [snapshotEntries, updateSkillDraft]);

  const enableVisibleSkills = useCallback(() => {
    const visibleRows = [
      ...filteredOrganizationSkillRows.filter((skill) => !skill.alwaysEnabled),
      ...filteredAgentSkillRows,
      ...(externalSectionOpen ? [...filteredGlobalSkillRows, ...filteredAdapterSkillRows] : []),
    ];
    setSkillEnabledState(visibleRows, true);
  }, [externalSectionOpen, filteredAdapterSkillRows, filteredAgentSkillRows, filteredGlobalSkillRows, filteredOrganizationSkillRows, setSkillEnabledState]);

  const disableVisibleSkills = useCallback(() => {
    const visibleRows = [
      ...filteredOrganizationSkillRows.filter((skill) => !skill.alwaysEnabled),
      ...filteredAgentSkillRows,
      ...(externalSectionOpen ? [...filteredGlobalSkillRows, ...filteredAdapterSkillRows] : []),
    ];
    setSkillEnabledState(visibleRows, false);
  }, [externalSectionOpen, filteredAdapterSkillRows, filteredAgentSkillRows, filteredGlobalSkillRows, filteredOrganizationSkillRows, setSkillEnabledState]);

  useEffect(() => {
    if (hasEnabledExternalSkill) {
      setExternalSectionOpen(true);
      return;
    }
    if (
      skillFilter.trim().length > 0
      && filteredOrganizationSkillRows.length === 0
      && filteredAgentSkillRows.length === 0
      && (filteredGlobalSkillRows.length > 0 || filteredAdapterSkillRows.length > 0)
    ) {
      setExternalSectionOpen(true);
    }
  }, [filteredAdapterSkillRows.length, filteredAgentSkillRows.length, filteredGlobalSkillRows.length, filteredOrganizationSkillRows.length, hasEnabledExternalSkill, skillFilter]);

  const renderSkillCard = useCallback((skill: SkillRow) => {
    const enabled = skill.alwaysEnabled || skillDraft.includes(skill.selectionKey);
    const switchDisabled = skill.alwaysEnabled || !skill.configurable || Boolean(unsupportedSkillMessage && !skill.alwaysEnabled);
    const workspaceEditHref = skill.workspaceEditPath
      ? `/workspaces?path=${encodeURIComponent(skill.workspaceEditPath)}`
      : null;
    const summary = resolveSkillSummaryText(
      skill.description,
      isGenericSkillRuntimeDetail(skill.detail) ? null : skill.detail,
    );
    const detailText = skill.detail
      && skill.detail !== skill.description
      && !isGenericSkillRuntimeDetail(skill.detail)
      ? skill.detail
      : null;
    const metadataTokens = [
      isGenericSkillLocationLabel(skill.locationLabel) ? null : skill.locationLabel,
      ...skill.metadataTokens,
    ].filter((value): value is string => Boolean(value))
      .filter((value) => value !== skill.badgeLabel && value !== "Bundled by Rudder");

    return (
      <div
        key={skill.id}
        className={cn(
          "flex h-full flex-col gap-2.5 rounded-lg border p-3 transition-colors",
          skill.alwaysEnabled
            ? "border-sky-200 bg-sky-50/50 dark:border-sky-500/30 dark:bg-sky-950/15"
            : enabled
              ? "border-border bg-background"
              : "border-border/70 bg-muted/35 text-muted-foreground",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {skill.linkTo ? (
                <Link
                  to={skill.linkTo}
                  className={cn(
                    "truncate text-sm font-semibold no-underline transition-colors hover:text-foreground",
                    skill.alwaysEnabled || enabled ? "text-foreground" : "text-foreground/80",
                  )}
                >
                  {skill.name}
                </Link>
              ) : (
                <span className={cn("truncate text-sm font-semibold", skill.alwaysEnabled || enabled ? "text-foreground" : "text-foreground/80")}>
                  {skill.name}
                </span>
              )}
              {skill.badgeLabel ? (
                <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {skill.badgeLabel}
                </span>
              ) : null}
            </div>
          </div>
          <SkillSwitch
            checked={enabled}
            disabled={switchDisabled}
            label={skill.name}
            onCheckedChange={(nextChecked) => setSkillRowEnabledState(skill, nextChecked)}
          />
        </div>

        <p className={cn("line-clamp-2 text-xs leading-[1.15rem]", skill.alwaysEnabled || enabled ? "text-muted-foreground" : "text-muted-foreground/90")}>
          {summary}
        </p>

        {detailText ? (
          <p className="line-clamp-2 text-[11px] leading-[1.05rem] text-muted-foreground/90">
            {detailText}
          </p>
        ) : null}

        {metadataTokens.length > 0 || workspaceEditHref ? (
          <div className="mt-auto space-y-2">
            {metadataTokens.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                {metadataTokens.map((token) => (
                  <span
                    key={`${skill.id}:${token}`}
                    className="max-w-full truncate rounded-md border border-border bg-muted/20 px-1.5 py-0.5"
                    title={token}
                  >
                    {token}
                  </span>
                ))}
              </div>
            ) : null}
            {workspaceEditHref ? (
              <div className="flex items-center gap-2">
                <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
                  <Link to={workspaceEditHref}>
                    <FolderOpen className="h-3.5 w-3.5" />
                    <span>Edit in workspaces</span>
                  </Link>
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }, [setSkillRowEnabledState, skillDraft, unsupportedSkillMessage]);

  return (
    <div className="max-w-6xl space-y-3">
      <section className="space-y-3">
        <div className="space-y-1">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Skills</p>
            <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
              {controlsHelperText}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[16rem] max-w-md flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={skillFilter}
              onChange={(event) => setSkillFilter(event.target.value)}
              placeholder="Search skills"
              aria-label="Search skills"
              className="h-9 pl-9"
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setCreateSkillOpen(true)}
              disabled={skillSnapshot?.mode === "unsupported" || createPrivateSkill.isPending}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Create agent skill</span>
            </Button>
            {saveStatusLabel ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {syncSkills.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>{saveStatusLabel}</span>
              </div>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More skill actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="surface-overlay text-foreground">
                <DropdownMenuItem
                  onClick={enableVisibleSkills}
                  disabled={visibleManageableSkillKeys.length === 0 || skillSnapshot?.mode === "unsupported"}
                >
                  Enable visible
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={disableVisibleSkills}
                  disabled={visibleManageableSkillKeys.length === 0 || skillSnapshot?.mode === "unsupported"}
                >
                  Disable visible
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </section>

      {skillSnapshot?.warnings.length ? (
        <div className="space-y-1 rounded-xl border border-amber-300/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
          {skillSnapshot.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}

      {unsupportedSkillMessage ? (
        <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
          {unsupportedSkillMessage}
        </div>
      ) : null}

      {isSkillsLoading ? (
        <PageSkeleton variant="list" />
      ) : (
        <>
          {organizationSkillRows.length === 0 && agentSkillRows.length === 0 && externalSkillRows.length === 0 ? (
            <section className="rounded-xl border border-border bg-[color:var(--surface-elevated)]">
              <div className="px-4 py-6 text-sm text-muted-foreground">
                Import or scan skills into the organization library first, then enable them here.
              </div>
            </section>
          ) : (
            <>
              {agentSkillRows.length > 0 ? (
                <section className="overflow-hidden rounded-xl border border-border bg-[color:var(--surface-elevated)]">
                  <div className="border-b border-border px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">Agent skills</p>
                      <span className="text-xs text-muted-foreground">{agentSkillRows.length}</span>
                    </div>
                    <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                      {agentSectionHelperText}
                    </p>
                  </div>
                  <div className="px-3.5 py-3.5">
                    {filteredAgentSkillRows.length === 0 ? (
                      <div className="px-0.5 py-1 text-sm text-muted-foreground">
                        No skills match this search.
                      </div>
                    ) : (
                      <div className="grid gap-2.5 md:grid-cols-2">
                        {filteredAgentSkillRows.map((skill) => renderSkillCard(skill))}
                      </div>
                    )}
                  </div>
                </section>
              ) : null}

              <section className="overflow-hidden rounded-xl border border-border bg-[color:var(--surface-elevated)]">
                <div className="border-b border-border px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">Organization skills</p>
                    <span className="text-xs text-muted-foreground">{organizationSkillRows.length}</span>
                  </div>
                  <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                    {organizationSectionHelperText}
                  </p>
                </div>
                <div className="px-3.5 py-3.5">
                  {filteredOrganizationSkillRows.length === 0 ? (
                    <div className="px-0.5 py-1 text-sm text-muted-foreground">
                      No skills match this search.
                    </div>
                  ) : (
                    <div className="grid gap-2.5 md:grid-cols-2">
                      {filteredOrganizationSkillRows.map((skill) => renderSkillCard(skill))}
                    </div>
                  )}
                </div>
              </section>

              {externalSkillRows.length > 0 ? (
                <section className="overflow-hidden rounded-xl border border-border bg-[color:var(--surface-elevated)]">
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-start justify-between gap-3 px-4 py-3 text-left",
                      externalSectionOpen && "border-b border-border",
                    )}
                    onClick={() => setExternalSectionOpen((current) => !current)}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">External skills</span>
                        <span className="text-xs text-muted-foreground">{externalSkillRows.length}</span>
                      </div>
                      <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                        {externalSectionHelperText}
                      </p>
                    </div>
                    {externalSectionOpen ? (
                      <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                  {externalSectionOpen ? (
                    filteredGlobalSkillRows.length === 0 && filteredAdapterSkillRows.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-muted-foreground">
                        No external skills match this search.
                      </div>
                    ) : (
                      <div className="space-y-4 px-3.5 py-3.5">
                        {filteredGlobalSkillRows.length > 0 ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 px-0.5">
                              <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Global skills</span>
                              <span className="text-[11px] text-muted-foreground">{filteredGlobalSkillRows.length}</span>
                            </div>
                            <div className="grid gap-2.5 md:grid-cols-2">
                              {filteredGlobalSkillRows.map((skill) => renderSkillCard(skill))}
                            </div>
                          </div>
                        ) : null}
                        {filteredAdapterSkillRows.length > 0 ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 px-0.5">
                              <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Adapter skills</span>
                              <span className="text-[11px] text-muted-foreground">{filteredAdapterSkillRows.length}</span>
                            </div>
                            <div className="grid gap-2.5 md:grid-cols-2">
                              {filteredAdapterSkillRows.map((skill) => renderSkillCard(skill))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )
                  ) : null}
                </section>
              ) : null}
            </>
          )}

          {unavailableEnabledSkills.length > 0 ? (
            <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
              <div className="font-medium">Enabled skills currently unavailable</div>
              <div className="mt-1 text-xs">
                {unavailableEnabledSkills.join(", ")}
              </div>
            </div>
          ) : null}

          {syncSkills.isError ? (
            <p className="text-xs text-destructive">
              {syncSkills.error instanceof Error ? syncSkills.error.message : "Failed to update skills"}
            </p>
          ) : null}
        </>
      )}

      <CreateAgentSkillDialog
        open={createSkillOpen}
        onOpenChange={setCreateSkillOpen}
        onCreate={(payload) => createPrivateSkill.mutate(payload)}
        isPending={createPrivateSkill.isPending}
        error={createPrivateSkill.error instanceof Error ? createPrivateSkill.error.message : null}
      />
    </div>
  );
}

/* ---- Runs Tab ---- */

function RunListItem({ run, isSelected, agentId }: { run: HeartbeatRun; isSelected: boolean; agentId: string }) {
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const statusInfo = runStatusIcons[run.status] ?? { icon: Clock, color: "text-neutral-400" };
  const StatusIcon = statusInfo.icon;
  const metrics = runMetrics(run);
  const summary = run.resultJson
    ? String((run.resultJson as Record<string, unknown>).summary ?? (run.resultJson as Record<string, unknown>).result ?? "")
    : run.error ?? "";
  const runLabel = run.id.slice(0, 8);
  const destination = isSelected ? `/agents/${agentId}/runs` : `/agents/${agentId}/runs/${run.id}`;

  const openRun = () => {
    navigate(destination);
  };

  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openRun();
  };

  const handleCopyRunId = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(run.id);
      pushToast({
        title: "Run ID copied",
        body: "The full agent run ID is now in your clipboard.",
        tone: "success",
      });
    } catch (error) {
      pushToast({
        title: "Could not copy run ID",
        body: error instanceof Error ? error.message : "Clipboard access was denied.",
        tone: "error",
      });
    }
  };

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Open run ${runLabel}`}
      className={cn(
        "flex flex-col gap-1 w-full px-3 py-2.5 text-left border-b border-border last:border-b-0 transition-colors no-underline text-inherit",
        isSelected ? "bg-accent/40" : "hover:bg-accent/20",
      )}
      onClick={openRun}
      onKeyDown={handleRowKeyDown}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", statusInfo.color, run.status === "running" && "animate-spin")} />
        <button
          type="button"
          className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-foreground transition-colors cursor-copy"
          aria-label={`Copy run ID ${runLabel}`}
          title="Copy run ID"
          onClick={handleCopyRunId}
        >
          {runLabel}
        </button>
        <span className={cn(
          "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0",
          run.invocationSource === "timer" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
            : run.invocationSource === "assignment" ? "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"
            : run.invocationSource === "on_demand" ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"
            : "bg-muted text-muted-foreground"
        )}>
          {sourceLabels[run.invocationSource] ?? run.invocationSource}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
          {relativeTime(run.createdAt)}
        </span>
      </div>
      {summary && (
        <span className="text-xs text-muted-foreground truncate pl-5.5">
          {summary.slice(0, 60)}
        </span>
      )}
      {(metrics.totalTokens > 0 || metrics.cost > 0) && (
        <div className="flex items-center gap-2 pl-5.5 text-[11px] text-muted-foreground tabular-nums">
          {metrics.totalTokens > 0 && <span>{formatTokens(metrics.totalTokens)} tok</span>}
          {metrics.cost > 0 && <span>${metrics.cost.toFixed(3)}</span>}
        </div>
      )}
    </div>
  );
}

function RunsTab({
  runs,
  orgId,
  agentId,
  agentRouteId,
  selectedRunId,
  agentRuntimeType,
}: {
  runs: HeartbeatRun[];
  orgId: string;
  agentId: string;
  agentRouteId: string;
  selectedRunId: string | null;
  agentRuntimeType: string;
}) {
  const { isMobile } = useSidebar();

  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  // Sort by created descending
  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // On mobile, don't auto-select so the list shows first; on desktop, auto-select latest
  const effectiveRunId = isMobile ? selectedRunId : (selectedRunId ?? sorted[0]?.id ?? null);
  const selectedRun = sorted.find((r) => r.id === effectiveRunId) ?? null;

  // Mobile: show either run list OR run detail with back button
  if (isMobile) {
    if (selectedRun) {
      return (
        <div className="space-y-3 min-w-0 overflow-x-hidden">
          <Link
            to={`/agents/${agentRouteId}/runs`}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to runs
          </Link>
          <RunDetail key={selectedRun.id} run={selectedRun} agentRouteId={agentRouteId} agentRuntimeType={agentRuntimeType} />
        </div>
      );
    }
    return (
      <div className="border border-border rounded-lg overflow-x-hidden">
        {sorted.map((run) => (
          <RunListItem key={run.id} run={run} isSelected={false} agentId={agentRouteId} />
        ))}
      </div>
    );
  }

  if (!selectedRun) {
    return (
      <div className="border border-border rounded-lg overflow-x-hidden">
        {sorted.map((run) => (
          <RunListItem key={run.id} run={run} isSelected={false} agentId={agentRouteId} />
        ))}
      </div>
    );
  }

  // Desktop: compact navigation rail + detail pane that fully claims the remaining width
  return (
    <div className="flex min-w-0 items-start gap-4">
      <div className="w-[14rem] shrink-0 border border-border rounded-lg xl:w-[14.5rem] 2xl:w-[15rem]">
        <div className="sticky top-4 overflow-y-auto" style={{ maxHeight: "calc(100vh - 2rem)" }}>
          {sorted.map((run) => (
            <RunListItem key={run.id} run={run} isSelected={run.id === effectiveRunId} agentId={agentRouteId} />
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1 basis-0">
        <RunDetail key={selectedRun.id} run={selectedRun} agentRouteId={agentRouteId} agentRuntimeType={agentRuntimeType} />
      </div>
    </div>
  );
}

/* ---- Run Detail (expanded) ---- */

function RunDetail({ run: initialRun, agentRouteId, agentRuntimeType }: { run: HeartbeatRun; agentRouteId: string; agentRuntimeType: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: hydratedRun } = useQuery({
    queryKey: queryKeys.runDetail(initialRun.id),
    queryFn: () => heartbeatsApi.get(initialRun.id),
    enabled: Boolean(initialRun.id),
  });
  const run = hydratedRun ?? initialRun;
  const metrics = runMetrics(run);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [claudeLoginResult, setClaudeLoginResult] = useState<ClaudeLoginResult | null>(null);

  useEffect(() => {
    setClaudeLoginResult(null);
  }, [run.id]);

  const cancelRun = useMutation({
    mutationFn: () => heartbeatsApi.cancel(run.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.orgId, run.agentId) });
    },
  });
  const canResumeLostRun = run.errorCode === "process_lost" && run.status === "failed";
  const canRetryRun = run.status === "failed" || run.status === "timed_out";
  const recoverRun = useMutation({
    mutationFn: async () => retryHeartbeatRun(run),
    onSuccess: (newRun) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.orgId, run.agentId) });
      navigate(`/agents/${agentRouteId}/runs/${newRun.id}`);
    },
  });

  const { data: touchedIssues } = useQuery({
    queryKey: queryKeys.runIssues(run.id),
    queryFn: () => activityApi.issuesForRun(run.id),
  });
  const touchedIssueIds = useMemo(
    () => Array.from(new Set((touchedIssues ?? []).map((issue) => issue.issueId))),
    [touchedIssues],
  );

  const clearSessionsForTouchedIssues = useMutation({
    mutationFn: async () => {
      if (touchedIssueIds.length === 0) return 0;
      await Promise.all(touchedIssueIds.map((issueId) => agentsApi.resetSession(run.agentId, issueId, run.orgId)));
      return touchedIssueIds.length;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(run.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(run.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.runIssues(run.id) });
    },
  });

  const runClaudeLogin = useMutation({
    mutationFn: () => agentsApi.loginWithClaude(run.agentId, run.orgId),
    onSuccess: (data) => {
      setClaudeLoginResult(data);
    },
  });

  const isRunning = run.status === "running" && !!run.startedAt && !run.finishedAt;
  const [elapsedSec, setElapsedSec] = useState<number>(() => {
    if (!run.startedAt) return 0;
    return Math.max(0, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000));
  });

  useEffect(() => {
    if (!isRunning || !run.startedAt) return;
    const startMs = new Date(run.startedAt).getTime();
    setElapsedSec(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    const id = setInterval(() => {
      setElapsedSec(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning, run.startedAt]);

  const timeFormat: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
  const startTime = run.startedAt ? new Date(run.startedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const endTime = run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const durationSec = run.startedAt && run.finishedAt
    ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
    : null;
  const displayDurationSec = durationSec ?? (isRunning ? elapsedSec : null);
  const hasMetrics = metrics.input > 0 || metrics.output > 0 || metrics.cached > 0 || metrics.cost > 0;
  const hasSession = !!(run.sessionIdBefore || run.sessionIdAfter);
  const sessionChanged = run.sessionIdBefore && run.sessionIdAfter && run.sessionIdBefore !== run.sessionIdAfter;
  const hasNonZeroExit = run.exitCode !== null && run.exitCode !== 0;
  const recoveryContext = asRecord(asRecord(run.contextSnapshot)?.recovery);
  const recoveryOriginalRunId =
    asNonEmptyString(recoveryContext?.originalRunId) ?? run.retryOfRunId;
  const recoveryFailureKind = asNonEmptyString(recoveryContext?.failureKind);
  const recoveryFailureSummary = asNonEmptyString(recoveryContext?.failureSummary);
  const recoveryTrigger = asNonEmptyString(recoveryContext?.recoveryTrigger);
  const recoveryMode = asNonEmptyString(recoveryContext?.recoveryMode);

  return (
    <div className="space-y-4 min-w-0">
      {/* Run summary card */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="flex flex-col sm:flex-row">
          {/* Left column: status + timing */}
          <div className="flex-1 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <StatusBadge status={run.status} />
              {(run.status === "running" || run.status === "queued") && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive text-xs h-6 px-2"
                  onClick={() => cancelRun.mutate()}
                  disabled={cancelRun.isPending}
                >
                  {cancelRun.isPending ? "Cancelling…" : "Cancel"}
                </Button>
              )}
              {canResumeLostRun && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 px-2"
                  onClick={() => recoverRun.mutate()}
                  disabled={recoverRun.isPending}
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  {recoverRun.isPending ? "Resuming…" : "Resume"}
                </Button>
              )}
              {canRetryRun && !canResumeLostRun && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 px-2"
                  onClick={() => recoverRun.mutate()}
                  disabled={recoverRun.isPending}
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  {recoverRun.isPending ? "Retrying…" : "Retry"}
                </Button>
              )}
            </div>
            {recoverRun.isError && (
              <div className="text-xs text-destructive">
                {recoverRun.error instanceof Error ? recoverRun.error.message : "Failed to recover run"}
              </div>
            )}
            {startTime && (
              <div className="space-y-0.5">
                <div className="text-sm font-mono">
                  {startTime}
                  {endTime && <span className="text-muted-foreground"> &rarr; </span>}
                  {endTime}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {relativeTime(run.startedAt!)}
                  {run.finishedAt && <> &rarr; {relativeTime(run.finishedAt)}</>}
                </div>
                {displayDurationSec !== null && (
                  <div className="text-xs text-muted-foreground">
                    Duration: {displayDurationSec >= 60 ? `${Math.floor(displayDurationSec / 60)}m ${displayDurationSec % 60}s` : `${displayDurationSec}s`}
                  </div>
                )}
              </div>
            )}
            {run.error && (
              <div className="text-xs">
                <span className="text-red-600 dark:text-red-400">{run.error}</span>
                {run.errorCode && <span className="text-muted-foreground ml-1">({run.errorCode})</span>}
              </div>
            )}
            {run.errorCode === "claude_auth_required" && agentRuntimeType === "claude_local" && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => runClaudeLogin.mutate()}
                  disabled={runClaudeLogin.isPending}
                >
                  {runClaudeLogin.isPending ? "Running claude login..." : "Login to Claude Code"}
                </Button>
                {runClaudeLogin.isError && (
                  <p className="text-xs text-destructive">
                    {runClaudeLogin.error instanceof Error
                      ? runClaudeLogin.error.message
                      : "Failed to run Claude login"}
                  </p>
                )}
                {claudeLoginResult?.loginUrl && (
                  <p className="text-xs">
                    Login URL:
                    <a
                      href={claudeLoginResult.loginUrl}
                      className="text-blue-600 underline underline-offset-2 ml-1 break-all dark:text-blue-400"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {claudeLoginResult.loginUrl}
                    </a>
                  </p>
                )}
                {claudeLoginResult && (
                  <>
                    {!!claudeLoginResult.stdout && (
                      <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">
                        {claudeLoginResult.stdout}
                      </pre>
                    )}
                    {!!claudeLoginResult.stderr && (
                      <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap">
                        {claudeLoginResult.stderr}
                      </pre>
                    )}
                  </>
                )}
              </div>
            )}
            {hasNonZeroExit && (
              <div className="text-xs text-red-600 dark:text-red-400">
                Exit code {run.exitCode}
                {run.signal && <span className="text-muted-foreground ml-1">(signal: {run.signal})</span>}
              </div>
            )}
            {recoveryOriginalRunId && (
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs space-y-1">
                <div className="font-medium text-foreground">Recovery</div>
                <div className="text-muted-foreground">
                  From run{" "}
                  <Link className="underline underline-offset-2" to={`/agents/${run.agentId}/runs/${recoveryOriginalRunId}`}>
                    {recoveryOriginalRunId}
                  </Link>
                </div>
                {(recoveryTrigger || recoveryMode) && (
                  <div className="text-muted-foreground">
                    {[recoveryTrigger, recoveryMode].filter(Boolean).join(" · ")}
                  </div>
                )}
                {(recoveryFailureKind || recoveryFailureSummary) && (
                  <div className="text-muted-foreground">
                    {[recoveryFailureKind, recoveryFailureSummary].filter(Boolean).join(": ")}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right column: metrics */}
          {hasMetrics && (
            <div className="border-t sm:border-t-0 sm:border-l border-border p-4 grid grid-cols-2 gap-x-4 sm:gap-x-8 gap-y-3 content-center tabular-nums">
              <div>
                <div className="text-xs text-muted-foreground">Input</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.input)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Output</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.output)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cached</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.cached)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cost</div>
                <div className="text-sm font-medium font-mono">{metrics.cost > 0 ? `$${metrics.cost.toFixed(4)}` : "-"}</div>
              </div>
            </div>
          )}
        </div>

        {/* Collapsible session row */}
        {hasSession && (
          <div className="border-t border-border">
            <button
              className="flex items-center gap-1.5 w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setSessionOpen((v) => !v)}
            >
              <ChevronRight className={cn("h-3 w-3 transition-transform", sessionOpen && "rotate-90")} />
              Session
              {sessionChanged && <span className="text-yellow-400 ml-1">(changed)</span>}
            </button>
            {sessionOpen && (
              <div className="px-4 pb-3 space-y-1 text-xs">
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground w-12 shrink-0">Run ID</span>
                  <CopyText
                    text={run.id}
                    ariaLabel={`Copy run ID ${run.id.slice(0, 8)}`}
                    title="Copy run ID"
                    containerClassName="min-w-0 max-w-full"
                    className="block min-w-0 break-all text-left font-mono"
                  />
                </div>
                {run.sessionIdBefore && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-12">{sessionChanged ? "Before" : "ID"}</span>
                    <CopyText text={run.sessionIdBefore} className="font-mono" />
                  </div>
                )}
                {sessionChanged && run.sessionIdAfter && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-12">After</span>
                    <CopyText text={run.sessionIdAfter} className="font-mono" />
                  </div>
                )}
                {touchedIssueIds.length > 0 && (
                  <div className="pt-1">
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-60"
                      disabled={clearSessionsForTouchedIssues.isPending}
                      onClick={() => {
                        const issueCount = touchedIssueIds.length;
                        const confirmed = window.confirm(
                          `Clear session for ${issueCount} issue${issueCount === 1 ? "" : "s"} touched by this run?`,
                        );
                        if (!confirmed) return;
                        clearSessionsForTouchedIssues.mutate();
                      }}
                    >
                      {clearSessionsForTouchedIssues.isPending
                        ? "clearing session..."
                        : "clear session for these issues"}
                    </button>
                    {clearSessionsForTouchedIssues.isError && (
                      <p className="text-[11px] text-destructive mt-1">
                        {clearSessionsForTouchedIssues.error instanceof Error
                          ? clearSessionsForTouchedIssues.error.message
                          : "Failed to clear sessions"}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Issues touched by this run */}
      {touchedIssues && touchedIssues.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Issues Touched ({touchedIssues.length})</span>
          <div className="border border-border rounded-lg divide-y divide-border">
            {touchedIssues.map((issue) => (
              <Link
                key={issue.issueId}
                to={`/issues/${issue.identifier ?? issue.issueId}`}
                className="flex items-center justify-between w-full px-3 py-2 text-xs hover:bg-accent/20 transition-colors text-left no-underline text-inherit"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <StatusBadge status={issue.status} />
                  <span className="truncate">{issue.title}</span>
                </div>
                <span className="font-mono text-muted-foreground shrink-0 ml-2">{issue.identifier ?? issue.issueId.slice(0, 8)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* stderr excerpt for failed runs */}
      {run.stderrExcerpt && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-red-600 dark:text-red-400">stderr</span>
          <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap">{run.stderrExcerpt}</pre>
        </div>
      )}

      {/* stdout excerpt when no log is available */}
      {run.stdoutExcerpt && !run.logRef && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">stdout</span>
          <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">{run.stdoutExcerpt}</pre>
        </div>
      )}

      {/* Log viewer */}
      <LogViewer run={run} agentRuntimeType={agentRuntimeType} />
      <ScrollToBottom />
    </div>
  );
}

/* ---- Log Viewer ---- */

function LogViewer({ run, agentRuntimeType }: { run: HeartbeatRun; agentRuntimeType: string }) {
  type RunDetailTab = "transcript" | "invocation";
  const [events, setEvents] = useState<HeartbeatRunEvent[]>([]);
  const [logLines, setLogLines] = useState<RunLogChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [logLoading, setLogLoading] = useState(!!run.logRef);
  const [logError, setLogError] = useState<string | null>(null);
  const [logOffset, setLogOffset] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [isStreamingConnected, setIsStreamingConnected] = useState(false);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("nice");
  const [activeDetailTab, setActiveDetailTab] = useState<RunDetailTab>("transcript");
  const [transcriptModalOpen, setTranscriptModalOpen] = useState(false);
  const transcriptVisible = activeDetailTab === "transcript";
  const logEndRef = useRef<HTMLDivElement>(null);
  const pendingLogLineRef = useRef("");
  const seenLogChunkKeysRef = useRef<Set<string>>(new Set());
  const scrollContainerRef = useRef<ScrollContainer | null>(null);
  const isFollowingRef = useRef(false);
  const lastMetricsRef = useRef<{ scrollHeight: number; distanceFromBottom: number }>({
    scrollHeight: 0,
    distanceFromBottom: Number.POSITIVE_INFINITY,
  });
  const isLive = run.status === "running" || run.status === "queued";
  const { data: workspaceOperations = [] } = useQuery({
    queryKey: queryKeys.runWorkspaceOperations(run.id),
    queryFn: () => heartbeatsApi.workspaceOperations(run.id),
    refetchInterval: isLive ? 2000 : false,
  });

  function isRunLogUnavailable(err: unknown): boolean {
    return err instanceof ApiError && err.status === 404;
  }

  function appendLogContent(content: string, finalize = false) {
    if (!content && !finalize) return;
    const combined = `${pendingLogLineRef.current}${content}`;
    const split = combined.split("\n");
    pendingLogLineRef.current = split.pop() ?? "";
    if (finalize && pendingLogLineRef.current) {
      split.push(pendingLogLineRef.current);
      pendingLogLineRef.current = "";
    }

    const parsed: RunLogChunk[] = [];
    for (const line of split) {
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
        // ignore malformed lines
      }
    }

    if (parsed.length > 0) {
      appendLogChunks(parsed);
    }
  }

  function appendLogChunks(chunks: RunLogChunk[]) {
    if (chunks.length === 0) return;
    setLogLines((prev) => {
      const nextChunks: RunLogChunk[] = [];
      for (const chunk of chunks) {
        const key = runLogChunkDedupeKey(chunk);
        if (seenLogChunkKeysRef.current.has(key)) continue;
        seenLogChunkKeysRef.current.add(key);
        nextChunks.push(chunk);
      }
      if (nextChunks.length === 0) return prev;
      if (seenLogChunkKeysRef.current.size > 12000) {
        seenLogChunkKeysRef.current = new Set(nextChunks.map(runLogChunkDedupeKey));
      }
      return [...prev, ...nextChunks];
    });
  }

  // Fetch events
  const { data: initialEvents } = useQuery({
    queryKey: ["run-events", run.id],
    queryFn: () => heartbeatsApi.events(run.id, 0, 200),
  });

  useEffect(() => {
    if (initialEvents) {
      setEvents(initialEvents);
      setLoading(false);
    }
  }, [initialEvents]);

  const getScrollContainer = useCallback((): ScrollContainer => {
    if (scrollContainerRef.current) return scrollContainerRef.current;
    const container = findScrollContainer(logEndRef.current);
    scrollContainerRef.current = container;
    return container;
  }, []);

  const updateFollowingState = useCallback(() => {
    const container = getScrollContainer();
    const metrics = readScrollMetrics(container);
    lastMetricsRef.current = metrics;
    const nearBottom = metrics.distanceFromBottom <= LIVE_SCROLL_BOTTOM_TOLERANCE_PX;
    isFollowingRef.current = nearBottom;
    setIsFollowing((prev) => (prev === nearBottom ? prev : nearBottom));
  }, [getScrollContainer]);

  useEffect(() => {
    scrollContainerRef.current = null;
    lastMetricsRef.current = {
      scrollHeight: 0,
      distanceFromBottom: Number.POSITIVE_INFINITY,
    };

    if (!isLive || !transcriptVisible) {
      isFollowingRef.current = false;
      setIsFollowing(false);
      return;
    }

    updateFollowingState();
  }, [isLive, run.id, transcriptVisible, updateFollowingState]);

  useEffect(() => {
    if (!isLive || !transcriptVisible) return;
    const container = getScrollContainer();
    updateFollowingState();

    if (container === window) {
      window.addEventListener("scroll", updateFollowingState, { passive: true });
    } else {
      container.addEventListener("scroll", updateFollowingState, { passive: true });
    }
    window.addEventListener("resize", updateFollowingState);
    return () => {
      if (container === window) {
        window.removeEventListener("scroll", updateFollowingState);
      } else {
        container.removeEventListener("scroll", updateFollowingState);
      }
      window.removeEventListener("resize", updateFollowingState);
    };
  }, [isLive, run.id, transcriptVisible, getScrollContainer, updateFollowingState]);

  // Auto-scroll only for live runs when following
  useEffect(() => {
    if (!isLive || !transcriptVisible || !isFollowingRef.current) return;

    const container = getScrollContainer();
    const previous = lastMetricsRef.current;
    const current = readScrollMetrics(container);
    const growth = Math.max(0, current.scrollHeight - previous.scrollHeight);
    const expectedDistance = previous.distanceFromBottom + growth;
    const movedAwayBy = current.distanceFromBottom - expectedDistance;

    // If user moved away from bottom between updates, release auto-follow immediately.
    if (movedAwayBy > LIVE_SCROLL_BOTTOM_TOLERANCE_PX) {
      isFollowingRef.current = false;
      setIsFollowing(false);
      lastMetricsRef.current = current;
      return;
    }

    scrollToContainerBottom(container, "auto");
    const after = readScrollMetrics(container);
    lastMetricsRef.current = after;
    if (!isFollowingRef.current) {
      isFollowingRef.current = true;
    }
    setIsFollowing((prev) => (prev ? prev : true));
  }, [events.length, logLines.length, isLive, transcriptVisible, getScrollContainer]);

  // Fetch persisted shell log
  useEffect(() => {
    let cancelled = false;
    pendingLogLineRef.current = "";
    seenLogChunkKeysRef.current.clear();
    setLogLines([]);
    setLogOffset(0);
    setLogError(null);

    if (!run.logRef && !isLive) {
      setLogLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLogLoading(true);
    const firstLimit =
      typeof run.logBytes === "number" && run.logBytes > 0
        ? Math.min(Math.max(run.logBytes + 1024, 256_000), 2_000_000)
        : 256_000;

    const load = async () => {
      try {
        let offset = 0;
        let first = true;
        while (!cancelled) {
          const result = await heartbeatsApi.log(run.id, offset, first ? firstLimit : 256_000);
          if (cancelled) break;
          appendLogContent(result.content, result.nextOffset === undefined);
          const next = result.nextOffset ?? result.endOffset ?? offset + utf8ByteLength(result.content);
          setLogOffset(next);
          offset = next;
          first = false;
          if (result.nextOffset === undefined || isLive) break;
        }
      } catch (err) {
        if (!cancelled) {
          if (isLive && isRunLogUnavailable(err)) {
            setLogLoading(false);
            return;
          }
          setLogError(err instanceof Error ? err.message : "Failed to load run log");
        }
      } finally {
        if (!cancelled) setLogLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [run.id, run.logRef, run.logBytes, isLive]);

  // Poll for live updates
  useEffect(() => {
    if (!isLive || isStreamingConnected) return;
    const interval = setInterval(async () => {
      const maxSeq = events.length > 0 ? Math.max(...events.map((e) => e.seq)) : 0;
      try {
        const newEvents = await heartbeatsApi.events(run.id, maxSeq, 100);
        if (newEvents.length > 0) {
          setEvents((prev) => [...prev, ...newEvents]);
        }
      } catch {
        // ignore polling errors
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [run.id, isLive, isStreamingConnected, events]);

  // Poll shell log for running runs
  useEffect(() => {
    if (!isLive || isStreamingConnected) return;
    const interval = setInterval(async () => {
      try {
        const result = await heartbeatsApi.log(run.id, logOffset, 256_000);
        if (result.content) {
          appendLogContent(result.content, result.nextOffset === undefined);
        }
        if (result.nextOffset !== undefined) {
          setLogOffset(result.nextOffset);
        } else if (result.endOffset !== undefined) {
          setLogOffset(result.endOffset);
        } else if (result.content.length > 0) {
          setLogOffset((prev) => prev + utf8ByteLength(result.content));
        }
      } catch (err) {
        if (isRunLogUnavailable(err)) return;
        // ignore polling errors
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [run.id, isLive, isStreamingConnected, logOffset]);

  // Stream live updates from websocket (primary path for running runs).
  useEffect(() => {
    if (!isLive) return;

    let closed = false;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectTimer = window.setTimeout(connect, 1500);
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/orgs/${encodeURIComponent(run.orgId)}/events/ws`;
      socket = new WebSocket(url);

      socket.onopen = () => {
        setIsStreamingConnected(true);
      };

      socket.onmessage = (message) => {
        const rawMessage = typeof message.data === "string" ? message.data : "";
        if (!rawMessage) return;

        let event: LiveEvent;
        try {
          event = JSON.parse(rawMessage) as LiveEvent;
        } catch {
          return;
        }

        if (event.orgId !== run.orgId) return;
        const payload = asRecord(event.payload);
        const eventRunId = asNonEmptyString(payload?.runId);
        if (!payload || eventRunId !== run.id) return;

        if (event.type === "heartbeat.run.log") {
          if (payload.truncated === true) return;
          const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
          if (!chunk) return;
          const streamRaw = asNonEmptyString(payload.stream);
          const stream = streamRaw === "stderr" || streamRaw === "system" ? streamRaw : "stdout";
          const ts = asNonEmptyString((payload as Record<string, unknown>).ts) ?? event.createdAt;
          appendLogChunks([{ ts, stream, chunk }]);
          return;
        }

        if (event.type !== "heartbeat.run.event") return;

        const seq = typeof payload.seq === "number" ? payload.seq : null;
        if (seq === null || !Number.isFinite(seq)) return;

        const streamRaw = asNonEmptyString(payload.stream);
        const stream =
          streamRaw === "stdout" || streamRaw === "stderr" || streamRaw === "system"
            ? streamRaw
            : null;
        const levelRaw = asNonEmptyString(payload.level);
        const level =
          levelRaw === "info" || levelRaw === "warn" || levelRaw === "error"
            ? levelRaw
            : null;

        const liveEvent: HeartbeatRunEvent = {
          id: seq,
          orgId: run.orgId,
          runId: run.id,
          agentId: run.agentId,
          seq,
          eventType: asNonEmptyString(payload.eventType) ?? "event",
          stream,
          level,
          color: asNonEmptyString(payload.color),
          message: asNonEmptyString(payload.message),
          payload: asRecord(payload.payload),
          createdAt: new Date(event.createdAt),
        };

        setEvents((prev) => {
          if (prev.some((existing) => existing.seq === seq)) return prev;
          return [...prev, liveEvent];
        });
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        setIsStreamingConnected(false);
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      closed = true;
      setIsStreamingConnected(false);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "run_detail_unmount");
      }
    };
  }, [isLive, run.orgId, run.id, run.agentId]);

  const censorUsernameInLogs = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  }).data?.censorUsernameInLogs === true;

  const adapterInvokePayload = useMemo(() => {
    const evt = events.find((e) => e.eventType === "adapter.invoke");
    return redactPathValue(asRecord(evt?.payload ?? null), censorUsernameInLogs);
  }, [censorUsernameInLogs, events]);

  const adapter = useMemo(() => getUIAdapter(agentRuntimeType), [agentRuntimeType]);
  const transcript = useMemo(() => {
    const logTranscript = buildTranscript(logLines, adapter.parseStdoutLine, { censorUsernameInLogs });
    const eventTranscript = events.map((event) =>
      heartbeatRunEventToTranscriptEntry(event, {
        redactText: (value) => redactPathText(value, censorUsernameInLogs),
        redactValue: (value) => redactPathValue(value, censorUsernameInLogs),
      }),
    );
    return mergeTranscriptEntries(logTranscript, eventTranscript);
  }, [adapter, censorUsernameInLogs, events, logLines]);
  const hasInvocationTab = Boolean(adapterInvokePayload);
  const invocationPromptText =
    adapterInvokePayload?.prompt !== undefined
      ? formatInvocationValueForDisplay(adapterInvokePayload.prompt, censorUsernameInLogs)
      : null;
  const transcriptEntryLabel = `${transcript.length} ${transcript.length === 1 ? "entry" : "entries"}`;
  const renderTranscriptModeToggle = () => (
    <div className="inline-flex rounded-lg border border-border/70 bg-background/70 p-0.5">
      {(["nice", "raw"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className={cn(
            "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
            transcriptMode === mode
              ? "bg-accent text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setTranscriptMode(mode)}
        >
          {mode}
        </button>
      ))}
    </div>
  );

  useEffect(() => {
    setTranscriptMode("nice");
    setActiveDetailTab("transcript");
    setTranscriptModalOpen(false);
  }, [run.id]);

  useEffect(() => {
    if (!hasInvocationTab && activeDetailTab === "invocation") {
      setActiveDetailTab("transcript");
    }
  }, [activeDetailTab, hasInvocationTab]);

  if (loading && logLoading) {
    return <p className="text-xs text-muted-foreground">Loading run logs...</p>;
  }

  if (events.length === 0 && logLines.length === 0 && !logError) {
    return <p className="text-xs text-muted-foreground">No log events.</p>;
  }

  return (
    <div className="space-y-3">
      <WorkspaceOperationsSection
        operations={workspaceOperations}
        censorUsernameInLogs={censorUsernameInLogs}
      />
      <div className="rounded-2xl border border-border/70 bg-background/40">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-3 py-2 sm:px-4">
          {hasInvocationTab ? (
            <Tabs value={activeDetailTab} onValueChange={(value) => setActiveDetailTab(value as RunDetailTab)}>
              <PageTabBar
                items={[
                  { value: "transcript", label: "Transcript" },
                  {
                    value: "invocation",
                    label: "Invocation",
                    mobileLabel: "Invocation",
                    tooltip: "Exact adapter invoke payload",
                  },
                ]}
                value={activeDetailTab}
                onValueChange={(value) => setActiveDetailTab(value as RunDetailTab)}
                align="start"
                triggerClassName="px-2 py-1 text-xs"
              />
            </Tabs>
          ) : (
            <span className="text-xs font-medium text-muted-foreground">Transcript</span>
          )}
          {transcriptVisible ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {transcriptEntryLabel}
              </span>
              {renderTranscriptModeToggle()}
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                onClick={() => setTranscriptModalOpen(true)}
                aria-label="Expand transcript"
                title="Expand transcript"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
              {isLive && !isFollowing && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    const container = getScrollContainer();
                    isFollowingRef.current = true;
                    setIsFollowing(true);
                    scrollToContainerBottom(container, "auto");
                    lastMetricsRef.current = readScrollMetrics(container);
                  }}
                >
                  Jump to live
                </Button>
              )}
              {isLive && (
                <span className="flex items-center gap-1 text-xs text-cyan-400">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
                  </span>
                  Live
                </span>
              )}
            </div>
          ) : null}
        </div>

        {transcriptVisible ? (
          <div className="max-h-[38rem] overflow-y-auto p-3 sm:p-4">
            <RunTranscriptView
              entries={transcript}
              mode={transcriptMode}
              streaming={isLive}
              collapseStdout
              emptyMessage={run.logRef ? "Waiting for transcript..." : "No persisted transcript for this run."}
              presentation="detail"
            />
            {logError && (
              <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {logError}
              </div>
            )}
            <div ref={logEndRef} />
          </div>
        ) : (
          <div className="max-h-[38rem] overflow-y-auto p-3 sm:p-4">
            <div className="space-y-3">
              {typeof adapterInvokePayload?.agentRuntimeType === "string" && (
                <div className="text-xs">
                  <span className="text-muted-foreground">Runtime: </span>
                  {adapterInvokePayload.agentRuntimeType}
                </div>
              )}
              {typeof adapterInvokePayload?.cwd === "string" && (
                <div className="text-xs break-all">
                  <span className="text-muted-foreground">Working dir: </span>
                  <span className="font-mono">{adapterInvokePayload.cwd}</span>
                </div>
              )}
              {typeof adapterInvokePayload?.command === "string" && (
                <div className="text-xs break-all">
                  <span className="text-muted-foreground">Command: </span>
                  <span className="font-mono">
                    {[
                      adapterInvokePayload.command,
                      ...(Array.isArray(adapterInvokePayload.commandArgs)
                        ? adapterInvokePayload.commandArgs.filter((v): v is string => typeof v === "string")
                        : []),
                    ].join(" ")}
                  </span>
                </div>
              )}
              {Array.isArray(adapterInvokePayload?.commandNotes) && adapterInvokePayload.commandNotes.length > 0 && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Command notes</div>
                  <ul className="list-disc space-y-1 pl-5">
                    {adapterInvokePayload.commandNotes
                      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
                      .map((note, idx) => (
                        <li key={`${idx}-${note}`} className="text-xs break-all font-mono">
                          {note}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              {invocationPromptText !== null && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Prompt</div>
                  <div className="relative">
                    <CopyText
                      text={invocationPromptText}
                      ariaLabel="Copy invocation prompt"
                      title="Copy prompt"
                      containerClassName="absolute right-2 top-2"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/70 bg-background/80 text-muted-foreground shadow-sm hover:bg-muted/80 hover:text-foreground"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                    <pre
                      data-testid="invocation-prompt"
                      className="rounded-md bg-neutral-100 p-2 pr-11 text-xs whitespace-pre-wrap overflow-x-auto dark:bg-neutral-950"
                    >{invocationPromptText}</pre>
                  </div>
                </div>
              )}
              {adapterInvokePayload?.context !== undefined && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Context</div>
                  <pre className="rounded-md bg-neutral-100 p-2 text-xs whitespace-pre-wrap overflow-x-auto dark:bg-neutral-950">
                    {JSON.stringify(redactPathValue(adapterInvokePayload.context, censorUsernameInLogs), null, 2)}
                  </pre>
                </div>
              )}
              {adapterInvokePayload?.env !== undefined && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Environment</div>
                  <pre className="rounded-md bg-neutral-100 p-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto dark:bg-neutral-950">
                    {formatEnvForDisplay(adapterInvokePayload.env, censorUsernameInLogs)}
                  </pre>
                </div>
              )}
              {events.length > 0 && (
                <RunEventsList
                  events={events}
                  censorUsernameInLogs={censorUsernameInLogs}
                />
              )}
            </div>
          </div>
        )}
      </div>

      <Dialog open={transcriptModalOpen} onOpenChange={setTranscriptModalOpen}>
        <DialogContent className="grid h-[min(90dvh,54rem)] max-w-[min(96vw,88rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,88rem)]">
          <DialogHeader className="border-b border-border/70 px-4 py-3 pr-12 text-left">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <DialogTitle className="text-sm">Transcript</DialogTitle>
                <DialogDescription className="sr-only">
                  Expanded transcript for run {run.id}.
                </DialogDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{transcriptEntryLabel}</span>
                {renderTranscriptModeToggle()}
                {isLive && (
                  <span className="flex items-center gap-1 text-xs text-cyan-400">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-cyan-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
                    </span>
                    Live
                  </span>
                )}
              </div>
            </div>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto p-3 sm:p-4">
            <RunTranscriptView
              entries={transcript}
              mode={transcriptMode}
              streaming={isLive}
              collapseStdout
              emptyMessage={run.logRef ? "Waiting for transcript..." : "No persisted transcript for this run."}
              presentation="detail"
            />
            {logError && (
              <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {logError}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {(run.status === "failed" || run.status === "timed_out") && (
        <div className="rounded-lg border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-950/20 p-3 space-y-2">
          <div className="text-xs font-medium text-red-700 dark:text-red-300">Failure details</div>
          {run.error && (
            <div className="text-xs text-red-600 dark:text-red-200">
              <span className="text-red-700 dark:text-red-300">Error: </span>
              {redactPathText(run.error, censorUsernameInLogs)}
            </div>
          )}
          {run.stderrExcerpt && run.stderrExcerpt.trim() && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">stderr excerpt</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {redactPathText(run.stderrExcerpt, censorUsernameInLogs)}
              </pre>
            </div>
          )}
          {run.resultJson && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">runtime result JSON</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {JSON.stringify(redactPathValue(run.resultJson, censorUsernameInLogs), null, 2)}
              </pre>
            </div>
          )}
          {run.stdoutExcerpt && run.stdoutExcerpt.trim() && !run.resultJson && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">stdout excerpt</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {redactPathText(run.stdoutExcerpt, censorUsernameInLogs)}
              </pre>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

/* ---- Keys Tab ---- */

function KeysTab({ agentId, orgId }: { agentId: string; orgId?: string }) {
  const queryClient = useQueryClient();
  const [newKeyName, setNewKeyName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: keys, isLoading } = useQuery({
    queryKey: queryKeys.agents.keys(agentId),
    queryFn: () => agentsApi.listKeys(agentId, orgId),
  });

  const createKey = useMutation({
    mutationFn: () => agentsApi.createKey(agentId, newKeyName.trim() || "Default", orgId),
    onSuccess: (data) => {
      setNewToken(data.token);
      setTokenVisible(true);
      setNewKeyName("");
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.keys(agentId) });
    },
  });

  const revokeKey = useMutation({
    mutationFn: (keyId: string) => agentsApi.revokeKey(agentId, keyId, orgId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.keys(agentId) });
    },
  });

  function copyToken() {
    if (!newToken) return;
    navigator.clipboard.writeText(newToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const activeKeys = (keys ?? []).filter((k: AgentKey) => !k.revokedAt);
  const revokedKeys = (keys ?? []).filter((k: AgentKey) => k.revokedAt);

  return (
    <div className="space-y-6">
      {/* New token banner */}
      {newToken && (
        <div className="border border-yellow-300 dark:border-yellow-600/40 bg-yellow-50 dark:bg-yellow-500/5 rounded-lg p-4 space-y-2">
          <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
            API key created — copy it now, it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-neutral-100 dark:bg-neutral-950 rounded px-3 py-1.5 text-xs font-mono text-green-700 dark:text-green-300 truncate">
              {tokenVisible ? newToken : newToken.replace(/./g, "•")}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setTokenVisible((v) => !v)}
              title={tokenVisible ? "Hide" : "Show"}
            >
              {tokenVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={copyToken}
              title="Copy"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            {copied && <span className="text-xs text-green-400">Copied!</span>}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground text-xs"
            onClick={() => setNewToken(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* Create new key */}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-xs font-medium text-muted-foreground flex items-center gap-2">
          <Key className="h-3.5 w-3.5" />
          Create API Key
        </h3>
        <p className="text-xs text-muted-foreground">
          API keys allow this agent to authenticate calls to the Rudder server.
        </p>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Key name (e.g. production)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="h-8 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") createKey.mutate();
            }}
          />
          <Button
            size="sm"
            onClick={() => createKey.mutate()}
            disabled={createKey.isPending}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Create
          </Button>
        </div>
      </div>

      {/* Active keys */}
      {isLoading && <p className="text-sm text-muted-foreground">Loading keys...</p>}

      {!isLoading && activeKeys.length === 0 && !newToken && (
        <p className="text-sm text-muted-foreground">No active API keys.</p>
      )}

      {activeKeys.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">
            Active Keys
          </h3>
          <div className="border border-border rounded-lg divide-y divide-border">
            {activeKeys.map((key: AgentKey) => (
              <div key={key.id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <span className="text-sm font-medium">{key.name}</span>
                  <span className="text-xs text-muted-foreground ml-3">
                    Created {formatDate(key.createdAt)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive text-xs"
                  onClick={() => revokeKey.mutate(key.id)}
                  disabled={revokeKey.isPending}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Revoked keys */}
      {revokedKeys.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">
            Revoked Keys
          </h3>
          <div className="border border-border rounded-lg divide-y divide-border opacity-50">
            {revokedKeys.map((key: AgentKey) => (
              <div key={key.id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <span className="text-sm line-through">{key.name}</span>
                  <span className="text-xs text-muted-foreground ml-3">
                    Revoked {key.revokedAt ? formatDate(key.revokedAt) : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
