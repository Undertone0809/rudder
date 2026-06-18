import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  hasTokenUsage,
  summarizeTokenUsage,
  type BudgetPolicySummary,
  type CostByAgent,
  type CostByAgentModel,
  type CostByBiller,
  type CostByProject,
  type CostByProviderModel,
  type CostTrendPoint,
  type CostWindowSpendRow,
  type FinanceEvent,
  type QuotaWindow,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, Coins, DollarSign, ReceiptText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { budgetsApi } from "../api/budgets";
import { costsApi } from "../api/costs";
import { AgentIdentity } from "../components/AgentAvatar";
import { BillerSpendCard } from "../components/BillerSpendCard";
import { BudgetIncidentCard } from "../components/BudgetIncidentCard";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { EmptyState } from "../components/EmptyState";
import { FinanceBillerCard } from "../components/FinanceBillerCard";
import { FinanceKindCard } from "../components/FinanceKindCard";
import { FinanceTimelineCard } from "../components/FinanceTimelineCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { ProviderQuotaCard } from "../components/ProviderQuotaCard";
import { StatusBadge } from "../components/StatusBadge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { PRESET_KEYS, PRESET_LABELS, useDateRange } from "../hooks/useDateRange";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { queryKeys } from "../lib/queryKeys";
import { billingTypeDisplayName, cn, formatCents, formatTokens, providerDisplayName } from "../lib/utils";

const NO_ORGANIZATION = "__none__";

type CostTrendFilterKind = "all" | "agent" | "project";

type AgentTrendSeries = {
  agent: CostByAgent;
  rows: CostTrendPoint[];
};

type CostTrendScaleTick = {
  value: number;
  label: string;
  position: number;
};

const agentTrendPalette = [
  "#2563eb",
  "#f97316",
  "#10b981",
  "#8b5cf6",
  "#06b6d4",
  "#e11d48",
  "#f59e0b",
  "#64748b",
  "#14b8a6",
  "#a855f7",
  "#0f766e",
  "#737373",
];

function currentWeekRange(): { from: string; to: string } {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMon, 0, 0, 0, 0);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6, 23, 59, 59, 999);
  return { from: mon.toISOString(), to: sun.toISOString() };
}

function ProviderTabLabel({ provider, rows }: { provider: string; rows: CostByProviderModel[] }) {
  const totalTokens = rows.reduce((sum, row) => sum + summarizeTokenUsage(row).totalTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.costCents, 0);
  return (
    <span className="flex items-center gap-1.5">
      <span>{providerDisplayName(provider)}</span>
      <span className="font-mono text-xs text-muted-foreground">{formatTokens(totalTokens)}</span>
      <span className="text-xs text-muted-foreground">{formatCents(totalCost)}</span>
    </span>
  );
}

function BillerTabLabel({ biller, rows }: { biller: string; rows: CostByBiller[] }) {
  const totalTokens = rows.reduce((sum, row) => sum + summarizeTokenUsage(row).totalTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.costCents, 0);
  return (
    <span className="flex items-center gap-1.5">
      <span>{providerDisplayName(biller)}</span>
      <span className="font-mono text-xs text-muted-foreground">{formatTokens(totalTokens)}</span>
      <span className="text-xs text-muted-foreground">{formatCents(totalCost)}</span>
    </span>
  );
}

