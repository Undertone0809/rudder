import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import type { Goal } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { Plus, Target } from "lucide-react";
import { useEffect } from "react";
import { goalsApi } from "../api/goals";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDate } from "../lib/utils";

function lifecycleLabel(goal: Goal) {
  return goal.lifecycle ?? (goal.status === "active" ? "active" : goal.status === "achieved" || goal.status === "cancelled" ? "closed" : "draft");
}

export function Goals() {
  const { selectedOrganizationId } = useOrganization();
  const { openNewGoal } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Goals" }]), [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedOrganizationId!),
    queryFn: () => goalsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  if (!selectedOrganizationId) return <EmptyState icon={Target} message="Select an organization to view Goals." />;
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Goals</h1>
          <p className="text-sm text-muted-foreground">Outcome contracts and their current work loop.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => openNewGoal()}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New draft
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {goals && goals.length === 0 ? (
        <EmptyState icon={Target} message="No Goals yet." action="Add draft" onAction={() => openNewGoal()} />
      ) : (
        <div className="divide-y divide-border border border-border">
          {(goals ?? []).map((goal) => (
            <Link key={goal.id} to={`/goals/${goal.id}`} className="block px-4 py-3 transition-colors hover:bg-accent/40">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-medium">{goal.title}</h2>
                    {goal.focus && <span className="text-xs font-medium text-[color:var(--accent-base)]">Focus</span>}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{goal.outcomeStatement ?? goal.description ?? "No outcome contract yet"}</p>
                </div>
                <StatusBadge status={lifecycleLabel(goal)} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{goal.objectiveMode ?? "target"}</span>
                <span>{goal.ownerAgentId ? `Owner ${goal.ownerAgentId.slice(0, 8)}` : "Unassigned"}</span>
                <span>Updated {formatDate(goal.updatedAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
