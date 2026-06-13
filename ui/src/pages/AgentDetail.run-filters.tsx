import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { HeartbeatInvocationSource, HeartbeatRun, HeartbeatRunStatus } from "@rudderhq/shared";
import { HEARTBEAT_INVOCATION_SOURCES, HEARTBEAT_RUN_STATUSES } from "@rudderhq/shared";
import { ArrowDownUp, Filter, Search, SlidersHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";
import { asNonEmptyString, asRecord, formatCompactTokenLabel, readInvocationSkillList, runMetrics } from "./AgentDetail.helpers";

export type RunFilterView = "all" | "active" | "failed" | "issue" | "retries" | "expensive";
export type RunFilterContext = "issue" | "retry" | "followup" | "process_lost";
export type RunFilterDatePreset = "all" | "24h" | "7d" | "30d" | "custom";
export type RunFilterCostPreset = "high_tokens" | "long";
export type RunSortKey = "newest" | "oldest" | "duration_desc" | "duration_asc" | "tokens_desc" | "tokens_asc" | "cost_desc" | "cost_asc";
type RunSortField = "created" | "duration" | "tokens" | "cost";
type RunSortDir = "asc" | "desc";
export type RunSkillOption = { key: string; label: string; count: number };

export interface RunFilterState {
  view: RunFilterView;
  q: string;
  statuses: HeartbeatRunStatus[];
  sources: HeartbeatInvocationSource[];
  contexts: RunFilterContext[];
  skills: string[];
  date: RunFilterDatePreset;
  customFrom: string;
  customTo: string;
  cost: RunFilterCostPreset[];
  sort: RunSortKey;
}

type RunFilterParamPatch = Partial<RunFilterState>;

const runFilterViews: Array<{ value: RunFilterView; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "failed", label: "Failed" },
  { value: "issue", label: "Issue work" },
  { value: "retries", label: "Retries" },
  { value: "expensive", label: "Expensive" },
];

const statusLabels: Record<HeartbeatRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
};

const sourceLabels: Record<HeartbeatInvocationSource, string> = {
  timer: "Heartbeat",
  assignment: "Assignment",
  review: "Review",
  on_demand: "Manual",
  automation: "Automation",
};

const contextLabels: Record<RunFilterContext, string> = {
  issue: "Issue-backed",
  retry: "Retry / recovery",
  followup: "Passive follow-up",
  process_lost: "Process lost",
};

const dateLabels: Record<RunFilterDatePreset, string> = {
  all: "Any time",
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  custom: "Custom",
};

const costLabels: Record<RunFilterCostPreset, string> = {
  high_tokens: ">500k tokens",
  long: ">30m",
};

const sortLabels: Record<RunSortKey, string> = {
  newest: "Newest",
  oldest: "Oldest",
  duration_desc: "Longest duration",
  duration_asc: "Shortest duration",
  tokens_desc: "Most tokens",
  tokens_asc: "Fewest tokens",
  cost_desc: "Highest cost",
  cost_asc: "Lowest cost",
};

const runSortOptions: Array<{ value: RunSortField; label: string }> = [
  { value: "created", label: "Created" },
  { value: "duration", label: "Duration" },
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Cost" },
];

const validViews = new Set<RunFilterView>(runFilterViews.map((view) => view.value));
const validStatuses = new Set<HeartbeatRunStatus>(HEARTBEAT_RUN_STATUSES);
const validSources = new Set<HeartbeatInvocationSource>(HEARTBEAT_INVOCATION_SOURCES);
const validContexts = new Set<RunFilterContext>(Object.keys(contextLabels) as RunFilterContext[]);
const validDates = new Set<RunFilterDatePreset>(Object.keys(dateLabels) as RunFilterDatePreset[]);
const validCosts = new Set<RunFilterCostPreset>(Object.keys(costLabels) as RunFilterCostPreset[]);
const validSorts = new Set<RunSortKey>(Object.keys(sortLabels) as RunSortKey[]);

const ACTIVE_STATUSES: HeartbeatRunStatus[] = ["queued", "running"];
const HIGH_TOKEN_THRESHOLD = 500_000;
const LONG_RUN_MS = 30 * 60 * 1000;