function MetricTile({
  label,
  value,
  subtitle,
  icon: Icon,
}: {
  label: string;
  value: string;
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-[calc(var(--radius-sm)-1px)] border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{subtitle}</div>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] border border-border">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

function utcDayKey(value: string | Date): string {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayLabel(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function fullDayLabel(value: string): string {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function emptyTrendPoint(date: string): CostTrendPoint {
  return {
    date,
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    eventCount: 0,
  };
}

function buildTrendSeries(rows: CostTrendPoint[], from?: string, to?: string): CostTrendPoint[] {
  if (!from || !to) return rows;

  const start = new Date(from);
  const end = new Date(to);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return rows;

  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const dayCount = Math.floor((endUtc - startUtc) / 86_400_000) + 1;
  if (dayCount <= 0 || dayCount > 62) return rows;

  const rowsByDate = new Map(rows.map((row) => [row.date, row]));
  return Array.from({ length: dayCount }, (_, index) => {
    const date = utcDayKey(new Date(startUtc + index * 86_400_000));
    return rowsByDate.get(date) ?? emptyTrendPoint(date);
  });
}

function shouldShowDayLabel(index: number, count: number): boolean {
  if (count <= 10) return true;
  return index === 0 || index === count - 1 || index === Math.floor((count - 1) / 2);
}

function hasCostTrendActivity(row: CostTrendPoint): boolean {
  return row.totalTokens > 0 || row.costCents > 0;
}

export function calculateCostTrendInitialScrollLeft({
  dayCount,
  targetDayIndex,
  scrollWidth,
  clientWidth,
  axisWidth = 32,
  trailingPadding = 12,
}: {
  dayCount: number;
  targetDayIndex: number;
  scrollWidth: number;
  clientWidth: number;
  axisWidth?: number;
  trailingPadding?: number;
}): number {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  if (dayCount <= 0 || targetDayIndex < 0 || scrollWidth <= 0 || clientWidth <= 0 || maxScrollLeft <= 0) return 0;

  const boundedTargetDayIndex = Math.min(targetDayIndex, dayCount - 1);
  const plotWidth = Math.max(0, scrollWidth - axisWidth);
  const targetDayRightEdge = axisWidth + ((boundedTargetDayIndex + 1) / dayCount) * plotWidth;
  const desiredScrollLeft = targetDayRightEdge - clientWidth + trailingPadding;

  return Math.min(maxScrollLeft, Math.max(0, Math.ceil(desiredScrollLeft)));
}

function formatExactCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatTrendTokenCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatExactCount(value);
}

function buildTokenScale(maxValue: number): CostTrendScaleTick[] {
  const maxTick = Math.max(1, Math.ceil(maxValue));
  const middleTick = Math.round(maxTick / 2);
  return [maxTick, middleTick, 0]
    .filter((value, index, values) => values.indexOf(value) === index)
    .map((value) => ({
      value,
      label: formatTrendTokenCount(value),
      position: value / maxTick,
    }));
}

function chartColumnMotionStyle(index: number): CSSProperties {
  return { "--dashboard-chart-index": index } as CSSProperties;
}

function CostTrendScaleLabels({ ticks }: { ticks: CostTrendScaleTick[] }) {
  return (
    <div className="relative h-44" aria-hidden="true" data-testid="cost-trend-scale">
      {ticks.map((tick) => (
        <span
          key={`${tick.value}:${tick.label}`}
          className="absolute right-0 translate-y-1/2 text-[9px] leading-none text-muted-foreground/50 tabular-nums"
          style={{ bottom: `${tick.position * 100}%` }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}

function CostTrendGridLines({ ticks }: { ticks: CostTrendScaleTick[] }) {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {ticks.map((tick) => (
        <span
          key={`${tick.value}:${tick.label}`}
          className="absolute left-0 right-0 border-t border-border/35"
          style={{ bottom: `${tick.position * 100}%` }}
        />
      ))}
    </div>
  );
}

function CostTrendLegend({
  items,
  className,
}: {
  items: { color: string; label: string }[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-x-2.5 gap-y-1", className)}>
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
          <span className="max-w-36 truncate">{item.label}</span>
        </span>
      ))}
    </div>
  );
}

function trendAgentLabel(row: CostByAgent): string {
  return row.agentName ?? row.agentId;
}

function trendProjectLabel(row: CostByProject): string {
  return row.projectName ?? row.projectId ?? "Unattributed";
}

export function CostTrendChart({
  rows,
  from,
  to,
  agentSeries = [],
  agentOptions = [],
  projectOptions = [],
  filterKind = "all",
  selectedProjectId = "",
  onFilterKindChange,
  onProjectChange,
  isLoading = false,
}: {
  rows: CostTrendPoint[];
  from?: string;
  to?: string;
  agentSeries?: AgentTrendSeries[];
  agentOptions?: CostByAgent[];
  projectOptions?: CostByProject[];
  filterKind?: CostTrendFilterKind;
  selectedProjectId?: string;
  onFilterKindChange?: (kind: CostTrendFilterKind) => void;
  onProjectChange?: (projectId: string) => void;
  isLoading?: boolean;
}) {
  const series = buildTrendSeries(rows, from, to);
  const comparisonSeries = agentSeries.map((entry) => ({
    ...entry,
    rows: buildTrendSeries(entry.rows, from, to),
  }));
  const comparisonDays = comparisonSeries[0]?.rows.map((row) => row.date) ?? series.map((row) => row.date);
  const comparisonRowsByAgent = new Map(
    comparisonSeries.map((entry) => [entry.agent.agentId, new Map(entry.rows.map((row) => [row.date, row]))]),
  );
  const isAgentComparison = filterKind === "agent";
  const totalTokens = isAgentComparison
    ? comparisonSeries.reduce((sum, entry) => sum + entry.rows.reduce((entrySum, row) => entrySum + row.totalTokens, 0), 0)
    : series.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalCost = isAgentComparison
    ? comparisonSeries.reduce((sum, entry) => sum + entry.rows.reduce((entrySum, row) => entrySum + row.costCents, 0), 0)
    : series.reduce((sum, row) => sum + row.costCents, 0);
  const hasData = totalTokens > 0 || totalCost > 0;
  const activeProjectId = projectOptions.some((row) => row.projectId === selectedProjectId)
    ? selectedProjectId
    : projectOptions[0]?.projectId ?? "";
  const hasAgentOptions = agentOptions.length > 0;
  const hasProjectOptions = projectOptions.length > 0;
  const maxTokens = Math.max(
    ...(isAgentComparison
      ? comparisonSeries.flatMap((entry) => entry.rows.map((row) => row.totalTokens))
      : series.map((row) => row.totalTokens)),
    1,
  );
  const scaleTicks = buildTokenScale(maxTokens);
  const chartMinWidth = isAgentComparison
    ? Math.max(560, comparisonDays.length * Math.max(34, comparisonSeries.length * 10))
    : Math.max(520, series.length * 30);
  const chartDays = isAgentComparison ? comparisonDays : series.map((row) => row.date);
  const latestDataDayIndex = (() => {
    if (isAgentComparison) {
      for (let index = comparisonDays.length - 1; index >= 0; index -= 1) {
        const day = comparisonDays[index]!;
        if (comparisonSeries.some((entry) => {
          const row = comparisonRowsByAgent.get(entry.agent.agentId)?.get(day);
          return row ? hasCostTrendActivity(row) : false;
        })) {
          return index;
        }
      }
      return -1;
    }

    for (let index = series.length - 1; index >= 0; index -= 1) {
      if (hasCostTrendActivity(series[index]!)) return index;
    }
    return -1;
  })();
  const chartScrollRef = useRef<HTMLDivElement | null>(null);
  const chartScrollbarActivityRef = useScrollbarActivityRef();
  const setChartScrollElement = useCallback((element: HTMLDivElement | null) => {
    chartScrollRef.current = element;
    chartScrollbarActivityRef(element);
  }, [chartScrollbarActivityRef]);
  useEffect(() => {
    const element = chartScrollRef.current;
    if (!element || !hasData) return;

    element.scrollLeft = calculateCostTrendInitialScrollLeft({
      dayCount: chartDays.length,
      targetDayIndex: latestDataDayIndex,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    });
  }, [chartDays.length, chartMinWidth, filterKind, hasData, latestDataDayIndex]);
  const tokenLegendItems = [
    { color: "#3b82f6", label: "Uncached input" },
    { color: "#06b6d4", label: "Cached" },
    { color: "#10b981", label: "Output" },
  ];
  const agentLegendItems = comparisonSeries.map((entry, index) => ({
    color: agentTrendPalette[index % agentTrendPalette.length]!,
    label: trendAgentLabel(entry.agent),
  }));
  const chartSubtitle = isAgentComparison
    ? "Daily token usage grouped by agent, with estimated spend in tooltips."
    : "Daily token volume and estimated spend in the selected period.";

  return (
    <div className="space-y-4 rounded-lg border border-border p-4" data-testid="cost-trend-chart">
      <div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-xs font-medium text-muted-foreground">Inference trend</h3>
            <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/60">{chartSubtitle}</p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground sm:justify-end">
              <span className="rounded-[calc(var(--radius-sm)-1px)] border border-border px-2.5 py-1">
                Tokens <span className="font-medium text-foreground tabular-nums">{formatTrendTokenCount(totalTokens)}</span>
              </span>
              <span className="rounded-[calc(var(--radius-sm)-1px)] border border-border px-2.5 py-1">
                Estimated spend <span className="font-medium text-foreground tabular-nums">{formatCents(totalCost)}</span>
              </span>
            </div>
            {onFilterKindChange ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {(["all", "agent", "project"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={(kind === "agent" && !hasAgentOptions) || (kind === "project" && !hasProjectOptions)}
                    onClick={() => onFilterKindChange(kind)}
                    className={cn(
                      "rounded-[calc(var(--radius-sm)-1px)] border px-2.5 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                      filterKind === kind
                        ? "border-foreground bg-foreground text-background"
                        : "border-border text-muted-foreground hover:border-foreground/50 hover:text-foreground",
                    )}
                  >
                    {kind === "all" ? "All" : kind === "agent" ? "Agent" : "Project"}
                  </button>
                ))}
                {filterKind === "agent" && hasAgentOptions ? (
                  <span className="rounded-[calc(var(--radius-sm)-1px)] border border-border px-2.5 py-1 text-muted-foreground">
                    {agentOptions.length} agent{agentOptions.length === 1 ? "" : "s"}
                  </span>
                ) : null}
                {filterKind === "project" && hasProjectOptions ? (
                  <select
                    aria-label="Filter trend by project"
                    value={activeProjectId ?? ""}
                    onChange={(event) => onProjectChange?.(event.target.value)}
                    className="h-7 max-w-48 rounded-[calc(var(--radius-sm)-1px)] border border-border bg-background px-2 text-xs text-foreground"
                  >
                    {projectOptions.map((row, index) => (
                      <option key={row.projectId ?? `project-${index}`} value={row.projectId ?? ""}>
                        {trendProjectLabel(row)}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div>
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading trend...</p>
        ) : !hasData ? (
          <p className="text-xs text-muted-foreground">No cost trend yet.</p>
        ) : (
          <TooltipProvider delayDuration={120}>
            <div className="dashboard-chart-motion space-y-3">
              <div ref={setChartScrollElement} className="scrollbar-auto-hide overflow-x-auto pb-1" data-testid="cost-trend-chart-scroll">
                <div style={{ minWidth: chartMinWidth }}>
                  <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-1.5">
                    <CostTrendScaleLabels ticks={scaleTicks} />
                    <div className="relative h-44 min-w-0">
                      <CostTrendGridLines ticks={scaleTicks} />
                      <div className="relative z-10 flex h-full items-end gap-[3px]">
                        {isAgentComparison
                          ? comparisonDays.map((day, dayIndex) => {
                              const dayRows = comparisonSeries.map((entry, agentIndex) => {
                                const row = comparisonRowsByAgent.get(entry.agent.agentId)?.get(day) ?? emptyTrendPoint(day);
                                return { ...entry, row, color: agentTrendPalette[agentIndex % agentTrendPalette.length]! };
                              });
                              const dayTotalTokens = dayRows.reduce((sum, entry) => sum + entry.row.totalTokens, 0);
                              const dayTotalCost = dayRows.reduce((sum, entry) => sum + entry.row.costCents, 0);
                              const dateLabel = fullDayLabel(day);
                              const accessibleLabel = `${dateLabel}: ${dayRows.map((entry) => `${trendAgentLabel(entry.agent)} ${formatTrendTokenCount(entry.row.totalTokens)} tokens, ${formatCents(entry.row.costCents)}`).join("; ")}`;
                              return (
                                <Tooltip key={day}>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label={accessibleLabel}
                                      className="flex h-full min-w-0 flex-1 appearance-none flex-col justify-end rounded-[4px] bg-transparent p-0 text-left transition-colors hover:bg-black/3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                                    >
                                      <span className="flex h-full items-end justify-center gap-[2px] px-0.5">
                                        {dayRows.map((entry, agentIndex) => {
                                          const heightPct = (entry.row.totalTokens / maxTokens) * 100;
                                          return entry.row.totalTokens > 0 ? (
                                            <span
                                              key={entry.agent.agentId}
                                              className="dashboard-chart-bar min-w-[5px] flex-1 rounded-t-[3px]"
                                              style={{
                                                ...chartColumnMotionStyle(dayIndex * Math.max(comparisonSeries.length, 1) + agentIndex),
                                                height: `${heightPct}%`,
                                                minHeight: 2,
                                                backgroundColor: entry.color,
                                              }}
                                            />
                                          ) : (
                                            <span
                                              key={entry.agent.agentId}
                                              className="dashboard-chart-empty-bar min-w-[5px] flex-1 rounded-sm bg-muted/30"
                                              style={chartColumnMotionStyle(dayIndex * Math.max(comparisonSeries.length, 1) + agentIndex)}
                                            />
                                          );
                                        })}
                                      </span>
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" sideOffset={8} className="min-w-[260px] px-3 py-2">
                                    <div className="space-y-2">
                                      <div className="border-b border-background/15 pb-2">
                                        <div className="font-medium text-background">{dateLabel}</div>
                                        <div className="text-[11px] text-background/70">
                                          {formatTrendTokenCount(dayTotalTokens)} tokens · {formatCents(dayTotalCost)} estimated spend
                                        </div>
                                      </div>
                                      <div className="space-y-1.5">
                                        {dayRows.map((entry) => (
                                          <div key={entry.agent.agentId} className="flex items-center justify-between gap-3 text-xs">
                                            <div className="flex min-w-0 items-center gap-1.5 text-background/80">
                                              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} />
                                              <span className="truncate">{trendAgentLabel(entry.agent)}</span>
                                            </div>
                                            <span className="shrink-0 font-medium text-background tabular-nums">
                                              {formatTrendTokenCount(entry.row.totalTokens)} · {formatCents(entry.row.costCents)}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              );
                            })
                          : series.map((row, index) => {
                              const usage = summarizeTokenUsage(row);
                              const tokenHeight = (usage.totalTokens / maxTokens) * 100;
                              const dateLabel = fullDayLabel(row.date);
                              const accessibleLabel = `${dateLabel}: ${formatTrendTokenCount(usage.totalTokens)} tokens (${formatTrendTokenCount(usage.uncachedInputTokens)} uncached input, ${formatTrendTokenCount(usage.cachedInputTokens)} cached, ${formatTrendTokenCount(usage.outputTokens)} output), ${formatCents(row.costCents)} estimated spend, ${formatExactCount(row.eventCount)} events`;
                              return (
                                <Tooltip key={row.date}>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      aria-label={accessibleLabel}
                                      className="flex h-full min-w-0 flex-1 appearance-none flex-col justify-end rounded-[4px] bg-transparent p-0 text-left transition-colors hover:bg-black/3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                                    >
                                      {usage.totalTokens > 0 ? (
                                        <span
                                          className="dashboard-chart-bar flex flex-col-reverse gap-px overflow-hidden"
                                          style={{ ...chartColumnMotionStyle(index), height: `${tokenHeight}%`, minHeight: 2 }}
                                        >
                                          {usage.uncachedInputTokens > 0 ? (
                                            <span className="bg-blue-500" style={{ flex: usage.uncachedInputTokens }} />
                                          ) : null}
                                          {usage.cachedInputTokens > 0 ? (
                                            <span className="bg-cyan-500" style={{ flex: usage.cachedInputTokens }} />
                                          ) : null}
                                          {usage.outputTokens > 0 ? (
                                            <span className="bg-emerald-500" style={{ flex: usage.outputTokens }} />
                                          ) : null}
                                        </span>
                                      ) : (
                                        <span
                                          className="dashboard-chart-empty-bar rounded-sm bg-muted/30"
                                          style={{ ...chartColumnMotionStyle(index), height: 2 }}
                                        />
                                      )}
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" sideOffset={8} className="min-w-[220px] px-3 py-2">
                                    <div className="space-y-2">
                                      <div className="border-b border-background/15 pb-2">
                                        <div className="font-medium text-background">{dateLabel}</div>
                                        <div className="text-[11px] text-background/70">
                                          {formatTrendTokenCount(usage.totalTokens)} tokens · {formatCents(row.costCents)} estimated spend
                                        </div>
                                      </div>
                                      <div className="space-y-1.5">
                                        <div className="flex items-center justify-between gap-3 text-xs">
                                          <span className="text-background/80">Uncached input</span>
                                          <span className="font-medium text-background">{formatTrendTokenCount(usage.uncachedInputTokens)}</span>
                                        </div>
                                        <div className="flex items-center justify-between gap-3 text-xs">
                                          <span className="text-background/80">Cached</span>
                                          <span className="font-medium text-background">{formatTrendTokenCount(usage.cachedInputTokens)}</span>
                                        </div>
                                        <div className="flex items-center justify-between gap-3 text-xs">
                                          <span className="text-background/80">Output</span>
                                          <span className="font-medium text-background">{formatTrendTokenCount(usage.outputTokens)}</span>
                                        </div>
                                        <div className="flex items-center justify-between gap-3 text-xs">
                                          <span className="text-background/80">Events</span>
                                          <span className="font-medium text-background">{formatExactCount(row.eventCount)}</span>
                                        </div>
                                      </div>
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              );
                            })}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-1.5">
                    <div aria-hidden="true" />
                    <div className="mt-1.5 flex gap-[3px]">
                      {(isAgentComparison ? comparisonDays : series.map((row) => row.date)).map((day, index, days) => (
                        <div key={day} className="flex-1 text-center">
                          {shouldShowDayLabel(index, days.length) ? (
                            <span className="text-[9px] text-muted-foreground tabular-nums">{dayLabel(day)}</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <CostTrendLegend items={isAgentComparison ? agentLegendItems : tokenLegendItems} />
            </div>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}

function FinanceSummaryCard({
  debitCents,
  creditCents,
  netCents,
  estimatedDebitCents,
  eventCount,
}: {
  debitCents: number;
  creditCents: number;
  netCents: number;
  estimatedDebitCents: number;
  eventCount: number;
}) {
  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Finance ledger</CardTitle>
        <CardDescription>
          Account-level charges that do not map to a single inference request.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 pb-5 pt-2 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Debits"
          value={formatCents(debitCents)}
          subtitle={`${eventCount} total event${eventCount === 1 ? "" : "s"} in range`}
          icon={ArrowUpRight}
        />
        <MetricTile
          label="Credits"
          value={formatCents(creditCents)}
          subtitle="Refunds, offsets, and credit returns"
          icon={ArrowDownLeft}
        />
        <MetricTile
          label="Net"
          value={formatCents(netCents)}
          subtitle="Debit minus credit for the selected period"
          icon={ReceiptText}
        />
        <MetricTile
          label="Estimated"
          value={formatCents(estimatedDebitCents)}
          subtitle="Estimated debits that are not yet invoice-authoritative"
          icon={Coins}
        />
      </CardContent>
    </Card>
  );
}

export function Costs() {
  const { selectedOrganizationId } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { confirm } = useDialog();
  const queryClient = useQueryClient();

  const [mainTab, setMainTab] = useState<"overview" | "budgets" | "providers" | "billers" | "finance">("overview");
  const [activeProvider, setActiveProvider] = useState("all");
  const [activeBiller, setActiveBiller] = useState("all");
  const [trendFilterKind, setTrendFilterKind] = useState<CostTrendFilterKind>("all");
  const [trendProjectId, setTrendProjectId] = useState("");

  const {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    from,
    to,
    customReady,
  } = useDateRange();

  useEffect(() => {
    setBreadcrumbs([{ label: "Costs" }]);
  }, [setBreadcrumbs]);

  const [today, setToday] = useState(() => new Date().toDateString());
  const todayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const schedule = () => {
      const now = new Date();
      const ms = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
      todayTimerRef.current = setTimeout(() => {
        setToday(new Date().toDateString());
        schedule();
      }, ms);
    };
    schedule();
    return () => {
      if (todayTimerRef.current != null) clearTimeout(todayTimerRef.current);
    };
  }, []);

  const weekRange = useMemo(() => currentWeekRange(), [today]);
  const orgId = selectedOrganizationId ?? NO_ORGANIZATION;

  const { data: budgetData, isLoading: budgetLoading, error: budgetError } = useQuery({
    queryKey: queryKeys.budgets.overview(orgId),
    queryFn: () => budgetsApi.overview(orgId),
    enabled: !!selectedOrganizationId && customReady,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const invalidateBudgetViews = () => {
    if (!selectedOrganizationId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(selectedOrganizationId) });
    queryClient.invalidateQueries({ queryKey: ["costs", selectedOrganizationId] });
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedOrganizationId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedOrganizationId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedOrganizationId) });
  };

  const policyMutation = useMutation({
    mutationFn: (input: {
      scopeType: BudgetPolicySummary["scopeType"];
      scopeId: string;
      amount: number;
      windowKind: BudgetPolicySummary["windowKind"];
    }) =>
      budgetsApi.upsertPolicy(orgId, {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        amount: input.amount,
        windowKind: input.windowKind,
      }),
    onSuccess: invalidateBudgetViews,
  });

  const deletePolicyMutation = useMutation({
    mutationFn: (policyId: string) => budgetsApi.deletePolicy(orgId, policyId),
    onSuccess: invalidateBudgetViews,
  });

  const confirmAndDeletePolicy = useCallback(async (summary: BudgetPolicySummary) => {
    const confirmed = await confirm({
      title: `Delete ${summary.scopeName} budget?`,
      description: "This removes the budget cap and resolves any open budget stop for this scope.",
      confirmLabel: "Delete budget",
      cancelLabel: "Cancel",
      tone: "destructive",
    });
    if (!confirmed) return;
    deletePolicyMutation.mutate(summary.policyId);
  }, [confirm, deletePolicyMutation]);

  const incidentMutation = useMutation({
    mutationFn: (input: { incidentId: string; action: "keep_paused" | "raise_budget_and_resume"; amount?: number }) =>
      budgetsApi.resolveIncident(orgId, input.incidentId, input),
    onSuccess: invalidateBudgetViews,
  });

  const { data: spendData, isLoading: spendLoading, error: spendError } = useQuery({
    queryKey: queryKeys.costs(orgId, from || undefined, to || undefined),
    queryFn: async () => {
      const [summary, byAgent, byProject, byAgentModel] = await Promise.all([
        costsApi.summary(orgId, from || undefined, to || undefined),
        costsApi.byAgent(orgId, from || undefined, to || undefined),
        costsApi.byProject(orgId, from || undefined, to || undefined),
        costsApi.byAgentModel(orgId, from || undefined, to || undefined),
      ]);
      return { summary, byAgent, byProject, byAgentModel };
    },
    enabled: !!selectedOrganizationId && customReady,
  });

  const { data: financeData, isLoading: financeLoading, error: financeError } = useQuery({
    queryKey: [
      queryKeys.financeSummary(orgId, from || undefined, to || undefined),
      queryKeys.financeByBiller(orgId, from || undefined, to || undefined),
      queryKeys.financeByKind(orgId, from || undefined, to || undefined),
      queryKeys.financeEvents(orgId, from || undefined, to || undefined, 18),
    ],
    queryFn: async () => {
      const [summary, byBiller, byKind, events] = await Promise.all([
        costsApi.financeSummary(orgId, from || undefined, to || undefined),
        costsApi.financeByBiller(orgId, from || undefined, to || undefined),
        costsApi.financeByKind(orgId, from || undefined, to || undefined),
        costsApi.financeEvents(orgId, from || undefined, to || undefined, 18),
      ]);
      return { summary, byBiller, byKind, events };
    },
    enabled: !!selectedOrganizationId && customReady,
  });

  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  useEffect(() => {
    setExpandedAgents(new Set());
  }, [orgId, from, to]);

  function toggleAgent(agentId: string) {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  const agentModelRows = useMemo(() => {
    const map = new Map<string, CostByAgentModel[]>();
    for (const row of spendData?.byAgentModel ?? []) {
      const rows = map.get(row.agentId) ?? [];
      rows.push(row);
      map.set(row.agentId, rows);
    }
    for (const [agentId, rows] of map) {
      map.set(agentId, rows.slice().sort((a, b) => b.costCents - a.costCents));
    }
    return map;
  }, [spendData?.byAgentModel]);

  const trendAgentOptions = useMemo(
    () => (spendData?.byAgent ?? []).filter((row) => hasTokenUsage(row) || row.costCents > 0),
    [spendData?.byAgent],
  );
  const trendProjectOptions = useMemo(
    () => (spendData?.byProject ?? []).filter((row) => row.projectId && (hasTokenUsage(row) || row.costCents > 0)),
    [spendData?.byProject],
  );
  const effectiveTrendProjectId = trendProjectOptions.some((row) => row.projectId === trendProjectId)
    ? trendProjectId
    : trendProjectOptions[0]?.projectId ?? "";
  const effectiveTrendFilterKind =
    trendFilterKind === "agent" && trendAgentOptions.length > 0
      ? "agent"
      : trendFilterKind === "project" && effectiveTrendProjectId
        ? "project"
        : "all";
  const trendFilterId =
    effectiveTrendFilterKind === "project"
      ? effectiveTrendProjectId
      : "";

  const { data: trendData, isLoading: trendLoading, error: trendError } = useQuery({
    queryKey: queryKeys.costTrend(
      orgId,
      from || undefined,
      to || undefined,
      effectiveTrendFilterKind,
      trendFilterId,
    ),
    queryFn: () =>
      costsApi.trend(
        orgId,
        from || undefined,
        to || undefined,
        effectiveTrendFilterKind === "project"
            ? { projectId: trendFilterId }
            : undefined,
      ),
    enabled: !!selectedOrganizationId && customReady && effectiveTrendFilterKind !== "agent",
  });

  const { data: agentTrendData, isLoading: agentTrendLoading, error: agentTrendError } = useQuery({
    queryKey: [
      "costs",
      "trend-agent-comparison",
      orgId,
      from || undefined,
      to || undefined,
      trendAgentOptions.map((row) => row.agentId).join(","),
    ],
    queryFn: async () => {
      const rows = await Promise.all(
        trendAgentOptions.map(async (agent) => ({
          agent,
          rows: await costsApi.trend(orgId, from || undefined, to || undefined, { agentId: agent.agentId }),
        })),
      );
      return rows;
    },
    enabled: !!selectedOrganizationId && customReady && effectiveTrendFilterKind === "agent" && trendAgentOptions.length > 0,
  });

  const { data: providerData } = useQuery({
    queryKey: queryKeys.usageByProvider(orgId, from || undefined, to || undefined),
    queryFn: () => costsApi.byProvider(orgId, from || undefined, to || undefined),
    enabled: !!selectedOrganizationId && customReady && (mainTab === "providers" || mainTab === "billers"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: billerData } = useQuery({
    queryKey: queryKeys.usageByBiller(orgId, from || undefined, to || undefined),
    queryFn: () => costsApi.byBiller(orgId, from || undefined, to || undefined),
    enabled: !!selectedOrganizationId && customReady && mainTab === "billers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: weekData } = useQuery({
    queryKey: queryKeys.usageByProvider(orgId, weekRange.from, weekRange.to),
    queryFn: () => costsApi.byProvider(orgId, weekRange.from, weekRange.to),
    enabled: !!selectedOrganizationId && (mainTab === "providers" || mainTab === "billers"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: weekBillerData } = useQuery({
    queryKey: queryKeys.usageByBiller(orgId, weekRange.from, weekRange.to),
    queryFn: () => costsApi.byBiller(orgId, weekRange.from, weekRange.to),
    enabled: !!selectedOrganizationId && mainTab === "billers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: windowData } = useQuery({
    queryKey: queryKeys.usageWindowSpend(orgId),
    queryFn: () => costsApi.windowSpend(orgId),
    enabled: !!selectedOrganizationId && mainTab === "providers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: quotaData, isLoading: quotaLoading } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(orgId),
    queryFn: () => costsApi.quotaWindows(orgId),
    enabled: !!selectedOrganizationId && mainTab === "providers",
    refetchInterval: 300_000,
    staleTime: 60_000,
  });

  const byProvider = useMemo(() => {
    const map = new Map<string, CostByProviderModel[]>();
    for (const row of providerData ?? []) {
      const rows = map.get(row.provider) ?? [];
      rows.push(row);
      map.set(row.provider, rows);
    }
    return map;
  }, [providerData]);

  const byBiller = useMemo(() => {
    const map = new Map<string, CostByBiller[]>();
    for (const row of billerData ?? []) {
      const rows = map.get(row.biller) ?? [];
      rows.push(row);
      map.set(row.biller, rows);
    }
    return map;
  }, [billerData]);

  const weekSpendByProvider = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of weekData ?? []) {
      map.set(row.provider, (map.get(row.provider) ?? 0) + row.costCents);
    }
    return map;
  }, [weekData]);

  const weekSpendByBiller = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of weekBillerData ?? []) {
      map.set(row.biller, (map.get(row.biller) ?? 0) + row.costCents);
    }
    return map;
  }, [weekBillerData]);

  const windowSpendByProvider = useMemo(() => {
    const map = new Map<string, CostWindowSpendRow[]>();
    for (const row of windowData ?? []) {
      const rows = map.get(row.provider) ?? [];
      rows.push(row);
      map.set(row.provider, rows);
    }
    return map;
  }, [windowData]);

  const quotaWindowsByProvider = useMemo(() => {
    const map = new Map<string, QuotaWindow[]>();
    for (const result of quotaData ?? []) {
      if (result.ok && result.windows.length > 0) {
        map.set(result.provider, result.windows);
      }
    }
    return map;
  }, [quotaData]);

  const quotaErrorsByProvider = useMemo(() => {
    const map = new Map<string, string>();
    for (const result of quotaData ?? []) {
      if (!result.ok && result.error) map.set(result.provider, result.error);
    }
    return map;
  }, [quotaData]);

  const quotaSourcesByProvider = useMemo(() => {
    const map = new Map<string, string>();
    for (const result of quotaData ?? []) {
      if (typeof result.source === "string" && result.source.length > 0) {
        map.set(result.provider, result.source);
      }
    }
    return map;
  }, [quotaData]);

  const deficitNotchByProvider = useMemo(() => {
    const map = new Map<string, boolean>();
    if (preset !== "mtd") return map;
    const budget = spendData?.summary.budgetCents ?? 0;
    if (budget <= 0) return map;
    const totalSpend = spendData?.summary.spendCents ?? 0;
    const now = new Date();
    const daysElapsed = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (const [providerKey, rows] of byProvider) {
      const providerCostCents = rows.reduce((sum, row) => sum + row.costCents, 0);
      const providerShare = totalSpend > 0 ? providerCostCents / totalSpend : 0;
      const providerBudget = budget * providerShare;
      if (providerBudget <= 0) {
        map.set(providerKey, false);
        continue;
      }
      const burnRate = providerCostCents / Math.max(daysElapsed, 1);
      map.set(providerKey, providerCostCents + burnRate * (daysInMonth - daysElapsed) > providerBudget);
    }
    return map;
  }, [preset, spendData, byProvider]);

  const providers = useMemo(() => Array.from(byProvider.keys()), [byProvider]);
  const billers = useMemo(() => Array.from(byBiller.keys()), [byBiller]);

  const effectiveProvider =
    activeProvider === "all" || providers.includes(activeProvider) ? activeProvider : "all";
  useEffect(() => {
    if (effectiveProvider !== activeProvider) setActiveProvider("all");
  }, [effectiveProvider, activeProvider]);

  const effectiveBiller =
    activeBiller === "all" || billers.includes(activeBiller) ? activeBiller : "all";
  useEffect(() => {
    if (effectiveBiller !== activeBiller) setActiveBiller("all");
  }, [effectiveBiller, activeBiller]);

  const providerTabItems = useMemo(() => {
    const providerKeys = Array.from(byProvider.keys());
    const allTokens = providerKeys.reduce(
      (sum, provider) => sum + (byProvider.get(provider)?.reduce((acc, row) => acc + summarizeTokenUsage(row).totalTokens, 0) ?? 0),
      0,
    );
    const allCents = providerKeys.reduce(
      (sum, provider) => sum + (byProvider.get(provider)?.reduce((acc, row) => acc + row.costCents, 0) ?? 0),
      0,
    );
    return [
      {
        value: "all",
        label: (
          <span className="flex items-center gap-1.5">
            <span>All providers</span>
            {providerKeys.length > 0 ? (
              <>
                <span className="font-mono text-xs text-muted-foreground">{formatTokens(allTokens)}</span>
                <span className="text-xs text-muted-foreground">{formatCents(allCents)}</span>
              </>
            ) : null}
          </span>
        ),
      },
      ...providerKeys.map((provider) => ({
        value: provider,
        label: <ProviderTabLabel provider={provider} rows={byProvider.get(provider) ?? []} />,
      })),
    ];
  }, [byProvider]);

  const billerTabItems = useMemo(() => {
    const billerKeys = Array.from(byBiller.keys());
    const allTokens = billerKeys.reduce(
      (sum, biller) => sum + (byBiller.get(biller)?.reduce((acc, row) => acc + summarizeTokenUsage(row).totalTokens, 0) ?? 0),
      0,
    );
    const allCents = billerKeys.reduce(
      (sum, biller) => sum + (byBiller.get(biller)?.reduce((acc, row) => acc + row.costCents, 0) ?? 0),
      0,
    );
    return [
      {
        value: "all",
        label: (
          <span className="flex items-center gap-1.5">
            <span>All billers</span>
            {billerKeys.length > 0 ? (
              <>
                <span className="font-mono text-xs text-muted-foreground">{formatTokens(allTokens)}</span>
                <span className="text-xs text-muted-foreground">{formatCents(allCents)}</span>
              </>
            ) : null}
          </span>
        ),
      },
      ...billerKeys.map((biller) => ({
        value: biller,
        label: <BillerTabLabel biller={biller} rows={byBiller.get(biller) ?? []} />,
      })),
    ];
  }, [byBiller]);

  const inferenceTokenTotal =
    (spendData?.byAgent ?? []).reduce(
      (sum, row) => sum + summarizeTokenUsage(row).totalTokens,
      0,
    );

  const topFinanceEvents = (financeData?.events ?? []) as FinanceEvent[];
  const budgetPolicies = budgetData?.policies ?? [];
  const activeBudgetIncidents = budgetData?.activeIncidents ?? [];
  const budgetPoliciesByScope = useMemo(() => ({
    organization: budgetPolicies.filter((policy) => policy.scopeType === "organization"),
    agent: budgetPolicies.filter((policy) => policy.scopeType === "agent"),
    project: budgetPolicies.filter((policy) => policy.scopeType === "project"),
  }), [budgetPolicies]);

  if (!selectedOrganizationId) {
    return <EmptyState icon={DollarSign} message="Select a organization to view costs." />;
  }

  const showCustomPrompt = preset === "custom" && !customReady;
  const showOverviewLoading = (spendLoading || financeLoading) && customReady;
  const overviewError = spendError ?? financeError ?? (effectiveTrendFilterKind === "agent" ? agentTrendError : trendError);

  return (
    <div className="space-y-6">
      <div className="space-y-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
                <h1 className="text-3xl font-semibold tracking-tight">Costs</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Inference spend, platform fees, credits, and live quota windows.
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {PRESET_KEYS.map((key) => (
                <Button
                  key={key}
                  variant={preset === key ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setPreset(key)}
                >
                  {PRESET_LABELS[key]}
                </Button>
              ))}
            </div>
          </div>

          {preset === "custom" ? (
            <div className="flex flex-wrap items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] border border-border p-3">
              <input
                type="date"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              />
            </div>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-4">
            <MetricTile
              label="Inference spend"
              value={formatCents(spendData?.summary.spendCents ?? 0)}
              subtitle={`${formatTokens(inferenceTokenTotal)} tokens across request-scoped events`}
              icon={DollarSign}
            />
            <MetricTile
              label="Budget"
              value={activeBudgetIncidents.length > 0 ? String(activeBudgetIncidents.length) : (
                spendData?.summary.budgetCents && spendData.summary.budgetCents > 0
                  ? `${spendData.summary.utilizationPercent}%`
                  : "Open"
              )}
              subtitle={
                activeBudgetIncidents.length > 0
                  ? `${budgetData?.pausedAgentCount ?? 0} agents paused · ${budgetData?.pausedProjectCount ?? 0} projects paused`
                  : spendData?.summary.budgetCents && spendData.summary.budgetCents > 0
                    ? `${formatCents(spendData.summary.spendCents)} of ${formatCents(spendData.summary.budgetCents)}`
                    : "No monthly cap configured"
              }
              icon={Coins}
            />
            <MetricTile
              label="Finance net"
              value={formatCents(financeData?.summary.netCents ?? 0)}
              subtitle={`${formatCents(financeData?.summary.debitCents ?? 0)} debits · ${formatCents(financeData?.summary.creditCents ?? 0)} credits`}
              icon={ReceiptText}
            />
            <MetricTile
              label="Finance events"
              value={String(financeData?.summary.eventCount ?? 0)}
              subtitle={`${formatCents(financeData?.summary.estimatedDebitCents ?? 0)} estimated in range`}
              icon={ArrowUpRight}
            />
          </div>
      </div>

      <Tabs value={mainTab} onValueChange={(value) => setMainTab(value as typeof mainTab)}>
        <PageTabBar
          items={[
            { value: "overview", label: "Overview" },
            { value: "budgets", label: "Budgets" },
            { value: "providers", label: "Providers" },
            { value: "billers", label: "Billers" },
            { value: "finance", label: "Finance" },
          ]}
          value={mainTab}
          onValueChange={(value) => setMainTab(value as typeof mainTab)}
          align="start"
        />

        <TabsContent value="overview" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : showOverviewLoading ? (
            <PageSkeleton variant="costs" />
          ) : overviewError ? (
            <p className="text-sm text-destructive">{(overviewError as Error).message}</p>
          ) : (
            <>
              {activeBudgetIncidents.length > 0 ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  {activeBudgetIncidents.slice(0, 2).map((incident) => (
                    <BudgetIncidentCard
                      key={incident.id}
                      incident={incident}
                      isMutating={incidentMutation.isPending}
                      onKeepPaused={() => incidentMutation.mutate({ incidentId: incident.id, action: "keep_paused" })}
                      onRaiseAndResume={(amount) =>
                        incidentMutation.mutate({
                          incidentId: incident.id,
                          action: "raise_budget_and_resume",
                          amount,
                        })}
                    />
                  ))}
                </div>
              ) : null}

              <CostTrendChart
                rows={trendData ?? []}
                from={from || undefined}
                to={to || undefined}
                agentSeries={agentTrendData ?? []}
                agentOptions={trendAgentOptions}
                projectOptions={trendProjectOptions}
                filterKind={effectiveTrendFilterKind}
                selectedProjectId={effectiveTrendProjectId}
                onFilterKindChange={(kind) => {
                  if (kind === "project" && effectiveTrendProjectId) setTrendProjectId(effectiveTrendProjectId);
                  setTrendFilterKind(kind);
                }}
                onProjectChange={(projectId) => {
                  setTrendProjectId(projectId);
                  setTrendFilterKind("project");
                }}
                isLoading={effectiveTrendFilterKind === "agent" ? agentTrendLoading : trendLoading}
              />

              <FinanceSummaryCard
                debitCents={financeData?.summary.debitCents ?? 0}
                creditCents={financeData?.summary.creditCents ?? 0}
                netCents={financeData?.summary.netCents ?? 0}
                estimatedDebitCents={financeData?.summary.estimatedDebitCents ?? 0}
                eventCount={financeData?.summary.eventCount ?? 0}
              />

              <Card>
                <CardHeader className="px-5 pt-5 pb-2">
                  <CardTitle className="text-base">By agent</CardTitle>
                  <CardDescription>What each agent consumed in the selected period.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 px-5 pb-5 pt-2">
                  {(spendData?.byAgent.length ?? 0) === 0 ? (
                    <p className="text-sm text-muted-foreground">No cost events yet.</p>
                  ) : (
                    spendData?.byAgent.map((row) => {
                      const modelRows = agentModelRows.get(row.agentId) ?? [];
                      const isExpanded = expandedAgents.has(row.agentId);
                      const hasBreakdown = modelRows.length > 0;
                      return (
                        <div key={row.agentId} className="rounded-[calc(var(--radius-sm)-1px)] border border-border px-4 py-3">
                          <div
                            className={cn("flex items-start justify-between gap-3", hasBreakdown ? "cursor-pointer select-none" : "")}
                            onClick={() => hasBreakdown && toggleAgent(row.agentId)}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              {hasBreakdown ? (
                                isExpanded
                                  ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                              ) : (
                                <span className="h-3 w-3 shrink-0" />
                              )}
                              <AgentIdentity
                                name={row.agentName ?? row.agentId}
                                icon={row.agentIcon}
                                role={row.agentRole}
                                size="sm"
                              />
                              {row.agentStatus === "terminated" ? <StatusBadge status="terminated" /> : null}
                            </div>
                            <div className="text-right text-sm tabular-nums">
                              <div className="font-medium">{formatCents(row.costCents)}</div>
                              <div className="text-xs text-muted-foreground">
                                in {formatTokens(summarizeTokenUsage(row).promptTokens)} · out {formatTokens(row.outputTokens)}
                              </div>
                              {(row.apiRunCount > 0 || row.subscriptionRunCount > 0) ? (
                                <div className="text-xs text-muted-foreground">
                                  {row.apiRunCount > 0 ? `${row.apiRunCount} api` : "0 api"}
                                  {" · "}
                                  {row.subscriptionRunCount > 0
                                    ? `${row.subscriptionRunCount} subscription`
                                    : "0 subscription"}
                                </div>
                              ) : null}
                            </div>
                          </div>

                          {isExpanded && modelRows.length > 0 ? (
                            <div className="mt-3 space-y-2 border-l border-border pl-4">
                              {modelRows.map((modelRow) => {
                                const sharePct = row.costCents > 0 ? Math.round((modelRow.costCents / row.costCents) * 100) : 0;
                                const modelTokenSummary = summarizeTokenUsage(modelRow);
                                return (
                                  <div
                                    key={`${modelRow.provider}:${modelRow.model}:${modelRow.billingType}`}
                                    className="flex items-start justify-between gap-3 text-xs"
                                  >
                                    <div className="min-w-0">
                                      <div className="truncate font-medium text-foreground">
                                        {providerDisplayName(modelRow.provider)}
                                        <span className="mx-1 text-border">/</span>
                                        <span className="font-mono">{modelRow.model}</span>
                                      </div>
                                      <div className="truncate text-muted-foreground">
                                        {providerDisplayName(modelRow.biller)} · {billingTypeDisplayName(modelRow.billingType)}
                                      </div>
                                    </div>
                                    <div className="text-right tabular-nums">
                                      <div className="font-medium">
                                        {formatCents(modelRow.costCents)}
                                        <span className="ml-1 font-normal text-muted-foreground">({sharePct}%)</span>
                                      </div>
                                      <div className="text-muted-foreground">
                                        {formatTokens(modelTokenSummary.totalTokens)} tok
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="budgets" className="mt-4 space-y-4">
          {budgetLoading ? (
            <PageSkeleton variant="costs" />
          ) : budgetError ? (
            <p className="text-sm text-destructive">{(budgetError as Error).message}</p>
          ) : (
            <>
              <Card className="border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))]">
                <CardHeader className="px-5 pt-5 pb-3">
                  <CardTitle className="text-base">Budget control plane</CardTitle>
                  <CardDescription>
                    Hard-stop spend limits for agents and projects. Provider subscription quota stays separate and appears under Providers.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-4">
                  <MetricTile
                    label="Active incidents"
                    value={String(activeBudgetIncidents.length)}
                    subtitle="Open soft or hard threshold crossings"
                    icon={ReceiptText}
                  />
                  <MetricTile
                    label="Pending approvals"
                    value={String(budgetData?.pendingApprovalCount ?? 0)}
                    subtitle="Budget override approvals awaiting board action"
                    icon={ArrowUpRight}
                  />
                  <MetricTile
                    label="Paused agents"
                    value={String(budgetData?.pausedAgentCount ?? 0)}
                    subtitle="Agent heartbeats blocked by budget"
                    icon={Coins}
                  />
                  <MetricTile
                    label="Paused projects"
                    value={String(budgetData?.pausedProjectCount ?? 0)}
                    subtitle="Project execution blocked by budget"
                    icon={DollarSign}
                  />
                </CardContent>
              </Card>

              {activeBudgetIncidents.length > 0 ? (
                <div className="space-y-3">
                  <div>
                    <h2 className="text-lg font-semibold">Active incidents</h2>
                    <p className="text-sm text-muted-foreground">
                      Resolve hard stops here by raising the budget or explicitly keeping the scope paused.
                    </p>
                  </div>
                  <div className="grid gap-4 xl:grid-cols-2">
                    {activeBudgetIncidents.map((incident) => (
                      <BudgetIncidentCard
                        key={incident.id}
                        incident={incident}
                        isMutating={incidentMutation.isPending}
                        onKeepPaused={() => incidentMutation.mutate({ incidentId: incident.id, action: "keep_paused" })}
                        onRaiseAndResume={(amount) =>
                          incidentMutation.mutate({
                            incidentId: incident.id,
                            action: "raise_budget_and_resume",
                            amount,
                          })}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="space-y-5">
                {(["organization", "agent", "project"] as const).map((scopeType) => {
                  const rows = budgetPoliciesByScope[scopeType];
                  if (rows.length === 0) return null;
                  return (
                    <section key={scopeType} className="space-y-3">
                      <div>
                        <h2 className="text-lg font-semibold capitalize">{scopeType} budgets</h2>
                        <p className="text-sm text-muted-foreground">
                          {scopeType === "organization"
                            ? "Organization-wide monthly policy."
                            : scopeType === "agent"
                              ? "Recurring monthly spend policies for individual agents."
                              : "Lifetime spend policies for execution-bound projects."}
                        </p>
                      </div>
                      <div className="grid gap-4 xl:grid-cols-2">
                        {rows.map((summary) => (
                          <BudgetPolicyCard
                            key={summary.policyId}
                            summary={summary}
                            isSaving={policyMutation.isPending}
                            isDeleting={
                              deletePolicyMutation.isPending
                              && deletePolicyMutation.variables === summary.policyId
                            }
                            onSave={(amount) =>
                              policyMutation.mutate({
                                scopeType: summary.scopeType,
                                scopeId: summary.scopeId,
                                amount,
                                windowKind: summary.windowKind,
                              })}
                            onDelete={() => {
                              void confirmAndDeletePolicy(summary);
                            }}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}

                {budgetPolicies.length === 0 ? (
                  <Card>
                    <CardContent className="px-5 py-8 text-sm text-muted-foreground">
                      No budget policies yet. Set agent and project budgets from their detail pages, or use the existing organization monthly budget control.
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="providers" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : (
            <>
              <Tabs value={effectiveProvider} onValueChange={setActiveProvider}>
                <PageTabBar items={providerTabItems} value={effectiveProvider} />

                <TabsContent value="all" className="mt-4">
                  {providers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No cost events in this period.</p>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      {providers.map((provider) => (
                        <ProviderQuotaCard
                          key={provider}
                          provider={provider}
                          rows={byProvider.get(provider) ?? []}
                          budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                          totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                          weekSpendCents={weekSpendByProvider.get(provider) ?? 0}
                          windowRows={windowSpendByProvider.get(provider) ?? []}
                          showDeficitNotch={deficitNotchByProvider.get(provider) ?? false}
                          quotaWindows={quotaWindowsByProvider.get(provider) ?? []}
                          quotaError={quotaErrorsByProvider.get(provider) ?? null}
                          quotaSource={quotaSourcesByProvider.get(provider) ?? null}
                          quotaLoading={quotaLoading}
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>

                {providers.map((provider) => (
                  <TabsContent key={provider} value={provider} className="mt-4">
                    <ProviderQuotaCard
                      provider={provider}
                      rows={byProvider.get(provider) ?? []}
                      budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                      totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                      weekSpendCents={weekSpendByProvider.get(provider) ?? 0}
                      windowRows={windowSpendByProvider.get(provider) ?? []}
                      showDeficitNotch={deficitNotchByProvider.get(provider) ?? false}
                      quotaWindows={quotaWindowsByProvider.get(provider) ?? []}
                      quotaError={quotaErrorsByProvider.get(provider) ?? null}
                      quotaSource={quotaSourcesByProvider.get(provider) ?? null}
                      quotaLoading={quotaLoading}
                    />
                  </TabsContent>
                ))}
              </Tabs>
            </>
          )}
        </TabsContent>

        <TabsContent value="billers" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : (
            <>
              <Tabs value={effectiveBiller} onValueChange={setActiveBiller}>
                <PageTabBar items={billerTabItems} value={effectiveBiller} />

                <TabsContent value="all" className="mt-4">
                  {billers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No billable events in this period.</p>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      {billers.map((biller) => {
                        const row = (byBiller.get(biller) ?? [])[0];
                        if (!row) return null;
                        const providerRows = (providerData ?? []).filter((entry) => entry.biller === biller);
                        return (
                          <BillerSpendCard
                            key={biller}
                            row={row}
                            weekSpendCents={weekSpendByBiller.get(biller) ?? 0}
                            budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                            totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                            providerRows={providerRows}
                          />
                        );
                      })}
                    </div>
                  )}
                </TabsContent>

                {billers.map((biller) => {
                  const row = (byBiller.get(biller) ?? [])[0];
                  if (!row) return null;
                  const providerRows = (providerData ?? []).filter((entry) => entry.biller === biller);
                  return (
                    <TabsContent key={biller} value={biller} className="mt-4">
                      <BillerSpendCard
                        row={row}
                        weekSpendCents={weekSpendByBiller.get(biller) ?? 0}
                        budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                        totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                        providerRows={providerRows}
                      />
                    </TabsContent>
                  );
                })}
              </Tabs>
            </>
          )}
        </TabsContent>

        <TabsContent value="finance" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : financeLoading ? (
            <PageSkeleton variant="costs" />
          ) : financeError ? (
            <p className="text-sm text-destructive">{(financeError as Error).message}</p>
          ) : (
            <>
              <FinanceSummaryCard
                debitCents={financeData?.summary.debitCents ?? 0}
                creditCents={financeData?.summary.creditCents ?? 0}
                netCents={financeData?.summary.netCents ?? 0}
                estimatedDebitCents={financeData?.summary.estimatedDebitCents ?? 0}
                eventCount={financeData?.summary.eventCount ?? 0}
              />

              <div className="grid gap-4 xl:grid-cols-[1.2fr,0.95fr]">
                <div className="space-y-4">
                  <Card>
                    <CardHeader className="px-5 pt-5 pb-2">
                      <CardTitle className="text-base">By biller</CardTitle>
                      <CardDescription>Account-level financial events grouped by who charged or credited them.</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-4 px-5 pb-5 pt-2 md:grid-cols-2">
                      {(financeData?.byBiller.length ?? 0) === 0 ? (
                        <p className="text-sm text-muted-foreground">No finance events yet.</p>
                      ) : (
                        financeData?.byBiller.map((row) => <FinanceBillerCard key={row.biller} row={row} />)
                      )}
                    </CardContent>
                  </Card>
                  <FinanceTimelineCard rows={topFinanceEvents} />
                </div>

                <FinanceKindCard rows={financeData?.byKind ?? []} />
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
