import { Skeleton } from "@/components/ui/skeleton";
import type { AgentSkillAnalytics } from "@rudderhq/shared";
import { SkillsUsageChart, SkillsUsagePieChart } from "../components/ActivityCharts";

type AgentSkillAnalyticsSectionProps = {
  analytics?: AgentSkillAnalytics;
  isLoading?: boolean;
  error?: Error | null;
  showDashboardFilters: boolean;
  isOneDay: boolean;
  rangeLabel: string;
};

export function AgentSkillAnalyticsSection({
  analytics,
  isLoading,
  error,
  showDashboardFilters,
  isOneDay,
  rangeLabel,
}: AgentSkillAnalyticsSectionProps) {
  const visibleAnalytics = !error && analytics && analytics.totalRunsWithSkills > 0
    ? analytics
    : null;
  if (!showDashboardFilters || (!isOneDay && !visibleAnalytics && !isLoading && !error)) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Skills</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isOneDay
              ? `Skill usage distribution for ${rangeLabel.toLowerCase()}.`
              : `Skill usage per run for ${rangeLabel}. Hover a day to inspect the breakdown.`}
          </p>
        </div>
        {error ? null : visibleAnalytics ? (
          <div className="text-right text-[11px] text-muted-foreground tabular-nums">
            <div>{visibleAnalytics.totalCount} skill uses</div>
            <div>{visibleAnalytics.totalRunsWithSkills} runs with skill usage</div>
          </div>
        ) : isLoading ? (
          <div className="space-y-1.5">
            <Skeleton className="ml-auto h-3 w-20" />
            <Skeleton className="ml-auto h-3 w-28" />
          </div>
        ) : (
          <div className="text-right text-[11px] text-muted-foreground tabular-nums">
            <div>0 skill uses</div>
            <div>0 runs with skill usage</div>
          </div>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive" data-testid="agent-skills-analytics-error">
          {error.message || "Skill analytics could not be loaded."}
        </p>
      ) : visibleAnalytics ? (
        isOneDay
          ? <SkillsUsagePieChart analytics={visibleAnalytics} />
          : <SkillsUsageChart analytics={visibleAnalytics} />
      ) : isLoading ? (
        <div
          aria-busy="true"
          aria-label="Loading skill usage"
          className="space-y-3 rounded-lg border border-border p-4"
          data-testid="agent-skills-analytics-skeleton"
        >
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-36 w-full rounded-md" />
          <div className="flex gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
      ) : (
        <SkillsUsagePieChart analytics={null} />
      )}
    </div>
  );
}
