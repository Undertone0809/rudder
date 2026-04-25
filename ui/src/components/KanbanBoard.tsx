import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { formatChatAgentLabel } from "@/lib/agent-labels";
import { formatAssigneeUserLabel } from "@/lib/assignees";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { timeAgo } from "@/lib/timeAgo";
import { CalendarClock, FolderKanban, Plus, User } from "lucide-react";
import type { AgentRole, Issue } from "@rudder/shared";

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
  icon?: string | null;
  role: AgentRole;
  title: string | null;
}

interface ProjectOption {
  id: string;
  name: string;
}

export type IssueDisplayProperty =
  | "identifier"
  | "priority"
  | "assignee"
  | "labels"
  | "project"
  | "updated"
  | "created";

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  currentUserId?: string | null;
  displayProperties?: IssueDisplayProperty[];
  liveIssueIds?: Set<string>;
  projects?: ProjectOption[];
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
  currentUserId,
  displayProperties = ["identifier", "priority", "assignee"],
  liveIssueIds,
  recentlyDroppedIssueIds,
  projects,
  onCreateIssue,
}: {
  status: string;
  issues: Issue[];
  agents?: Agent[];
  currentUserId?: string | null;
  displayProperties?: IssueDisplayProperty[];
  liveIssueIds?: Set<string>;
  recentlyDroppedIssueIds?: Set<string>;
  projects?: ProjectOption[];
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
        data-over={isOver ? "true" : "false"}
        ref={setColumnRefs}
        className={cn(
          "motion-kanban-lane scrollbar-auto-hide flex-1 min-h-[120px] overflow-y-auto rounded-[calc(var(--radius-sm)-1px)] border p-1.5 space-y-1.5",
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
              currentUserId={currentUserId}
              displayProperties={displayProperties}
              isLive={liveIssueIds?.has(issue.id)}
              justDropped={recentlyDroppedIssueIds?.has(issue.id)}
              projects={projects}
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
      data-over={isOver ? "true" : "false"}
      className={cn(
        "motion-kanban-lane flex items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] border px-2 py-2",
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
  currentUserId,
  displayProperties = ["identifier", "priority", "assignee"],
  isLive,
  isOverlay,
  justDropped,
  projects,
}: {
  issue: Issue;
  agents?: Agent[];
  currentUserId?: string | null;
  displayProperties?: IssueDisplayProperty[];
  isLive?: boolean;
  isOverlay?: boolean;
  justDropped?: boolean;
  projects?: ProjectOption[];
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

  const visibleProperties = new Set(displayProperties);
  const agent = issue.assigneeAgentId
    ? agents?.find((candidate) => candidate.id === issue.assigneeAgentId) ?? null
    : null;
  const projectName = issue.projectId
    ? projects?.find((project) => project.id === issue.projectId)?.name ?? issue.project?.name ?? null
    : null;
  const showIdentifier = visibleProperties.has("identifier");
  const showPriority = visibleProperties.has("priority");
  const showAssignee = visibleProperties.has("assignee");
  const showLabels = visibleProperties.has("labels") && (issue.labels ?? []).length > 0;
  const showProject = visibleProperties.has("project") && Boolean(projectName);
  const showUpdated = visibleProperties.has("updated");
  const showCreated = visibleProperties.has("created");

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      data-testid={`kanban-card-${issue.identifier ?? issue.id}`}
      data-dragging={isDragging && !isOverlay ? "true" : "false"}
      data-overlay={isOverlay ? "true" : "false"}
      data-live={isLive ? "true" : "false"}
      data-just-dropped={justDropped ? "true" : "false"}
      className={cn(
        "motion-kanban-card overflow-hidden rounded-[calc(var(--radius-sm)-1px)] border bg-card p-2.5 cursor-grab active:cursor-grabbing",
        isDragging && !isOverlay ? "opacity-30" : "",
        isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm",
      )}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        className="block min-w-0 no-underline text-inherit"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        {(showIdentifier || isLive) ? (
          <div className="flex items-start gap-1.5 mb-1.5">
            {showIdentifier ? (
              <span className="text-xs text-muted-foreground font-mono shrink-0">
                {issue.identifier ?? issue.id.slice(0, 8)}
              </span>
            ) : null}
            {isLive && (
              <span className="motion-live-dot relative flex h-2 w-2 shrink-0 mt-0.5 text-blue-500">
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
            )}
          </div>
        ) : null}
        <p className="text-sm leading-snug line-clamp-2 mb-2">{issue.title}</p>
        {(showPriority || showAssignee) && (
          <div data-slot="kanban-card-metadata" className="flex min-w-0 items-center gap-2 overflow-hidden">
            {showPriority ? <PriorityIcon priority={issue.priority} /> : null}
            {showAssignee && issue.assigneeAgentId ? (
              agent ? (
                <Identity
                  name={formatChatAgentLabel(agent)}
                  size="xs"
                  className="min-w-0 flex-1 text-muted-foreground"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground font-mono">
                  {issue.assigneeAgentId.slice(0, 8)}
                </span>
              )
            ) : null}
            {showAssignee && issue.assigneeUserId ? (
              <span className="inline-flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
                <User className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {formatAssigneeUserLabel(issue.assigneeUserId, currentUserId) ?? "User"}
                </span>
              </span>
            ) : null}
          </div>
        )}
        {showLabels ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {(issue.labels ?? []).slice(0, 3).map((label) => (
              <span
                key={label.id}
                className="inline-flex max-w-full items-center truncate rounded-[calc(var(--radius-sm)-2px)] border px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  borderColor: label.color,
                  color: pickTextColorForPillBg(label.color, 0.12),
                  backgroundColor: `${label.color}1f`,
                }}
              >
                {label.name}
              </span>
            ))}
            {(issue.labels ?? []).length > 3 ? (
              <span className="text-[10px] text-muted-foreground">
                +{(issue.labels ?? []).length - 3}
              </span>
            ) : null}
          </div>
        ) : null}
        {(showProject || showUpdated || showCreated) ? (
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            {showProject ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderKanban className="h-3 w-3 shrink-0" />
                <span className="truncate">{projectName}</span>
              </span>
            ) : null}
            {showUpdated ? (
              <span className="flex items-center gap-1.5">
                <CalendarClock className="h-3 w-3 shrink-0" />
                <span>Updated {timeAgo(issue.updatedAt)}</span>
              </span>
            ) : null}
            {showCreated ? (
              <span className="flex items-center gap-1.5">
                <CalendarClock className="h-3 w-3 shrink-0" />
                <span>Created {timeAgo(issue.createdAt)}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </Link>
    </div>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  currentUserId,
  displayProperties,
  liveIssueIds,
  projects,
  onCreateIssue,
  onUpdateIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recentlyDroppedIssueIds, setRecentlyDroppedIssueIds] = useState<Set<string>>(new Set());
  const boardScrollRef = useScrollbarActivityRef();
  const dropTimersRef = useRef<number[]>([]);

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

  useEffect(() => {
    return () => {
      for (const timer of dropTimersRef.current) window.clearTimeout(timer);
      dropTimersRef.current = [];
    };
  }, []);

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
      setRecentlyDroppedIssueIds((prev) => {
        const next = new Set(prev);
        next.add(issueId);
        return next;
      });
      const timer = window.setTimeout(() => {
        setRecentlyDroppedIssueIds((prev) => {
          const next = new Set(prev);
          next.delete(issueId);
          return next;
        });
        dropTimersRef.current = dropTimersRef.current.filter((candidate) => candidate !== timer);
      }, 520);
      dropTimersRef.current.push(timer);
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
                currentUserId={currentUserId}
                displayProperties={displayProperties}
                liveIssueIds={liveIssueIds}
                recentlyDroppedIssueIds={recentlyDroppedIssueIds}
                projects={projects}
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
          <KanbanCard
            issue={activeIssue}
            agents={agents}
            currentUserId={currentUserId}
            displayProperties={displayProperties}
            isOverlay
            projects={projects}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
