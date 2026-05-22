import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { activityApi, type ActivityListFilters } from "../api/activity";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { goalsApi } from "../api/goals";
import { accessApi } from "../api/access";
import { useOrganization } from "../context/OrganizationContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useOperatorDisplayName } from "../hooks/useOperatorDisplayName";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ActivityRow } from "../components/ActivityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { History } from "lucide-react";
import type { Agent } from "@rudderhq/shared";

type PrincipalFilter = "all" | "system" | `agent:${string}` | `user:${string}`;

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function Activity() {
  const { selectedOrganizationId } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const operatorDisplayName = useOperatorDisplayName();
  const [entityTypeFilter, setEntityTypeFilter] = useState("all");
  const [principalFilter, setPrincipalFilter] = useState<PrincipalFilter>("all");
  const [knownActivityUserIds, setKnownActivityUserIds] = useState<string[]>([]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Activity" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setKnownActivityUserIds([]);
  }, [selectedOrganizationId]);

  const activityFilters = useMemo<ActivityListFilters>(() => {
    const filters: ActivityListFilters = {};
    if (entityTypeFilter !== "all") filters.entityType = entityTypeFilter;
    if (principalFilter === "system") {
      filters.actorType = "system";
    } else if (principalFilter.startsWith("agent:")) {
      filters.agentId = principalFilter.slice("agent:".length);
    } else if (principalFilter.startsWith("user:")) {
      filters.userId = principalFilter.slice("user:".length);
    }
    return filters;
  }, [entityTypeFilter, principalFilter]);

  const activityFiltersKey = useMemo(
    () => JSON.stringify(activityFilters),
    [activityFilters],
  );

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.activity(selectedOrganizationId!, activityFiltersKey),
    queryFn: () => activityApi.list(selectedOrganizationId!, activityFilters),
    enabled: !!selectedOrganizationId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedOrganizationId!),
    queryFn: () => issuesApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId!),
    queryFn: () => projectsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedOrganizationId!),
    queryFn: () => goalsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: currentBoardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: !!selectedOrganizationId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    for (const g of goals ?? []) map.set(`goal:${g.id}`, g.title);
    return map;
  }, [issues, agents, projects, goals]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const currentBoardUserId = currentBoardAccess?.user?.id ?? currentBoardAccess?.userId;

  useEffect(() => {
    setKnownActivityUserIds((previous) => {
      const ids = new Set(previous);
      let changed = false;
      const add = (id: string | null | undefined) => {
        if (!id || ids.has(id)) return;
        ids.add(id);
        changed = true;
      };

      add(currentBoardUserId);
      if (principalFilter.startsWith("user:")) add(principalFilter.slice("user:".length));
      for (const event of data ?? []) {
        if (event.actorType === "user") add(event.actorId);
      }

      if (!changed) return previous;
      return [...ids].sort();
    });
  }, [currentBoardUserId, data, principalFilter]);

  const activityUserIds = useMemo(() => {
    const ids = new Set(knownActivityUserIds);
    if (currentBoardUserId) ids.add(currentBoardUserId);
    if (principalFilter.startsWith("user:")) ids.add(principalFilter.slice("user:".length));
    return [...ids].sort((a, b) => {
      if (a === currentBoardUserId) return -1;
      if (b === currentBoardUserId) return 1;
      return a.localeCompare(b);
    });
  }, [currentBoardUserId, knownActivityUserIds, principalFilter]);

  function userFilterLabel(userId: string): string {
    if (userId === currentBoardUserId) {
      return operatorDisplayName ?? currentBoardAccess?.user?.name ?? "Current user";
    }
    if (userId === "board" || userId === "local-board") return "Board";
    return `User ${userId.slice(0, 8)}`;
  }

  if (!selectedOrganizationId) {
    return <EmptyState icon={History} message="Select a organization to view activity." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered = data;

  const entityTypes = data
    ? [
      ...new Set([
        ...data.map((e) => e.entityType),
        entityTypeFilter !== "all" ? entityTypeFilter : "",
      ]),
    ].filter(Boolean).sort()
    : entityTypeFilter !== "all"
      ? [entityTypeFilter]
      : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select
          value={principalFilter}
          onValueChange={(value) => setPrincipalFilter(value as PrincipalFilter)}
        >
          <SelectTrigger aria-label="Filter by actor" className="h-8 w-[180px] text-xs">
            <SelectValue placeholder="Filter by actor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actors</SelectItem>
            {agents?.map((agent) => (
              <SelectItem key={agent.id} value={`agent:${agent.id}`}>
                {agent.name}
              </SelectItem>
            ))}
            {activityUserIds.map((userId) => (
              <SelectItem key={userId} value={`user:${userId}`}>
                {userFilterLabel(userId)}
              </SelectItem>
            ))}
            <SelectItem value="system">System</SelectItem>
          </SelectContent>
        </Select>

        <Select value={entityTypeFilter} onValueChange={setEntityTypeFilter}>
          <SelectTrigger aria-label="Filter by type" className="h-8 w-[140px] text-xs">
            <SelectValue placeholder="Filter by type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {entityTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {capitalize(type)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {filtered && filtered.length === 0 && (
        <EmptyState icon={History} message="No activity yet." />
      )}

      {filtered && filtered.length > 0 && (
        <div className="border border-border divide-y divide-border">
          {filtered.map((event) => (
            <ActivityRow
              key={event.id}
              event={event}
              agentMap={agentMap}
              entityNameMap={entityNameMap}
              entityTitleMap={entityTitleMap}
              currentBoardUserId={currentBoardUserId}
              operatorDisplayName={operatorDisplayName}
            />
          ))}
        </div>
      )}
    </div>
  );
}
