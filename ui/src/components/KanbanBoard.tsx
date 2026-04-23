import { useCallback, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { Button } from "@/components/ui/button";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";
import type { Issue } from "@rudder/shared";

const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

const laneSurfaceClasses: Record<string, { base: string; over: string }> = {
  backlog: {
    base: "border-[color:color-mix(in_oklab,var(--border-soft)_88%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-inset)_88%,transparent)]",
    over: "border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_86%,var(--surface-inset))]",
  },
  todo: {
    base: "border-blue-200/75 bg-blue-50/70 dark:border-blue-900/55 dark:bg-blue-950/24",
    over: "border-blue-300/90 bg-blue-100/82 dark:border-blue-700/70 dark:bg-blue-900/34",
  },
  in_progress: {
    base: "border-amber-200/75 bg-amber-50/70 dark:border-amber-900/55 dark:bg-amber-950/24",
    over: "border-amber-300/90 bg-amber-100/82 dark:border-amber-700/70 dark:bg-amber-900/34",
  },
  in_review: {
    base: "border-violet-200/75 bg-violet-50/70 dark:border-violet-900/55 dark:bg-violet-950/24",
    over: "border-violet-300/90 bg-violet-100/82 dark:border-violet-700/70 dark:bg-violet-900/34",
  },
  blocked: {
    base: "border-red-200/75 bg-red-50/70 dark:border-red-900/55 dark:bg-red-950/24",
    over: "border-red-300/90 bg-red-100/82 dark:border-red-700/70 dark:bg-red-900/34",
  },
  done: {
    base: "border-emerald-200/75 bg-emerald-50/70 dark:border-emerald-900/55 dark:bg-emerald-950/24",
    over: "border-emerald-300/90 bg-emerald-100/82 dark:border-emerald-700/70 dark:bg-emerald-900/34",
  },
  cancelled: {
    base: "border-neutral-200/75 bg-neutral-50/70 dark:border-neutral-800/60 dark:bg-neutral-900/26",
    over: "border-neutral-300/85 bg-neutral-100/82 dark:border-neutral-700/75 dark:bg-neutral-800/36",
  },
};

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  onCreateIssue?: (status: string) => void;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

interface CreateIssueActionProps {
  status: string;
  onCreateIssue?: (status: string) => void;
}

function CreateIssueAction({ status, onCreateIssue }: CreateIssueActionProps) {
  if (!onCreateIssue) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="text-muted-foreground"
      data-testid={`kanban-column-add-${status}`}
      aria-label={`Create ${statusLabel(status)} issue`}
      onClick={() => onCreateIssue(status)}
    >
      <Plus className="h-3 w-3" />
    </Button>
  );
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  issues,
  agents,
  liveIssueIds,
  onCreateIssue,
}: {
  status: string;
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  onCreateIssue?: (status: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const columnScrollRef = useScrollbarActivityRef();
  const laneTone = laneSurfaceClasses[status] ?? laneSurfaceClasses.backlog;
  const setColumnRefs = useCallback((node: HTMLDivElement | null) => {
    setNodeRef(node);
    columnScrollRef(node);
  }, [columnScrollRef, setNodeRef]);

  return (
    <div className="flex h-full min-h-0 w-[260px] min-w-[260px] shrink-0 flex-col">
      <div className="flex items-center gap-2 px-2 py-2 mb-1">
        <StatusIcon status={status} />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {statusLabel(status)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <span className="text-xs text-muted-foreground/60 tabular-nums">
            {issues.length}
          </span>
          <CreateIssueAction status={status} onCreateIssue={onCreateIssue} />
        </div>
      </div>
      <div
        data-testid={`kanban-column-${status}`}
        ref={setColumnRefs}
        className={cn(
          "scrollbar-auto-hide flex-1 min-h-[120px] overflow-y-auto rounded-[calc(var(--radius-sm)-1px)] border p-1.5 space-y-1.5 transition-colors",
          isOver ? laneTone.over : laneTone.base,
        )}
      >
        <SortableContext
          items={issues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {issues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              isLive={liveIssueIds?.has(issue.id)}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

function HiddenKanbanStatus({
  status,
  issueCount,
  onCreateIssue,
}: {
  status: string;
  issueCount: number;
  onCreateIssue?: (status: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const laneTone = laneSurfaceClasses[status] ?? laneSurfaceClasses.backlog;

  return (
    <div
      ref={setNodeRef}
      data-testid={`kanban-hidden-column-${status}`}
      className={cn(
        "flex items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] border px-2 py-2 transition-colors",
        isOver ? laneTone.over : laneTone.base,
      )}
    >
      <StatusIcon status={status} />
      <span className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {statusLabel(status)}
      </span>
      <span className="text-xs text-muted-foreground/60 tabular-nums">
        {issueCount}
      </span>
      <CreateIssueAction status={status} onCreateIssue={onCreateIssue} />
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  isLive,
  isOverlay,
}: {
  issue: Issue;
  agents?: Agent[];
  isLive?: boolean;
  isOverlay?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "rounded-[calc(var(--radius-sm)-1px)] border bg-card p-2.5 cursor-grab active:cursor-grabbing transition-shadow",
        isDragging && !isOverlay ? "opacity-30" : "",
        isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm",
      )}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        className="block no-underline text-inherit"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        <div className="flex items-start gap-1.5 mb-1.5">
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {isLive && (
            <span className="relative flex h-2 w-2 shrink-0 mt-0.5">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          )}
        </div>
        <p className="text-sm leading-snug line-clamp-2 mb-2">{issue.title}</p>
        <div className="flex items-center gap-2">
          <PriorityIcon priority={issue.priority} />
          {issue.assigneeAgentId && (() => {
            const name = agentName(issue.assigneeAgentId);
            return name ? (
              <Identity name={name} size="xs" />
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                {issue.assigneeAgentId.slice(0, 8)}
              </span>
            );
          })()}
        </div>
      </Link>
    </div>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  liveIssueIds,
  onCreateIssue,
  onUpdateIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const boardScrollRef = useScrollbarActivityRef();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const columnIssues = useMemo(() => {
    const grouped: Record<string, Issue[]> = {};
    for (const status of boardStatuses) {
      grouped[status] = [];
    }
    for (const issue of issues) {
      if (grouped[issue.status]) {
        grouped[issue.status].push(issue);
      }
    }
    return grouped;
  }, [issues]);

  const visibleStatuses = useMemo(
    () => boardStatuses.filter((status) => (columnIssues[status]?.length ?? 0) > 0),
    [columnIssues],
  );
  const hiddenStatuses = useMemo(
    () => boardStatuses.filter((status) => (columnIssues[status]?.length ?? 0) === 0),
    [columnIssues],
  );

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    // Determine target status: the "over" could be a column id (status string)
    // or another card's id. Find which column the "over" belongs to.
    let targetStatus: string | null = null;

    if (boardStatuses.includes(over.id as string)) {
      targetStatus = over.id as string;
    } else {
      // It's a card - find which column it's in
      const targetIssue = issues.find((i) => i.id === over.id);
      if (targetIssue) {
        targetStatus = targetIssue.status;
      }
    }

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus });
    }
  }

  function handleDragOver(_event: DragOverEvent) {
    // Could be used for visual feedback; keeping simple for now
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div
          ref={boardScrollRef}
          className="scrollbar-auto-hide min-h-0 flex-1 overflow-x-auto overflow-y-hidden pb-3"
        >
          <div className="flex h-full min-h-full min-w-max items-stretch gap-3 pr-2">
            {visibleStatuses.map((status) => (
              <KanbanColumn
                key={status}
                status={status}
                issues={columnIssues[status] ?? []}
                agents={agents}
                liveIssueIds={liveIssueIds}
                onCreateIssue={onCreateIssue}
              />
            ))}
            {hiddenStatuses.length > 0 ? (
              <div
                data-testid="kanban-hidden-columns"
                className="flex h-full min-h-0 w-[228px] min-w-[228px] shrink-0 flex-col rounded-[calc(var(--radius-sm)+1px)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-inset)_78%,transparent)] p-2"
              >
                <div className="mb-2 flex items-center gap-2 px-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Hidden columns
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground/60 tabular-nums">
                    {hiddenStatuses.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {hiddenStatuses.map((status) => (
                    <HiddenKanbanStatus
                      key={status}
                      status={status}
                      issueCount={columnIssues[status]?.length ?? 0}
                      onCreateIssue={onCreateIssue}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard issue={activeIssue} agents={agents} isOverlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