function readList<T extends string>(value: string | null, allowed: Set<T>): T[] {
  if (!value) return [];
  const out: T[] = [];
  const seen = new Set<T>();
  for (const raw of value.split(",")) {
    const item = raw.trim() as T;
    if (!allowed.has(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function writeList<T extends string>(values: T[]) {
  return values.length > 0 ? values.join(",") : null;
}

function readFreeformList(value: string | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function readDateTimeInputValue(value: string | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const timestamp = new Date(trimmed).getTime();
  return Number.isFinite(timestamp) ? trimmed : "";
}

function toggleValue<T extends string>(values: T[], value: T) {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
}

function readRunIssueId(run: HeartbeatRun) {
  return asNonEmptyString(asRecord(run.contextSnapshot)?.issueId);
}

function runHasRecoveryContext(run: HeartbeatRun) {
  const context = asRecord(run.contextSnapshot);
  return Boolean(run.retryOfRunId || asRecord(context?.recovery));
}

function runHasPassiveFollowup(run: HeartbeatRun) {
  const context = asRecord(run.contextSnapshot);
  return Boolean(asRecord(context?.passiveFollowup));
}

export function runDurationMs(run: HeartbeatRun) {
  if (!run.startedAt) return 0;
  const start = new Date(run.startedAt).getTime();
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
}

function isExpensiveRun(run: HeartbeatRun) {
  return runMetrics(run).totalTokens >= HIGH_TOKEN_THRESHOLD || runDurationMs(run) >= LONG_RUN_MS;
}

function matchesView(run: HeartbeatRun, view: RunFilterView) {
  switch (view) {
    case "active":
      return ACTIVE_STATUSES.includes(run.status);
    case "failed":
      return run.status === "failed" || run.status === "timed_out";
    case "issue":
      return Boolean(readRunIssueId(run));
    case "retries":
      return runHasRecoveryContext(run);
    case "expensive":
      return isExpensiveRun(run);
    case "all":
    default:
      return true;
  }
}

function matchesContext(run: HeartbeatRun, context: RunFilterContext) {
  switch (context) {
    case "issue":
      return Boolean(readRunIssueId(run));
    case "retry":
      return runHasRecoveryContext(run);
    case "followup":
      return runHasPassiveFollowup(run);
    case "process_lost":
      return run.errorCode === "process_lost";
  }
}

function dateTimeInputToTimestamp(value: string) {
  if (!value.trim()) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function matchesDate(run: HeartbeatRun, state: Pick<RunFilterState, "date" | "customFrom" | "customTo">) {
  if (state.date === "all") return true;
  const createdAt = new Date(run.createdAt).getTime();
  if (!Number.isFinite(createdAt)) return false;

  if (state.date === "custom") {
    const from = dateTimeInputToTimestamp(state.customFrom);
    const to = dateTimeInputToTimestamp(state.customTo);
    if (from !== null && createdAt < from) return false;
    if (to !== null && createdAt > to) return false;
    return true;
  }

  const windowMs = state.date === "24h" ? 24 * 60 * 60 * 1000 : state.date === "7d" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  return createdAt >= Date.now() - windowMs;
}

function matchesCost(run: HeartbeatRun, cost: RunFilterCostPreset) {
  if (cost === "high_tokens") return runMetrics(run).totalTokens >= HIGH_TOKEN_THRESHOLD;
  return runDurationMs(run) >= LONG_RUN_MS;
}

function normalizeRunSkillEntry(value: unknown) {
  const record = asRecord(value);
  if (record) {
    const key = asNonEmptyString(record.key) ?? asNonEmptyString(record.runtimeName) ?? asNonEmptyString(record.name);
    if (!key) return null;
    return {
      key,
      label: asNonEmptyString(record.runtimeName) ?? asNonEmptyString(record.name) ?? key.split(/[/:]/).filter(Boolean).at(-1) ?? key,
    };
  }
  const key = asNonEmptyString(value);
  if (!key) return null;
  return {
    key,
    label: key.split(/[/:]/).filter(Boolean).at(-1) ?? key,
  };
}

function readRunSkillList(payload: Record<string, unknown> | null | undefined) {
  if (!payload) return [];
  const objectSkills = [
    ...readInvocationSkillList(payload, "usedSkills"),
    ...(payload.skillEvidenceType === "used" ? readInvocationSkillList(payload, "skillEvidenceSkills") : []),
  ];
  const stringSkills = [
    ...(Array.isArray(payload.usedSkillKeys) ? payload.usedSkillKeys : []),
    ...(payload.skillEvidenceType === "used" && Array.isArray(payload.skillEvidenceKeys) ? payload.skillEvidenceKeys : []),
  ].map(normalizeRunSkillEntry).filter((skill): skill is { key: string; label: string } => Boolean(skill));
  const seen = new Set<string>();
  const skills: Array<{ key: string; label: string }> = [];
  for (const skill of [...objectSkills, ...stringSkills]) {
    if (seen.has(skill.key)) continue;
    seen.add(skill.key);
    skills.push(skill);
  }
  return skills;
}

export function runUsedSkills(run: HeartbeatRun) {
  const skills = [
    ...readRunSkillList(asRecord(run.usageJson)),
    ...readRunSkillList(asRecord(run.resultJson)),
  ];
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.key)) return false;
    seen.add(skill.key);
    return true;
  });
}

export function runSkillOptions(runs: HeartbeatRun[]): RunSkillOption[] {
  const byKey = new Map<string, RunSkillOption>();
  for (const run of runs) {
    for (const skill of runUsedSkills(run)) {
      const existing = byKey.get(skill.key);
      if (existing) {
        existing.count += 1;
        if (existing.label === existing.key && skill.label !== skill.key) existing.label = skill.label;
      } else {
        byKey.set(skill.key, { key: skill.key, label: skill.label, count: 1 });
      }
    }
  }
  return Array.from(byKey.values()).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function searchableText(run: HeartbeatRun) {
  const result = asRecord(run.resultJson);
  return [
    run.id,
    run.status,
    run.invocationSource,
    run.triggerDetail,
    run.error,
    run.errorCode,
    readRunIssueId(run),
    asNonEmptyString(result?.summary),
    asNonEmptyString(result?.result),
    ...runUsedSkills(run).flatMap((skill) => [skill.key, skill.label]),
  ].filter(Boolean).join(" ").toLowerCase();
}

export function parseRunFilterState(searchParams: URLSearchParams): RunFilterState {
  const rawView = searchParams.get("runView") as RunFilterView | null;
  const rawDate = searchParams.get("runDate") as RunFilterDatePreset | null;
  const rawSort = searchParams.get("runSort") as RunSortKey | null;
  return {
    view: rawView && validViews.has(rawView) ? rawView : "all",
    q: searchParams.get("runQ")?.trim() ?? "",
    statuses: readList(searchParams.get("runStatus"), validStatuses),
    sources: readList(searchParams.get("runSource"), validSources),
    contexts: readList(searchParams.get("runContext"), validContexts),
    skills: readFreeformList(searchParams.get("runSkill")),
    date: rawDate && validDates.has(rawDate) ? rawDate : "all",
    customFrom: readDateTimeInputValue(searchParams.get("runFrom")),
    customTo: readDateTimeInputValue(searchParams.get("runTo")),
    cost: readList(searchParams.get("runCost"), validCosts),
    sort: rawSort && validSorts.has(rawSort) ? rawSort : "newest",
  };
}

export function writeRunFilterState(searchParams: URLSearchParams, patch: RunFilterParamPatch) {
  const nextState = { ...parseRunFilterState(searchParams), ...patch };
  const next = new URLSearchParams(searchParams);

  if (nextState.view === "all") next.delete("runView");
  else next.set("runView", nextState.view);

  if (nextState.q.trim()) next.set("runQ", nextState.q.trim());
  else next.delete("runQ");

  const values: Array<[string, string | null]> = [
    ["runStatus", writeList(nextState.statuses)],
    ["runSource", writeList(nextState.sources)],
    ["runContext", writeList(nextState.contexts)],
    ["runSkill", writeList(nextState.skills)],
    ["runCost", writeList(nextState.cost)],
    ["runDate", nextState.date === "all" ? null : nextState.date],
    ["runFrom", nextState.date === "custom" && nextState.customFrom ? nextState.customFrom : null],
    ["runTo", nextState.date === "custom" && nextState.customTo ? nextState.customTo : null],
    ["runSort", nextState.sort === "newest" ? null : nextState.sort],
  ];
  for (const [key, value] of values) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

export function hasRunFilters(state: RunFilterState) {
  return countActiveRunFilters(state) > 0;
}

export function countActiveRunFilters(state: RunFilterState) {
  return Number(state.view !== "all")
    + Number(state.q.length > 0)
    + Number(state.statuses.length > 0)
    + Number(state.sources.length > 0)
    + Number(state.contexts.length > 0)
    + Number(state.skills.length > 0)
    + Number(state.date !== "all")
    + Number(state.cost.length > 0);
}

export function applyRunFilters(runs: HeartbeatRun[], state: RunFilterState) {
  const q = state.q.toLowerCase();
  return runs.filter((run) => {
    if (!matchesView(run, state.view)) return false;
    if (state.statuses.length > 0 && !state.statuses.includes(run.status)) return false;
    if (state.sources.length > 0 && !state.sources.includes(run.invocationSource)) return false;
    if (state.contexts.length > 0 && !state.contexts.every((context) => matchesContext(run, context))) return false;
    if (state.skills.length > 0 && !runUsedSkills(run).some((skill) => state.skills.includes(skill.key))) return false;
    if (state.cost.length > 0 && !state.cost.every((cost) => matchesCost(run, cost))) return false;
    if (!matchesDate(run, state)) return false;
    if (q && !searchableText(run).includes(q)) return false;
    return true;
  });
}

function compareCreatedAt(left: HeartbeatRun, right: HeartbeatRun) {
  return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
}

export function applyRunSort(runs: HeartbeatRun[], sort: RunSortKey) {
  return [...runs].sort((left, right) => {
    switch (sort) {
      case "oldest":
        return -compareCreatedAt(left, right);
      case "duration_desc":
        return runDurationMs(right) - runDurationMs(left) || compareCreatedAt(left, right);
      case "duration_asc":
        return runDurationMs(left) - runDurationMs(right) || compareCreatedAt(left, right);
      case "tokens_desc":
        return runMetrics(right).totalTokens - runMetrics(left).totalTokens || compareCreatedAt(left, right);
      case "tokens_asc":
        return runMetrics(left).totalTokens - runMetrics(right).totalTokens || compareCreatedAt(left, right);
      case "cost_desc":
        return runMetrics(right).cost - runMetrics(left).cost || compareCreatedAt(left, right);
      case "cost_asc":
        return runMetrics(left).cost - runMetrics(right).cost || compareCreatedAt(left, right);
      case "newest":
      default:
        return compareCreatedAt(left, right);
    }
  });
}

function runSortField(sort: RunSortKey): RunSortField {
  if (sort.startsWith("duration_")) return "duration";
  if (sort.startsWith("tokens_")) return "tokens";
  if (sort.startsWith("cost_")) return "cost";
  return "created";
}

function runSortDir(sort: RunSortKey): RunSortDir {
  return sort === "oldest" || sort.endsWith("_asc") ? "asc" : "desc";
}

function runSortKey(field: RunSortField, dir: RunSortDir): RunSortKey {
  if (field === "created") return dir === "asc" ? "oldest" : "newest";
  return `${field}_${dir}` as RunSortKey;
}

export function runFilterChips(state: RunFilterState) {
  const chips: string[] = [];
  if (state.view !== "all") chips.push(runFilterViews.find((view) => view.value === state.view)?.label ?? state.view);
  if (state.q) chips.push(`Search: ${state.q}`);
  if (state.statuses.length > 0) chips.push(`Status: ${state.statuses.map((status) => statusLabels[status]).join(", ")}`);
  if (state.sources.length > 0) chips.push(`Source: ${state.sources.map((source) => sourceLabels[source]).join(", ")}`);
  for (const context of state.contexts) chips.push(contextLabels[context]);
  if (state.skills.length > 0) chips.push(`Skill: ${state.skills.join(", ")}`);
  for (const cost of state.cost) chips.push(costLabels[cost]);
  if (state.date !== "all") chips.push(formatDateFilterChip(state));
  return chips;
}

function formatDateTimeChipValue(value: string) {
  const timestamp = dateTimeInputToTimestamp(value);
  if (timestamp === null) return "";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateFilterChip(state: Pick<RunFilterState, "date" | "customFrom" | "customTo">) {
  if (state.date !== "custom") return dateLabels[state.date];
  const from = formatDateTimeChipValue(state.customFrom);
  const to = formatDateTimeChipValue(state.customTo);
  if (from && to) return `Custom: ${from} - ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Until ${to}`;
  return dateLabels.custom;
}

export function RunFiltersToolbar({
  runs,
  filteredCount,
  state,
  onChange,
  onClear,
}: {
  runs: HeartbeatRun[];
  filteredCount: number;
  state: RunFilterState;
  onChange: (patch: RunFilterParamPatch) => void;
  onClear: () => void;
}) {
  const activeFilterCount = countActiveRunFilters(state);
  const activeSortLabel = sortLabels[state.sort] ?? sortLabels.newest;
  const activeSortField = runSortField(state.sort);
  const activeSortDir = runSortDir(state.sort);
  const [sortOpen, setSortOpen] = useState(false);
  const statusCounts = useMemo(() => {
    const counts = new Map<HeartbeatRunStatus, number>();
    for (const status of HEARTBEAT_RUN_STATUSES) counts.set(status, 0);
    for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
    return counts;
  }, [runs]);
  const skillOptions = useMemo(() => runSkillOptions(runs), [runs]);

  return (
    <div className="pointer-events-none sticky top-2 z-20 mb-3 flex justify-end">
      <div
        className="pointer-events-auto flex max-w-full flex-wrap items-center justify-end gap-2 rounded-lg border border-border bg-background/95 px-2.5 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/85"
        data-testid="run-filter-floating-toolbar"
      >
        <div className="flex items-center overflow-hidden rounded-md border border-border bg-muted/20">
          {runFilterViews.map((view) => (
            <button
              key={view.value}
              type="button"
              className={cn(
                "h-7 px-2.5 text-xs transition-colors",
                state.view === view.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/40",
              )}
              onClick={() => onChange({ view: view.value })}
            >
              {view.label}
            </button>
          ))}
        </div>

        <label className="relative block w-[min(14rem,42vw)]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search runs"
            value={state.q}
            onChange={(event) => onChange({ q: event.target.value })}
            placeholder="Search runs"
            className="h-7 pl-7 pr-2 text-xs"
          />
        </label>

        <Popover open={sortOpen} onOpenChange={setSortOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-7 px-2 text-xs", state.sort !== "newest" && "text-[color:var(--accent-strong)] bg-accent/30")}
              aria-label={`Sort runs: ${activeSortLabel}`}
            >
              <ArrowDownUp className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">Sort</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={8} className="w-48 p-0" data-testid="run-sort-popover">
            <div className="space-y-0.5 p-2" role="menu" aria-label="Sort runs">
              {runSortOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={activeSortField === option.value}
                  className={cn(
                    "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm transition-colors",
                    activeSortField === option.value ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                  onClick={() => {
                    const nextDir = activeSortField === option.value
                      ? activeSortDir === "asc" ? "desc" : "asc"
                      : "asc";
                    onChange({ sort: runSortKey(option.value, nextDir) });
                  }}
                >
                  <span>{option.label}</span>
                  {activeSortField === option.value && (
                    <span className="text-xs text-muted-foreground">
                      {activeSortDir === "asc" ? "\u2191" : "\u2193"}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-7 px-2 text-xs", activeFilterCount > 0 && "text-[color:var(--accent-strong)] bg-accent/30")}
            >
              <SlidersHorizontal className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">{activeFilterCount > 0 ? `Filter: ${activeFilterCount}` : "Filter"}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={8} className="w-[min(440px,calc(100vw-2rem))] p-0" data-testid="run-filter-popover">
            <div className="space-y-3 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">Filter runs</span>
                </div>
                {activeFilterCount > 0 && (
                  <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={onClear}>
                    Clear
                  </button>
                )}
              </div>

              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">Status</span>
                <div className="grid grid-cols-2 gap-1">
                  {HEARTBEAT_RUN_STATUSES.map((status) => (
                    <label key={status} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent/50">
                      <Checkbox
                        checked={state.statuses.includes(status)}
                        onCheckedChange={() => onChange({ statuses: toggleValue(state.statuses, status) })}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{statusLabels[status]}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{statusCounts.get(status) ?? 0}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Source</span>
                  <div className="flex flex-wrap gap-1">
                    {HEARTBEAT_INVOCATION_SOURCES.map((source) => (
                      <button
                        key={source}
                        type="button"
                        className={cn(
                          "rounded-md border px-2 py-1 text-xs transition-colors",
                          state.sources.includes(source)
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                        onClick={() => onChange({ sources: toggleValue(state.sources, source) })}
                      >
                        {sourceLabels[source]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Date</span>
                  <div className="flex flex-wrap gap-1">
                    {(Object.keys(dateLabels) as RunFilterDatePreset[]).map((date) => (
                      <button
                        key={date}
                        type="button"
                        className={cn(
                          "rounded-md border px-2 py-1 text-xs transition-colors",
                          state.date === date ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground",
                        )}
                        onClick={() => onChange({ date })}
                      >
                        {dateLabels[date]}
                      </button>
                    ))}
                  </div>
                  {state.date === "custom" && (
                    <div className="grid gap-1.5 pt-1">
                      <label className="grid gap-1 text-[11px] text-muted-foreground">
                        <span>From</span>
                        <Input
                          type="datetime-local"
                          aria-label="Custom run start time"
                          value={state.customFrom}
                          onChange={(event) => onChange({ date: "custom", customFrom: event.target.value })}
                          className="h-7 px-2 text-xs"
                        />
                      </label>
                      <label className="grid gap-1 text-[11px] text-muted-foreground">
                        <span>To</span>
                        <Input
                          type="datetime-local"
                          aria-label="Custom run end time"
                          value={state.customTo}
                          onChange={(event) => onChange({ date: "custom", customTo: event.target.value })}
                          className="h-7 px-2 text-xs"
                        />
                      </label>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">Context</span>
                <div className="flex flex-wrap gap-1">
                  {(Object.keys(contextLabels) as RunFilterContext[]).map((context) => (
                    <button
                      key={context}
                      type="button"
                      className={cn(
                        "rounded-md border px-2 py-1 text-xs transition-colors",
                        state.contexts.includes(context)
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => onChange({ contexts: toggleValue(state.contexts, context) })}
                    >
                      {contextLabels[context]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">Used skill</span>
                {skillOptions.length > 0 ? (
                  <div className="max-h-28 overflow-y-auto pr-1">
                    <div className="flex flex-wrap gap-1">
                      {skillOptions.map((skill) => (
                        <button
                          key={skill.key}
                          type="button"
                          className={cn(
                            "rounded-md border px-2 py-1 text-xs transition-colors",
                            state.skills.includes(skill.key)
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border text-muted-foreground hover:text-foreground",
                          )}
                          title={skill.key}
                          onClick={() => onChange({ skills: toggleValue(state.skills, skill.key) })}
                        >
                          {skill.label}
                          <span className="ml-1 opacity-70">{skill.count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-border/70 px-2 py-1.5 text-xs text-muted-foreground">
                    No used skills found in loaded runs.
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">Cost & duration</span>
                <div className="flex flex-wrap gap-1">
                  {(Object.keys(costLabels) as RunFilterCostPreset[]).map((cost) => (
                    <button
                      key={cost}
                      type="button"
                      className={cn(
                        "rounded-md border px-2 py-1 text-xs transition-colors",
                        state.cost.includes(cost)
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => onChange({ cost: toggleValue(state.cost, cost) })}
                    >
                      {costLabels[cost]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                <span>{filteredCount} matching run{filteredCount === 1 ? "" : "s"}</span>
                <span>{formatCompactTokenLabel(runs.reduce((total, run) => total + runMetrics(run).totalTokens, 0))} total tokens loaded</span>
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {activeFilterCount > 0 && (
          <button type="button" className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClear} aria-label="Clear run filters">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
