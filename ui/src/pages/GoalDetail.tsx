import { useEffect, useMemo } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { assetsApi } from "../api/assets";
import { usePanel } from "../context/PanelContext";
import { useOrganization } from "../context/OrganizationContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalProperties } from "../components/GoalProperties";
import { GoalTree } from "../components/GoalTree";
import { StatusBadge } from "../components/StatusBadge";
import { InlineEditor } from "../components/InlineEditor";
import { EntityRow } from "../components/EntityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate, issueUrl, projectUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus } from "lucide-react";
import type { ActivityEvent, Goal, Issue, Project } from "@rudderhq/shared";

const CLOSED_GOAL_STATUSES = new Set(["achieved", "cancelled"]);
const CLOSED_PROJECT_STATUSES = new Set(["completed", "cancelled"]);
const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);

function SummaryMetric({
  label,
  value,
  title,
  to,
}: {
  label: string;
  value: string | number;
  title?: string;
  to?: string;
}) {
  const content = (
    <div className="rounded-md border border-border bg-card px-3 py-2" title={title}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium">{value}</div>
    </div>
  );
  return to ? <Link to={to}>{content}</Link> : content;
}

function WorkSection({
  linkedProjects,
  linkedIssues,
}: {
  linkedProjects: Project[];
  linkedIssues: Issue[];
}) {
  if (linkedProjects.length === 0 && linkedIssues.length === 0) {
    return (
      <div className="rounded-md border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
        No linked work yet. Link projects or issues to make this goal operational.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-sm font-medium">Projects ({linkedProjects.length})</div>
        {linkedProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No linked projects.</p>
        ) : (
          <div className="border border-border">
            {linkedProjects.map((project) => (
              <EntityRow
                key={project.id}
                title={project.name}
                subtitle={project.description ?? undefined}
                to={projectUrl(project)}
                trailing={<StatusBadge status={project.status} />}
              />
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">Issues ({linkedIssues.length})</div>
        {linkedIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No linked issues.</p>
        ) : (
          <div className="border border-border">
            {linkedIssues.map((issue) => (
              <EntityRow
                key={issue.id}
                title={issue.title}
                subtitle={issue.identifier ?? undefined}
                to={issueUrl(issue)}
                trailing={<StatusBadge status={issue.status} />}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityList({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  }
  return (
    <div className="border border-border divide-y divide-border">
      {events.map((event) => (
        <div key={event.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
          <span>{event.action.replace(/^goal\./, "").replace(/_/g, " ")}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatDate(event.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

function buildGoalAncestors(goal: Goal | undefined, allGoals: Goal[] | undefined) {
  if (!goal || !allGoals) return [];
  const byId = new Map(allGoals.map((candidate) => [candidate.id, candidate]));
  const ancestors: Goal[] = [];
  const seen = new Set<string>();
  let cursor = goal.parentId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    ancestors.unshift(parent);
    cursor = parent.parentId;
  }
  return ancestors;
}

function shouldHandleGoalDetailEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") return false;
  if (event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;

  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target) {
    if (target.isContentEditable) return false;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return false;
  }

  if (typeof document !== "undefined") {
    if (document.querySelector("[role='dialog']")) return false;
    if (document.querySelector("[data-radix-popper-content-wrapper]")) return false;
  }

  return true;
}

function goalCompletionSignal({
  goal,
  childGoals,
  linkedProjects,
  linkedIssues,
}: {
  goal: Goal;
  childGoals: Goal[];
  linkedProjects: Project[];
  linkedIssues: Issue[];
}) {
  if (goal.status === "achieved") {
    return {
      label: "Achieved",
      detail: "The owner has accepted this goal as complete.",
    };
  }
  if (goal.status === "cancelled") {
    return {
      label: "Cancelled",
      detail: "Cancelled goals are closed without counting as achieved.",
    };
  }

  const openChildGoals = childGoals.filter((child) => !CLOSED_GOAL_STATUSES.has(child.status)).length;
  const openProjects = linkedProjects.filter((project) => !CLOSED_PROJECT_STATUSES.has(project.status)).length;
  const openIssues = linkedIssues.filter((issue) => !CLOSED_ISSUE_STATUSES.has(issue.status)).length;
  const openWork = openChildGoals + openProjects + openIssues;
  const evidenceCount = childGoals.length + linkedProjects.length + linkedIssues.length;

  if (openWork > 0) {
    return {
      label: "Open work",
      detail: `${openWork} open linked item${openWork === 1 ? "" : "s"}.`,
    };
  }
  if (evidenceCount > 0) {
    return {
      label: "Ready to achieve",
      detail: "All linked work is closed; owner review should move status to achieved.",
    };
  }
  return {
    label: "Needs evidence",
    detail: "No linked work or sub-goals are available as completion evidence.",
  };
}

export function GoalDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const { selectedOrganizationId, setSelectedOrganizationId } = useOrganization();
  const { openNewGoal } = useDialog();
  const { openPanel, closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const {
    data: goal,
    isLoading,
    error
  } = useQuery({
    queryKey: queryKeys.goals.detail(goalId!),
    queryFn: () => goalsApi.get(goalId!),
    enabled: !!goalId
  });
  const resolvedCompanyId = goal?.orgId ?? selectedOrganizationId;

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(resolvedCompanyId!),
    queryFn: () => goalsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  const { data: allProjects } = useQuery({
    queryKey: queryKeys.projects.list(resolvedCompanyId!),
    queryFn: () => projectsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(resolvedCompanyId!),
    queryFn: () => issuesApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  const {
    data: dependencies,
    isLoading: dependenciesLoading,
  } = useQuery({
    queryKey: queryKeys.goals.dependencies(goalId!),
    queryFn: () => goalsApi.dependencies(goalId!),
    enabled: !!goalId && !!goal,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.goals.activity(resolvedCompanyId!, goalId!),
    queryFn: () =>
      activityApi.list(resolvedCompanyId!, {
        entityType: "goal",
        entityId: goalId!,
      }),
    enabled: !!resolvedCompanyId && !!goalId,
  });

  useEffect(() => {
    if (!goal?.orgId || goal.orgId === selectedOrganizationId) return;
    setSelectedOrganizationId(goal.orgId, { source: "route_sync" });
  }, [goal?.orgId, selectedOrganizationId, setSelectedOrganizationId]);

  const updateGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      goalsApi.update(goalId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.detail(goalId!)
      });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(resolvedCompanyId)
        });
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.dependencies(goalId!)
      });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.activity(resolvedCompanyId, goalId!)
        });
      }
    }
  });

  const deleteGoal = useMutation({
    mutationFn: () => goalsApi.remove(goalId!),
    onSuccess: () => {
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(resolvedCompanyId)
        });
      }
      navigate("/goals");
    },
    onError: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.dependencies(goalId!)
      });
    }
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No organization selected");
      return assetsApi.uploadImage(
        resolvedCompanyId,
        file,
        `goals/${goalId ?? "draft"}`
      );
    }
  });

  const childGoals = (allGoals ?? []).filter((g) => g.parentId === goalId);
  const linkedProjects = (allProjects ?? []).filter((p) => {
    if (!goalId) return false;
    if (p.goalIds.includes(goalId)) return true;
    if (p.goals.some((goalRef) => goalRef.id === goalId)) return true;
    return p.goalId === goalId;
  });
  const linkedIssues = (allIssues ?? []).filter((issue) => issue.goalId === goalId);
  const ownerAgent = goal?.ownerAgentId
    ? agents?.find((agent) => agent.id === goal.ownerAgentId) ?? null
    : null;
  const parentGoal = goal?.parentId
    ? allGoals?.find((candidate) => candidate.id === goal.parentId) ?? null
    : null;
  const goalAncestors = useMemo(() => buildGoalAncestors(goal, allGoals), [goal, allGoals]);
  const parentHref = goal?.parentId ? `/goals/${goal.parentId}` : "/goals";
  const completionSignal = goal
    ? goalCompletionSignal({ goal, childGoals, linkedProjects, linkedIssues })
    : null;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Goals", href: "/goals" },
      ...goalAncestors.map((ancestor) => ({
        label: ancestor.title,
        href: `/goals/${ancestor.id}`,
      })),
      { label: goal?.title ?? goalId ?? "Goal" }
    ]);
  }, [setBreadcrumbs, goal, goalAncestors, goalId]);

  useEffect(() => {
    if (!goal) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleGoalDetailEscape(event)) return;
      event.preventDefault();
      navigate(parentHref);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [goal, navigate, parentHref]);

  useEffect(() => {
    if (goal) {
      openPanel(
        <GoalProperties
          goal={goal}
          onUpdate={(data) => updateGoal.mutate(data)}
          dependencies={dependencies}
          dependenciesLoading={dependenciesLoading}
          onDelete={() => deleteGoal.mutate()}
          deletePending={deleteGoal.isPending}
          deleteError={deleteGoal.error instanceof Error ? deleteGoal.error : null}
        />
      );
    }
    return () => closePanel();
  }, [goal, dependencies, dependenciesLoading, deleteGoal.isPending, deleteGoal.error]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!goal) return null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase text-muted-foreground">
            {goal.level}
          </span>
          <StatusBadge status={goal.status} />
        </div>

        <InlineEditor
          value={goal.title}
          onSave={(title) => updateGoal.mutate({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={goal.description ?? ""}
          onSave={(description) => updateGoal.mutate({ description })}
          as="p"
          className="text-sm text-muted-foreground"
          placeholder="Add a description..."
          multiline
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <SummaryMetric label="Owner" value={ownerAgent?.name ?? (goal.ownerAgentId ? goal.ownerAgentId.slice(0, 8) : "None")} />
        <SummaryMetric label="Parent" value={parentGoal?.title ?? "None"} to={parentGoal ? `/goals/${parentGoal.id}` : undefined} />
        <SummaryMetric label="Sub-goals" value={childGoals.length} />
        <SummaryMetric label="Projects" value={linkedProjects.length} />
        <SummaryMetric label="Issues" value={linkedIssues.length} />
        <SummaryMetric
          label="Completion"
          value={completionSignal?.label ?? "Unknown"}
          title={completionSignal?.detail}
        />
        <SummaryMetric label="Updated" value={formatDate(goal.updatedAt)} />
      </div>

      <Tabs defaultValue="work">
        <TabsList>
          <TabsTrigger value="work">
            Work ({linkedProjects.length + linkedIssues.length})
          </TabsTrigger>
          <TabsTrigger value="children">
            Sub-Goals ({childGoals.length})
          </TabsTrigger>
          <TabsTrigger value="activity">
            Activity ({activity?.length ?? 0})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="work" className="mt-4">
          <WorkSection linkedProjects={linkedProjects} linkedIssues={linkedIssues} />
        </TabsContent>

        <TabsContent value="children" className="mt-4 space-y-3">
          <div className="flex items-center justify-start">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openNewGoal({ parentId: goalId })}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Sub Goal
            </Button>
          </div>
          {childGoals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sub-goals.</p>
          ) : (
            <GoalTree goals={childGoals} goalLink={(g) => `/goals/${g.id}`} />
          )}
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <ActivityList events={activity ?? []} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
