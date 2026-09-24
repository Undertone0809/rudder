import { Link } from "@/lib/router";
import type { HeartbeatRun } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { agentRunsApi } from "../api/agent-runs";
import { ApiError } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { queryKeys } from "../lib/queryKeys";
import { appendRunSearchParams } from "./AgentDetail.run-filters";

export function useRunOutsideList(
  runs: HeartbeatRun[],
  selectedRunId: string | null,
  orgId: string,
  agentId: string,
) {
  const listedRun = selectedRunId ? runs.find((run) => run.id === selectedRunId) : null;
  const selectedRunQuery = useQuery({
    queryKey: queryKeys.runDetail(selectedRunId ?? "__none__"),
    queryFn: () => agentRunsApi.get(selectedRunId!),
    enabled: Boolean(selectedRunId && !listedRun),
    retry: false,
  });
  const candidate = selectedRunQuery.data;
  const fetchedRun = candidate?.orgId === orgId && candidate.agentId === agentId ? candidate : null;
  return { fetchedRun, selectedRunQuery };
}

export function resolveSelectedRun(
  sorted: HeartbeatRun[],
  filtered: HeartbeatRun[],
  selectedRunId: string | null,
  fetchedRun: HeartbeatRun | null,
  filtersActive: boolean,
) {
  const effectiveRunId = selectedRunId ?? filtered[0]?.id ?? sorted[0]?.id ?? null;
  const selectedRun = sorted.find((run) => run.id === effectiveRunId) ?? fetchedRun;
  const selectedRunOutsideList = Boolean(selectedRun && !filtered.some((run) => run.id === selectedRun.id));
  return {
    effectiveRunId,
    selectedRun,
    selectedRunOutsideList,
    selectedRunOutsideFilters: selectedRunOutsideList && filtersActive,
  };
}

export function RunSelectionFallback({
  agentRouteId,
  searchParams,
  query,
}: {
  agentRouteId: string;
  searchParams: URLSearchParams;
  query: ReturnType<typeof useRunOutsideList>["selectedRunQuery"];
}) {
  const { t } = useI18n();
  const loadFailed = query.isError && !(query.error instanceof ApiError && [403, 404].includes(query.error.status));
  return (
    <div
      role={query.isPending ? "status" : "alert"}
      className={`flex flex-wrap items-center justify-between gap-2 border-l-2 px-3 py-2 text-sm ${query.isPending ? "border-border bg-muted/30" : "border-destructive bg-destructive/5"}`}
    >
      <span>{query.isPending
        ? t("agentRuns.loadingRun")
        : loadFailed ? t("agentRuns.runLoadFailed") : t("agentRuns.runNotFound")}</span>
      {!query.isPending && (
        <div className="flex items-center gap-3">
          {loadFailed && (
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => void query.refetch()}>
              {t("agentRuns.retry")}
            </button>
          )}
          <Link className="shrink-0 font-medium underline underline-offset-2" to={appendRunSearchParams(`/agents/${agentRouteId}/runs`, searchParams)}>
            {t("agentRuns.backToRuns")}
          </Link>
        </div>
      )}
    </div>
  );
}
