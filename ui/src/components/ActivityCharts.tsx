import type { AgentSkillAnalytics, HeartbeatRun } from "@rudderhq/shared";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/* ---- Utilities ---- */

function toLocalDayKey(value: string | Date): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getRecentDays(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1 - i), 12, 0, 0, 0);
    return toLocalDayKey(d);
  });
}

export function getLast14Days(): string[] {
  return getRecentDays(14);
}

export function getLast30Days(): string[] {
  return getRecentDays(30);
}

export function getVisibleSkillDays(
  analytics: AgentSkillAnalytics | null | undefined,
) {
  return analytics?.days ?? [];
}

function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDayTitle(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/* ---- Sub-components ---- */

function DateLabels({ days }: { days: string[] }) {
  const keyIndexes = new Set<number>([
    0,
    Math.floor((days.length - 1) / 2),
    days.length - 1,
  ]);
  return (
    <div className="flex gap-[3px] mt-1.5">
      {days.map((day, i) => (
        <div key={day} className="flex-1 text-center">
          {keyIndexes.has(i) ? (
            <span className="text-[9px] text-muted-foreground tabular-nums">{formatDayLabel(day)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ChartLegend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-2">
      {items.map(item => (
        <span key={item.label} className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function TooltipMetricRow({
  color,
  label,
  value,
}: {
  color?: string;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-1.5 text-background/80">
        {color ? (
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        ) : null}
        <span>{label}</span>
      </div>
      <span className="font-medium text-background">{value}</span>
    </div>
  );
}

function ChartColumnTooltip({
  day,
  title,
  trigger,
  details,
  empty = false,
}: {
  day: string;
  title: string;
  trigger: React.ReactNode;
  details?: React.ReactNode;
  empty?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${formatDayTitle(day)}: ${title}`}
          className="flex-1 h-full appearance-none rounded-[4px] bg-transparent p-0 text-left transition-colors hover:bg-black/3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {trigger}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="min-w-[180px] px-3 py-2">
        <div className="space-y-2">
          <div className="border-b border-background/15 pb-2">
            <div className="font-medium text-background">{formatDayTitle(day)}</div>
            <div className="text-[11px] text-background/70">{title}</div>
          </div>
          {empty ? (
            <div className="text-xs text-background/80">No data for this day.</div>
          ) : details ? (
            <div className="space-y-1.5">{details}</div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

const runActivityLegendItems = [
  { color: "#10b981", label: "Succeeded" },
  { color: "#ef4444", label: "Failed / timed out" },
  { color: "#737373", label: "Other" },
];

const successRateLegendItems = [
  { color: "#10b981", label: "80%+" },
  { color: "#eab308", label: "50-79%" },
  { color: "#ef4444", label: "Below 50%" },
];

const skillsPalette = [
  "#3b82f6",
  "#ec4899",
  "#8b5cf6",
  "#06b6d4",
  "#0f766e",
  "#f97316",
  "#a855f7",
  "#f59e0b",
  "#10b981",
  "#6366f1",
  "#e11d48",
  "#14b8a6",
];

const otherSkillsColor = "#737373";

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {subtitle ? (
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/60">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function formatPercent(value: number, total: number): string {
  if (total <= 0) return "0%";
  const percent = (value / total) * 100;
  if (percent >= 10 || percent === 100) return `${Math.round(percent)}%`;
  return `${percent.toFixed(1)}%`;
}

function SkillChartPanel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border p-4">
      <div>
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
        {subtitle ? (
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/60">{subtitle}</p>
        ) : null}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function SkillDistributionPie({
  analytics,
  colorBySkillKey,
}: {
  analytics: AgentSkillAnalytics;
  colorBySkillKey: Map<string, string>;
}) {
  const topSkills = analytics.skills.slice(0, 7);
  const otherCount = analytics.skills.slice(7).reduce((sum, skill) => sum + skill.count, 0);
  const segments = [
    ...topSkills.map((skill) => ({
      key: skill.key,
      label: skill.label,
      count: skill.count,
      color: colorBySkillKey.get(skill.key) ?? otherSkillsColor,
    })),
    ...(otherCount > 0
      ? [{
        key: "__other__",
        label: "Other skills",
        count: otherCount,
        color: otherSkillsColor,
      }]
      : []),
  ];

  let cursor = 0;
  const gradientStops = segments.map((segment) => {
    const start = cursor;
    const end = cursor + (segment.count / analytics.totalCount) * 360;
    cursor = end;
    return `${segment.color} ${start}deg ${end}deg`;
  });

  const gradient = gradientStops.length > 0
    ? `conic-gradient(${gradientStops.join(", ")})`
    : "var(--muted)";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Skill distribution: ${analytics.totalCount} skill loads across ${analytics.skills.length} skills`}
          className="mx-auto flex w-full max-w-[12rem] appearance-none items-center justify-center rounded-full bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span
            aria-hidden="true"
            className="relative aspect-square w-full rounded-full border border-border/70 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
            style={{ background: gradient }}
          >
            <span className="absolute inset-[24%] rounded-full border border-border/70 bg-background" />
            <span className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-lg font-semibold tabular-nums text-foreground">{analytics.skills.length}</span>
              <span className="text-[10px] text-muted-foreground">skills</span>
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="min-w-[220px] px-3 py-2">
        <div className="space-y-2">
          <div className="border-b border-background/15 pb-2">
            <div className="font-medium text-background">Skill distribution</div>
            <div className="text-[11px] text-background/70">
              {analytics.totalCount} skill loads across {analytics.totalRunsWithSkills} run{analytics.totalRunsWithSkills === 1 ? "" : "s"}
            </div>
          </div>
          <div className="space-y-1.5">
            {segments.map((segment) => (
              <TooltipMetricRow
                key={segment.key}
                color={segment.color}
                label={segment.label}
                value={`${segment.count} · ${formatPercent(segment.count, analytics.totalCount)}`}
              />
            ))}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function SkillDistributionPanel({
  analytics,
  colorBySkillKey,
}: {
  analytics: AgentSkillAnalytics;
  colorBySkillKey: Map<string, string>;
}) {
  return (
    <div className="flex h-full min-h-48 items-center justify-center">
      <div className="w-full">
        <SkillDistributionPie analytics={analytics} colorBySkillKey={colorBySkillKey} />
      </div>
    </div>
  );
}

/* ---- Chart Components ---- */

export function RunActivityChart({
  runs,
  days = getLast14Days(),
}: {
  runs: HeartbeatRun[];
  days?: string[];
}) {

  const grouped = new Map<string, { succeeded: number; failed: number; other: number }>();
  for (const day of days) grouped.set(day, { succeeded: 0, failed: 0, other: 0 });
  for (const run of runs) {
    const day = toLocalDayKey(run.createdAt);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (run.status === "succeeded") entry.succeeded++;
    else if (run.status === "failed" || run.status === "timed_out") entry.failed++;
    else entry.other++;
  }

  const maxValue = Math.max(...Array.from(grouped.values()).map(v => v.succeeded + v.failed + v.other), 1);
  const hasData = Array.from(grouped.values()).some(v => v.succeeded + v.failed + v.other > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  return (
    <TooltipProvider delayDuration={120}>
      <div>
        <div className="flex items-end gap-[3px] h-20">
          {days.map(day => {
            const entry = grouped.get(day)!;
            const total = entry.succeeded + entry.failed + entry.other;
            const heightPct = (total / maxValue) * 100;
            return (
              <ChartColumnTooltip
                key={day}
                day={day}
                title={`${total} runs`}
                details={
                  <>
                    <TooltipMetricRow label="Total runs" value={total} />
                    <TooltipMetricRow color="#10b981" label="Succeeded" value={entry.succeeded} />
                    <TooltipMetricRow color="#ef4444" label="Failed / timed out" value={entry.failed} />
                    <TooltipMetricRow color="#737373" label="Other" value={entry.other} />
                  </>
                }
                empty={total === 0}
                trigger={
                  <div className="flex h-full flex-col justify-end">
                    {total > 0 ? (
                      <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                        {entry.succeeded > 0 && <div className="bg-emerald-500" style={{ flex: entry.succeeded }} />}
                        {entry.failed > 0 && <div className="bg-red-500" style={{ flex: entry.failed }} />}
                        {entry.other > 0 && <div className="bg-neutral-500" style={{ flex: entry.other }} />}
                      </div>
                    ) : (
                      <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
                    )}
                  </div>
                }
              />
            );
          })}
        </div>
        <DateLabels days={days} />
        <ChartLegend items={runActivityLegendItems} />
      </div>
    </TooltipProvider>
  );
}

const priorityColors: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#6b7280",
};

const priorityOrder = ["critical", "high", "medium", "low"] as const;

export function PriorityChart({
  issues,
  days = getLast14Days(),
}: {
  issues: { priority: string; createdAt: Date }[];
  days?: string[];
}) {
  const grouped = new Map<string, Record<string, number>>();
  for (const day of days) grouped.set(day, { critical: 0, high: 0, medium: 0, low: 0 });
  for (const issue of issues) {
    const day = toLocalDayKey(issue.createdAt);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (issue.priority in entry) entry[issue.priority]++;
  }

  const maxValue = Math.max(...Array.from(grouped.values()).map(v => Object.values(v).reduce((a, b) => a + b, 0)), 1);
  const hasData = Array.from(grouped.values()).some(v => Object.values(v).reduce((a, b) => a + b, 0) > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">No issues</p>;

  return (
    <TooltipProvider delayDuration={120}>
      <div>
        <div className="flex items-end gap-[3px] h-20">
          {days.map(day => {
            const entry = grouped.get(day)!;
            const total = Object.values(entry).reduce((a, b) => a + b, 0);
            const heightPct = (total / maxValue) * 100;
            return (
              <ChartColumnTooltip
                key={day}
                day={day}
                title={`${total} issues`}
                details={
                  <>
                    <TooltipMetricRow label="Total issues" value={total} />
                    {priorityOrder.filter((p) => entry[p] > 0).map((p) => (
                      <TooltipMetricRow
                        key={p}
                        color={priorityColors[p]}
                        label={p.charAt(0).toUpperCase() + p.slice(1)}
                        value={entry[p]}
                      />
                    ))}
                  </>
                }
                empty={total === 0}
                trigger={
                  <div className="flex h-full flex-col justify-end">
                    {total > 0 ? (
                      <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                        {priorityOrder.map(p => entry[p] > 0 ? (
                          <div key={p} style={{ flex: entry[p], backgroundColor: priorityColors[p] }} />
                        ) : null)}
                      </div>
                    ) : (
                      <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
                    )}
                  </div>
                }
              />
            );
          })}
        </div>
        <DateLabels days={days} />
        <ChartLegend items={priorityOrder.map(p => ({ color: priorityColors[p], label: p.charAt(0).toUpperCase() + p.slice(1) }))} />
      </div>
    </TooltipProvider>
  );
}

const statusColors: Record<string, string> = {
  todo: "#3b82f6",
  in_progress: "#8b5cf6",
  in_review: "#a855f7",
  done: "#10b981",
  blocked: "#ef4444",
  cancelled: "#6b7280",
  backlog: "#64748b",
};

const statusLabels: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
  backlog: "Backlog",
};

export function IssueStatusChart({
  issues,
  days = getLast14Days(),
}: {
  issues: { status: string; createdAt: Date }[];
  days?: string[];
}) {
  const allStatuses = new Set<string>();
  const grouped = new Map<string, Record<string, number>>();
  for (const day of days) grouped.set(day, {});
  for (const issue of issues) {
    const day = toLocalDayKey(issue.createdAt);
    const entry = grouped.get(day);
    if (!entry) continue;
    entry[issue.status] = (entry[issue.status] ?? 0) + 1;
    allStatuses.add(issue.status);
  }

  const statusOrder = ["todo", "in_progress", "in_review", "done", "blocked", "cancelled", "backlog"].filter(s => allStatuses.has(s));
  const maxValue = Math.max(...Array.from(grouped.values()).map(v => Object.values(v).reduce((a, b) => a + b, 0)), 1);
  const hasData = allStatuses.size > 0;

  if (!hasData) return <p className="text-xs text-muted-foreground">No issues</p>;

  return (
    <TooltipProvider delayDuration={120}>
      <div>
        <div className="flex items-end gap-[3px] h-20">
          {days.map(day => {
            const entry = grouped.get(day)!;
            const total = Object.values(entry).reduce((a, b) => a + b, 0);
            const heightPct = (total / maxValue) * 100;
            return (
              <ChartColumnTooltip
                key={day}
                day={day}
                title={`${total} issues`}
                details={
                  <>
                    <TooltipMetricRow label="Total issues" value={total} />
                    {statusOrder.filter((s) => (entry[s] ?? 0) > 0).map((s) => (
                      <TooltipMetricRow
                        key={s}
                        color={statusColors[s] ?? "#6b7280"}
                        label={statusLabels[s] ?? s}
                        value={entry[s] ?? 0}
                      />
                    ))}
                  </>
                }
                empty={total === 0}
                trigger={
                  <div className="flex h-full flex-col justify-end">
                    {total > 0 ? (
                      <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                        {statusOrder.map(s => (entry[s] ?? 0) > 0 ? (
                          <div key={s} style={{ flex: entry[s], backgroundColor: statusColors[s] ?? "#6b7280" }} />
                        ) : null)}
                      </div>
                    ) : (
                      <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
                    )}
                  </div>
                }
              />
            );
          })}
        </div>
        <DateLabels days={days} />
        <ChartLegend items={statusOrder.map(s => ({ color: statusColors[s] ?? "#6b7280", label: statusLabels[s] ?? s }))} />
      </div>
    </TooltipProvider>
  );
}

export function SuccessRateChart({
  runs,
  days = getLast14Days(),
}: {
  runs: HeartbeatRun[];
  days?: string[];
}) {
  const grouped = new Map<string, { succeeded: number; total: number }>();
  for (const day of days) grouped.set(day, { succeeded: 0, total: 0 });
  for (const run of runs) {
    const day = toLocalDayKey(run.createdAt);
    const entry = grouped.get(day);
    if (!entry) continue;
    entry.total++;
    if (run.status === "succeeded") entry.succeeded++;
  }

  const hasData = Array.from(grouped.values()).some(v => v.total > 0);
  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  return (
    <TooltipProvider delayDuration={120}>
      <div>
        <div className="flex items-end gap-[3px] h-20">
          {days.map(day => {
            const entry = grouped.get(day)!;
            const rate = entry.total > 0 ? entry.succeeded / entry.total : 0;
            const roundedRate = entry.total > 0 ? Math.round(rate * 100) : 0;
            const unsuccessful = entry.total - entry.succeeded;
            const color = entry.total === 0 ? undefined : rate >= 0.8 ? "#10b981" : rate >= 0.5 ? "#eab308" : "#ef4444";
            return (
              <ChartColumnTooltip
                key={day}
                day={day}
                title={entry.total > 0 ? `${roundedRate}% success rate` : "No runs"}
                details={
                  <>
                    <TooltipMetricRow label="Success rate" value={`${roundedRate}%`} />
                    <TooltipMetricRow color="#10b981" label="Succeeded" value={entry.succeeded} />
                    <TooltipMetricRow color="#ef4444" label="Unsuccessful" value={unsuccessful} />
                    <TooltipMetricRow label="Total runs" value={entry.total} />
                  </>
                }
                empty={entry.total === 0}
                trigger={
                  <div className="flex h-full flex-col justify-end">
                    {entry.total > 0 ? (
                      <div style={{ height: `${rate * 100}%`, minHeight: 2, backgroundColor: color }} />
                    ) : (
                      <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
                    )}
                  </div>
                }
              />
            );
          })}
        </div>
        <DateLabels days={days} />
        <ChartLegend items={successRateLegendItems} />
      </div>
    </TooltipProvider>
  );
}

export function SkillsUsageChart({
  analytics,
}: {
  analytics: AgentSkillAnalytics | null | undefined;
}) {
  const days = getVisibleSkillDays(analytics);
  const maxValue = Math.max(...days.map((day) => day.totalCount), 1);
  const hasData = days.some((day) => day.totalCount > 0);

  if (!analytics || !hasData) {
    return <p className="text-xs text-muted-foreground">No recent skills activity.</p>;
  }

  const colorBySkillKey = new Map(
    analytics.skills.map((skill, index) => [skill.key, skillsPalette[index % skillsPalette.length]!]),
  );

  return (
    <TooltipProvider delayDuration={120}>
      <div className="grid gap-3 lg:grid-cols-[minmax(12rem,0.7fr)_minmax(0,3fr)]">
        <SkillChartPanel title="Skill Distribution" subtitle="Share of loaded skills in this window.">
          <SkillDistributionPanel analytics={analytics} colorBySkillKey={colorBySkillKey} />
        </SkillChartPanel>

        <SkillChartPanel title="Skill Usage Timeline" subtitle={`Daily loaded-skill volume over the last ${analytics.windowDays} day${analytics.windowDays === 1 ? "" : "s"}.`}>
          <div>
            <div className="flex items-end gap-[3px] h-36">
              {days.map((day) => {
                const heightPct = (day.totalCount / maxValue) * 100;
                const topSkills = day.skills.slice(0, 6);
                const otherCount = day.skills.slice(6).reduce((sum, skill) => sum + skill.count, 0);
                const title =
                  day.totalCount > 0
                    ? `${day.totalCount} skill loads across ${day.runCount} run${day.runCount === 1 ? "" : "s"}`
                    : "No skills activity";

                return (
                  <ChartColumnTooltip
                    key={day.date}
                    day={day.date}
                    title={title}
                    details={
                      <>
                        <TooltipMetricRow label="Skill loads" value={day.totalCount} />
                        <TooltipMetricRow label="Runs with skills" value={day.runCount} />
                        {topSkills.map((skill) => (
                          <TooltipMetricRow
                            key={`${day.date}:${skill.key}`}
                            color={colorBySkillKey.get(skill.key)}
                            label={skill.label}
                            value={skill.count}
                          />
                        ))}
                        {otherCount > 0 ? (
                          <TooltipMetricRow
                            color={otherSkillsColor}
                            label="Other skills"
                            value={otherCount}
                          />
                        ) : null}
                      </>
                    }
                    empty={day.totalCount === 0}
                    trigger={
                      <div className="flex h-full flex-col justify-end">
                        {day.totalCount > 0 ? (
                          <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                            {day.skills.map((skill) => (
                              <div
                                key={`${day.date}:${skill.key}`}
                                style={{
                                  flex: skill.count,
                                  backgroundColor: colorBySkillKey.get(skill.key) ?? otherSkillsColor,
                                }}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
                        )}
                      </div>
                    }
                  />
                );
              })}
            </div>
            <DateLabels days={days.map((day) => day.date)} />
          </div>
        </SkillChartPanel>
      </div>
    </TooltipProvider>
  );
}
