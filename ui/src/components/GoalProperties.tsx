import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Goal, GoalDependencies } from "@rudderhq/shared";
import { GOAL_STATUSES, GOAL_LEVELS } from "@rudderhq/shared";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { useOrganization } from "../context/OrganizationContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { formatDate, cn, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ArchiveX, Loader2, Trash2 } from "lucide-react";

interface GoalPropertiesProps {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
  dependencies?: GoalDependencies | null;
  dependenciesLoading?: boolean;
  onDelete?: () => void;
  deletePending?: boolean;
  deleteError?: Error | null;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">{children}</div>
    </div>
  );
}

function label(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function PickerButton({
  current,
  options,
  onChange,
  children,
}: {
  current: string;
  options: readonly string[];
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="cursor-pointer hover:opacity-80 transition-opacity">
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        {options.map((opt) => (
          <Button
            key={opt}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start text-xs", opt === current && "bg-accent")}
            onClick={() => {
              onChange(opt);
              setOpen(false);
            }}
          >
            {label(opt)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function dependencyLabel(blocker: string) {
  switch (blocker) {
    case "last_root_organization_goal":
      return "Last root organization goal";
    case "child_goals":
      return "Child goals";
    case "linked_projects":
      return "Linked projects";
    case "linked_issues":
      return "Linked issues";
    case "automations":
      return "Automations";
    case "cost_events":
      return "Cost history";
    case "finance_events":
      return "Finance history";
    default:
      return label(blocker);
  }
}

function descendantIds(goal: Goal, allGoals: Goal[]) {
  const result = new Set<string>();
  const visit = (parentId: string) => {
    for (const child of allGoals) {
      if (child.parentId !== parentId || result.has(child.id)) continue;
      result.add(child.id);
      visit(child.id);
    }
  };
  visit(goal.id);
  return result;
}

function GoalDangerZone({
  goal,
  dependencies,
  dependenciesLoading,
  onUpdate,
  onDelete,
  deletePending,
  deleteError,
}: {
  goal: Goal;
  dependencies?: GoalDependencies | null;
  dependenciesLoading?: boolean;
  onUpdate?: (data: Record<string, unknown>) => void;
  onDelete?: () => void;
  deletePending?: boolean;
  deleteError?: Error | null;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  if (!onUpdate && !onDelete) return null;

  const canDelete = dependencies?.canDelete === true;
  const blocked = dependencies && !dependencies.canDelete;

  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-destructive">Lifecycle</div>
        <p className="text-xs text-muted-foreground">
          Hard delete is only for mistaken, unused goals. Goals with history should be cancelled.
        </p>
      </div>

      {dependenciesLoading && (
        <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking dependencies
        </div>
      )}

      {blocked && (
        <div className="space-y-1.5 rounded-md border border-border bg-background/50 p-2">
          <div className="text-xs font-medium">Delete blocked by</div>
          <div className="flex flex-wrap gap-1">
            {dependencies.blockers.map((blocker) => (
              <span
                key={blocker}
                className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {dependencyLabel(blocker)}
              </span>
            ))}
          </div>
        </div>
      )}

      {deleteError && (
        <p className="text-xs text-destructive">{deleteError.message}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {onUpdate && goal.status !== "cancelled" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onUpdate({ status: "cancelled" })}
          >
            <ArchiveX className="h-3.5 w-3.5 mr-1.5" />
            Cancel goal
          </Button>
        )}
        {onDelete && canDelete && (
          confirmingDelete ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setConfirmingDelete(false);
                  onDelete();
                }}
                disabled={deletePending}
              >
                {deletePending ? "Deleting..." : "Confirm delete"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setConfirmingDelete(true)}
              disabled={deletePending}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Delete goal
            </Button>
          )
        )}
      </div>
    </div>
  );
}

export function GoalProperties({
  goal,
  onUpdate,
  dependencies,
  dependenciesLoading,
  onDelete,
  deletePending,
  deleteError,
}: GoalPropertiesProps) {
  const { selectedOrganizationId } = useOrganization();
  const orgId = goal.orgId ?? selectedOrganizationId;
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(orgId!),
    queryFn: () => agentsApi.list(orgId!),
    enabled: !!orgId,
  });

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(orgId!),
    queryFn: () => goalsApi.list(orgId!),
    enabled: !!orgId,
  });

  const ownerAgent = goal.ownerAgentId
    ? agents?.find((a) => a.id === goal.ownerAgentId)
    : null;

  const parentGoal = goal.parentId
    ? allGoals?.find((g) => g.id === goal.parentId)
    : null;
  const invalidParentIds = descendantIds(goal, allGoals ?? []);
  invalidParentIds.add(goal.id);
  const parentOptions = (allGoals ?? []).filter((g) => !invalidParentIds.has(g.id));
  const activeAgents = (agents ?? []).filter((agent) => agent.status !== "terminated");

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Status">
          {onUpdate ? (
            <PickerButton
              current={goal.status}
              options={GOAL_STATUSES}
              onChange={(status) => onUpdate({ status })}
            >
              <StatusBadge status={goal.status} />
            </PickerButton>
          ) : (
            <StatusBadge status={goal.status} />
          )}
        </PropertyRow>

        <PropertyRow label="Level">
          {onUpdate ? (
            <PickerButton
              current={goal.level}
              options={GOAL_LEVELS}
              onChange={(level) => onUpdate({ level })}
            >
              <span className="text-sm capitalize">{goal.level}</span>
            </PickerButton>
          ) : (
            <span className="text-sm capitalize">{goal.level}</span>
          )}
        </PropertyRow>

        <PropertyRow label="Owner">
          {onUpdate ? (
            <Popover open={ownerOpen} onOpenChange={setOwnerOpen}>
              <PopoverTrigger asChild>
                <button className="text-sm hover:bg-accent/50 rounded px-1 -mx-1 py-0.5">
                  {ownerAgent?.name ?? "None"}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-1" align="end">
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn("w-full justify-start text-xs", !goal.ownerAgentId && "bg-accent")}
                  onClick={() => {
                    onUpdate({ ownerAgentId: null });
                    setOwnerOpen(false);
                  }}
                >
                  No owner
                </Button>
                {activeAgents.map((agent) => (
                  <Button
                    key={agent.id}
                    variant="ghost"
                    size="sm"
                    className={cn("w-full justify-start text-xs", agent.id === goal.ownerAgentId && "bg-accent")}
                    onClick={() => {
                      onUpdate({ ownerAgentId: agent.id });
                      setOwnerOpen(false);
                    }}
                  >
                    {agent.name}
                  </Button>
                ))}
              </PopoverContent>
            </Popover>
          ) : ownerAgent ? (
            <Link to={agentUrl(ownerAgent)} className="text-sm hover:underline">
              {ownerAgent.name}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </PropertyRow>

        <PropertyRow label="Parent Goal">
          {onUpdate ? (
            <Popover open={parentOpen} onOpenChange={setParentOpen}>
              <PopoverTrigger asChild>
                <button className="max-w-full truncate text-sm hover:bg-accent/50 rounded px-1 -mx-1 py-0.5">
                  {parentGoal?.title ?? "None"}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-1" align="end">
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn("w-full justify-start text-xs", !goal.parentId && "bg-accent")}
                  onClick={() => {
                    onUpdate({ parentId: null });
                    setParentOpen(false);
                  }}
                >
                  No parent
                </Button>
                {parentOptions.map((candidate) => (
                  <Button
                    key={candidate.id}
                    variant="ghost"
                    size="sm"
                    className={cn("w-full justify-start text-xs", candidate.id === goal.parentId && "bg-accent")}
                    onClick={() => {
                      onUpdate({ parentId: candidate.id });
                      setParentOpen(false);
                    }}
                  >
                    <span className="truncate">{candidate.title}</span>
                  </Button>
                ))}
              </PopoverContent>
            </Popover>
          ) : goal.parentId ? (
            <Link to={`/goals/${goal.parentId}`} className="text-sm hover:underline">
              {parentGoal?.title ?? goal.parentId.slice(0, 8)}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </PropertyRow>
      </div>

      <Separator />

      <div className="space-y-1">
        <PropertyRow label="Created">
          <span className="text-sm">{formatDate(goal.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{formatDate(goal.updatedAt)}</span>
        </PropertyRow>
      </div>

      {(onUpdate || onDelete) && (
        <>
          <Separator />
          <GoalDangerZone
            goal={goal}
            dependencies={dependencies}
            dependenciesLoading={dependenciesLoading}
            onUpdate={onUpdate}
            onDelete={onDelete}
            deletePending={deletePending}
            deleteError={deleteError}
          />
        </>
      )}
    </div>
  );
}
