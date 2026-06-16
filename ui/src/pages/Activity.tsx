import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Agent } from "@rudderhq/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { accessApi } from "../api/access";
import { activityApi, type ActivityListFilters } from "../api/activity";
import { agentsApi } from "../api/agents";
import { ActivityRow } from "../components/ActivityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useOrganization } from "../context/OrganizationContext";
import { useOperatorDisplayName } from "../hooks/useOperatorDisplayName";
import { queryKeys } from "../lib/queryKeys";

type PrincipalFilter = "all" | "system" | `agent:${string}` | `user:${string}`;

const ACTIVITY_PAGE_SIZE = 30;
const ENTITY_TYPE_FILTER_OPTIONS = [
  "agent",
  "agent_api_key",
  "agent_workspace",
  "approval",
  "asset",
  "automation",
  "automation_run",
  "automation_trigger",
  "budget_incident",
  "budget_policy",
  "calendar_event",
  "calendar_source",
  "chat",
  "comment",
  "cost_event",
  "document",
  "finance_event",
  "goal",
  "heartbeat_run",
  "instance_settings",
  "invite",
  "issue",
  "join_request",
  "label",
  "operator_profile",
  "organization",
  "organization_intelligence_profile",
  "organization_resource",
  "organization_skill",
  "organization_workspace",
  "plugin",
  "project",
  "project_resource_attachment",
  "run_workspace",
  "secret",
  "user",
  "workspace_backup",
];

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
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

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

  const {
    data: activityPages,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: queryKeys.activity(selectedOrganizationId!, activityFiltersKey),
    queryFn: ({ pageParam }) => activityApi.listPage(selectedOrganizationId!, {
      ...activityFilters,
      limit: ACTIVITY_PAGE_SIZE,
      cursor: pageParam,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!selectedOrganizationId,
  });

  const data = useMemo(
    () => activityPages?.pages.flatMap((page) => page.items) ?? [],
    [activityPages],
  );

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasNextPage || isFetchingNextPage) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      void fetchNextPage();
    }, { rootMargin: "320px 0px" });

    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, data.length]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
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
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    return map;
  }, [agents]);

  const entityTitleMap = useMemo(() => new Map<string, string>(), []);

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
      for (const event of data) {
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

  const entityTypes = [
    ...new Set([
      ...ENTITY_TYPE_FILTER_OPTIONS,
      ...data.map((e) => e.entityType),
      entityTypeFilter !== "all" ? entityTypeFilter : "",
    ]),
  ].filter(Boolean).sort();

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

      {filtered.length === 0 && (
        <EmptyState icon={History} message="No activity yet." />
      )}

      {filtered.length > 0 && (
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

      <div ref={loadMoreRef} className="h-px" aria-hidden="true" />

      {isFetchingNextPage && (
        <p className="text-center text-xs text-muted-foreground">Loading more activity...</p>
      )}
    </div>
  );
}
