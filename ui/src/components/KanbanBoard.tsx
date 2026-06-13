import { Button } from "@/components/ui/button";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { formatChatAgentLabel } from "@/lib/agent-labels";
import { formatAssigneeUserLabel } from "@/lib/assignees";
import { formatIssueCardDate } from "@/lib/issue-card-date";
import { sortIssues, type IssueSortState } from "@/lib/issue-sort";
import { formatPriorityLabel } from "@/lib/priorities";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AgentRole, Issue, IssueStatus, ReorderIssue } from "@rudderhq/shared";
import { CalendarClock, FolderKanban, Pin, Plus, Tags, User, UserCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AgentIcon } from "./AgentAvatar";
import { IssueLabelChip } from "./IssueLabelChip";
import { PriorityIcon } from "./PriorityIcon";
import { StatusIcon } from "./StatusIcon";

const boardStatuses: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

type KanbanIssueGroups = Record<IssueStatus, Issue[]>;
type KanbanDropOrderPreview = {
  laneIdsByStatus: Partial<Record<IssueStatus, string[]>>;
};

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

function createEmptyIssueGroups(): KanbanIssueGroups {
  const groups = {} as KanbanIssueGroups;
  for (const status of boardStatuses) {
    groups[status] = [];
  }
  return groups;
}

function issueIdsMatchLaneOrder(issues: Issue[], issueIds: string[]): boolean {
  if (issues.length !== issueIds.length) return false;
  return issues.every((issue, index) => issue.id === issueIds[index]);
}

export function applyKanbanDropOrderPreview(
  baseColumnIssues: KanbanIssueGroups,
  allIssues: Issue[],
  preview: KanbanDropOrderPreview | null,
): KanbanIssueGroups {
  if (!preview) return baseColumnIssues;

  const issueById = new Map(allIssues.map((issue) => [issue.id, issue]));
  const projected = Object.fromEntries(
    boardStatuses.map((status) => [status, [...baseColumnIssues[status]]]),
  ) as KanbanIssueGroups;

  for (const [status, issueIds] of Object.entries(preview.laneIdsByStatus) as [IssueStatus, string[]][]) {
    projected[status] = issueIds
      .map((issueId) => {
        const issue = issueById.get(issueId);
        if (!issue) return null;
        return issue.status === status ? issue : { ...issue, status };
      })
      .filter((issue): issue is Issue => Boolean(issue));
  }

  return projected;
}

export function doesKanbanDropOrderPreviewMatchBase(
  baseColumnIssues: KanbanIssueGroups,
  preview: KanbanDropOrderPreview,
): boolean {
  return (Object.entries(preview.laneIdsByStatus) as [IssueStatus, string[]][]).every(
    ([status, issueIds]) => issueIdsMatchLaneOrder(baseColumnIssues[status] ?? [], issueIds),
  );
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
  | "reviewer"
  | "labels"
  | "project"
  | "updated"
  | "created";

export const DEFAULT_ISSUE_DISPLAY_PROPERTIES: IssueDisplayProperty[] = [
  "identifier",
  "priority",
  "assignee",
  "reviewer",
  "labels",
  "project",
  "created",
];

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  currentUserId?: string | null;
  displayProperties?: IssueDisplayProperty[];
  sortState?: IssueSortState;
  liveIssueIds?: Set<string>;
  issueLinkState?: unknown;
  projects?: ProjectOption[];
  onCreateIssue?: (status: string) => void;
  onOpenIssue?: (issue: Issue) => void;
  pinnedIssueIds?: string[];
  onTogglePinnedIssue?: (issueId: string) => void;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
  onReorderIssue?: (data: ReorderIssue) => void;
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

function KanbanPersonMeta({
  relationship,
  agent,
  userId,
  fallbackId,
  currentUserId,
  showRole = true,
}: {
  relationship: "assignee" | "reviewer";
  agent?: Agent | null;
  userId?: string | null;
  fallbackId?: string | null;
  currentUserId?: string | null;
  showRole?: boolean;
}) {
  const roleLabel = relationship === "assignee" ? "Assignee" : "Reviewer";
  const displayName = agent
    ? formatChatAgentLabel(agent)
    : userId
      ? (formatAssigneeUserLabel(userId, currentUserId) ?? "User")
      : fallbackId
        ? fallbackId.slice(0, 8)
        : null;

  if (!displayName) return null;

  const Icon = relationship === "assignee" ? User : UserCheck;

  return (
    <span
      data-slot={`kanban-card-${relationship}`}
      title={`${roleLabel}: ${displayName}`}
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-sm bg-muted/35 px-1.5 py-1 text-muted-foreground ring-1 ring-border/35"
    >
      {showRole ? (
        <span
          data-slot="kanban-card-person-role"
          className="shrink-0 text-[10px] font-medium leading-none text-muted-foreground/75"
        >
          {roleLabel}
        </span>
      ) : null}
      {agent ? (
        <span className="inline-flex min-w-0 max-w-full flex-1 items-center gap-1 text-xs">
          <AgentIcon icon={agent.icon} role={agent.role} className="h-3 w-3 shrink-0" />
          <span className="truncate">{displayName}</span>
        </span>
      ) : (
        <span className="inline-flex min-w-0 max-w-full flex-1 items-center gap-1 text-xs">
          <Icon className="h-3 w-3 shrink-0" />
          <span className={cn("truncate", fallbackId && "font-mono")}>{displayName}</span>
        </span>
      )}
    </span>
  );
}

function KanbanMetadataRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div data-slot="kanban-card-metadata-row" className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-xs">
      <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground/75">
        <span className="shrink-0 text-muted-foreground/70">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      <span className="min-w-0 overflow-hidden text-right text-muted-foreground">{children}</span>
    </div>
  );
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  issues,
  agents,
  currentUserId,
  displayProperties = DEFAULT_ISSUE_DISPLAY_PROPERTIES,
  liveIssueIds,
  issueLinkState,
  recentlyDroppedIssueIds,
  projects,
  onCreateIssue,
  onOpenIssue,
  pinnedIssueIds = [],
  onTogglePinnedIssue,
}: {
  status: string;
  issues: Issue[];
  agents?: Agent[];
  currentUserId?: string | null;
  displayProperties?: IssueDisplayProperty[];
  liveIssueIds?: Set<string>;
  issueLinkState?: unknown;
  recentlyDroppedIssueIds?: Set<string>;
  projects?: ProjectOption[];
  onCreateIssue?: (status: string) => void;
  onOpenIssue?: (issue: Issue) => void;
  pinnedIssueIds?: string[];
  onTogglePinnedIssue?: (issueId: string) => void;
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
              issueLinkState={issueLinkState}
              justDropped={recentlyDroppedIssueIds?.has(issue.id)}
              projects={projects}
              onOpenIssue={onOpenIssue}
              pinnedIssueIds={pinnedIssueIds}
              onTogglePinnedIssue={onTogglePinnedIssue}
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
  displayProperties = DEFAULT_ISSUE_DISPLAY_PROPERTIES,
  isLive,
  issueLinkState,
  isOverlay,
  justDropped,
  projects,
  onOpenIssue,
  pinnedIssueIds = [],
  onTogglePinnedIssue,
}: {
  issue: Issue;
  agents?: Agent[];
  currentUserId?: string | null;
  displayProperties?: IssueDisplayProperty[];
  isLive?: boolean;
  issueLinkState?: unknown;
  isOverlay?: boolean;
  justDropped?: boolean;
  projects?: ProjectOption[];
  onOpenIssue?: (issue: Issue) => void;
  pinnedIssueIds?: string[];
  onTogglePinnedIssue?: (issueId: string) => void;
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
  const reviewerAgent = issue.reviewerAgentId
    ? agents?.find((candidate) => candidate.id === issue.reviewerAgentId) ?? null
    : null;
  const projectName = issue.projectId
    ? projects?.find((project) => project.id === issue.projectId)?.name ?? issue.project?.name ?? null
    : null;
  const showIdentifier = visibleProperties.has("identifier");
  const showPriority = visibleProperties.has("priority");
  const showAssignee = visibleProperties.has("assignee");
  const showReviewer = visibleProperties.has("reviewer") &&
    Boolean(issue.reviewerAgentId || issue.reviewerUserId);
  const showLabels = visibleProperties.has("labels") && (issue.labels ?? []).length > 0;
  const showProject = visibleProperties.has("project") && Boolean(projectName);
  const showUpdated = visibleProperties.has("updated");
  const showCreated = visibleProperties.has("created");
  const assigneeMeta = showAssignee ? (
    <KanbanPersonMeta
      relationship="assignee"
      agent={agent}
      userId={issue.assigneeUserId}
      fallbackId={!agent && issue.assigneeAgentId ? issue.assigneeAgentId : null}
      currentUserId={currentUserId}
      showRole={false}
    />
  ) : null;
  const reviewerMeta = showReviewer ? (
    <KanbanPersonMeta
      relationship="reviewer"
      agent={reviewerAgent}
      userId={issue.reviewerUserId}
      fallbackId={!reviewerAgent && issue.reviewerAgentId ? issue.reviewerAgentId : null}
      currentUserId={currentUserId}
      showRole={false}
    />
  ) : null;
  const isPinned = pinnedIssueIds.includes(issue.id);
  const hasPrimaryMeta = showPriority;
  const hasSecondaryMeta = Boolean(reviewerMeta || showProject || showLabels || showUpdated || showCreated);

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
        "motion-kanban-card group relative overflow-hidden rounded-[calc(var(--radius-sm)-1px)] border bg-card p-2.5 cursor-grab active:cursor-grabbing",
        isDragging && !isOverlay ? "opacity-30" : "",
        isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm",
      )}
    >
      {onTogglePinnedIssue ? (
        <button
          type="button"
          className="absolute right-2 top-2 z-20 inline-flex h-6 w-6 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] bg-card/90 text-muted-foreground opacity-0 shadow-sm ring-1 ring-[color:var(--border-soft)] transition-[opacity,background-color,color] hover:bg-accent hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
          title={isPinned ? "Unpin issue" : "Pin issue"}
          aria-label={isPinned ? "Unpin issue" : "Pin issue"}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onTogglePinnedIssue(issue.id);
          }}
        >
          <Pin
            className={cn(
              "h-3.5 w-3.5",
              isPinned && "fill-current text-[color:var(--accent-strong)]",
            )}
          />
        </button>
      ) : null}
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        state={issueLinkState}
        className="block min-w-0 no-underline text-inherit"
        onClick={(e) => {
          if (isDragging) {
            e.preventDefault();
            return;
          }
          onOpenIssue?.(issue);
        }}
      >
        <div data-slot="kanban-card-primary" className="space-y-2">
          {(showIdentifier || isLive || assigneeMeta) ? (
            <div className="flex min-w-0 items-start gap-2">
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                {showIdentifier ? (
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                ) : null}
                {isLive && (
                  <span className="motion-live-dot relative flex h-2 w-2 shrink-0 text-blue-500">
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                  </span>
                )}
              </span>
              {assigneeMeta ? (
                <span data-slot="kanban-card-primary-assignee" className="min-w-0 max-w-[8.5rem] shrink overflow-hidden">
                  {assigneeMeta}
                </span>
              ) : null}
            </div>
          ) : null}
          <p className="line-clamp-2 text-sm leading-snug">{issue.title}</p>
          {hasPrimaryMeta ? (
            <div data-slot="kanban-card-primary-metadata" className="flex min-w-0 items-center gap-2 overflow-hidden">
              {showPriority ? (
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                  title={`Priority: ${formatPriorityLabel(issue.priority)}`}
                >
                  <PriorityIcon priority={issue.priority} />
                  <span className="truncate">{formatPriorityLabel(issue.priority)}</span>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {hasSecondaryMeta ? (
          <div data-slot="kanban-card-metadata" className="mt-2 space-y-1.5 border-t border-[color:var(--border-soft)] pt-2">
            {showProject ? (
              <KanbanMetadataRow icon={<FolderKanban className="h-3 w-3" />} label="Project">
                <span className="block truncate">{projectName}</span>
              </KanbanMetadataRow>
            ) : null}
            {reviewerMeta ? (
              <KanbanMetadataRow icon={<UserCheck className="h-3 w-3" />} label="Reviewer">
                <span className="flex min-w-0 max-w-full justify-end overflow-hidden">{reviewerMeta}</span>
              </KanbanMetadataRow>
            ) : null}
            {showLabels ? (
              <KanbanMetadataRow icon={<Tags className="h-3 w-3" />} label="Labels">
                <span className="flex min-w-0 flex-wrap justify-end gap-1">
                  {(issue.labels ?? []).slice(0, 3).map((label) => (
                    <IssueLabelChip key={label.id} label={label} />
                  ))}
                  {(issue.labels ?? []).length > 3 ? (
                    <span className="text-[10px] text-muted-foreground">
                      +{(issue.labels ?? []).length - 3}
                    </span>
                  ) : null}
                </span>
              </KanbanMetadataRow>
            ) : null}
            {showUpdated ? (
              <KanbanMetadataRow icon={<CalendarClock className="h-3 w-3" />} label="Updated">
                {formatIssueCardDate(issue.updatedAt)}
              </KanbanMetadataRow>
            ) : null}
            {showCreated ? (
              <KanbanMetadataRow icon={<CalendarClock className="h-3 w-3" />} label="Created">
                {formatIssueCardDate(issue.createdAt)}
              </KanbanMetadataRow>
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
  sortState,
  liveIssueIds,
  issueLinkState,
  projects,
  onCreateIssue,
  onOpenIssue,
  pinnedIssueIds = [],
  onTogglePinnedIssue,
  onUpdateIssue,
  onReorderIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recentlyDroppedIssueIds, setRecentlyDroppedIssueIds] = useState<Set<string>>(new Set());
  const [dropOrderPreview, setDropOrderPreview] = useState<KanbanDropOrderPreview | null>(null);
  const boardScrollRef = useScrollbarActivityRef();
  const dropTimersRef = useRef<number[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const baseColumnIssues = useMemo(() => {
    const grouped = createEmptyIssueGroups();
    for (const issue of issues) {
      if (grouped[issue.status]) {
        grouped[issue.status].push(issue);
      }
    }
    if (sortState) {
      for (const status of boardStatuses) {
        grouped[status] = sortIssues(grouped[status] ?? [], sortState);
      }
    }
    return grouped;
  }, [issues, sortState]);

  const columnIssues = useMemo(
    () => applyKanbanDropOrderPreview(baseColumnIssues, issues, dropOrderPreview),
    [baseColumnIssues, issues, dropOrderPreview],
  );

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

  useEffect(() => {
    if (!dropOrderPreview) return;
    if (doesKanbanDropOrderPreviewMatchBase(baseColumnIssues, dropOrderPreview)) {
      setDropOrderPreview(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setDropOrderPreview(null);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [baseColumnIssues, dropOrderPreview]);

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
    let targetStatus: IssueStatus | null = null;

    if (boardStatuses.includes(over.id as IssueStatus)) {
      targetStatus = over.id as IssueStatus;
    } else {
      // It's a card - find which column it's in
      const targetIssue = issues.find((i) => i.id === over.id);
      if (targetIssue) {
        targetStatus = targetIssue.status;
      }
    }

    if (!targetStatus) return;

    const targetLane = columnIssues[targetStatus] ?? [];
    const targetLaneWithoutActive = targetLane.filter((candidate) => candidate.id !== issueId);
    let insertIndex = targetLaneWithoutActive.length;

    if (!boardStatuses.includes(over.id as IssueStatus)) {
      const overIndexInFullLane = targetLane.findIndex((candidate) => candidate.id === over.id);
      if (overIndexInFullLane >= 0) {
        insertIndex = overIndexInFullLane;
      }
    }

    const finalLane = [...targetLaneWithoutActive];
    finalLane.splice(insertIndex, 0, { ...issue, status: targetStatus });
    const movedIndex = finalLane.findIndex((candidate) => candidate.id === issueId);
    const previousIssueId = movedIndex > 0 ? finalLane[movedIndex - 1]?.id : null;
    const nextIssueId = movedIndex >= 0 && movedIndex < finalLane.length - 1 ? finalLane[movedIndex + 1]?.id : null;
    const position = previousIssueId ? (nextIssueId ? undefined : "end") : "start";
    const originalLaneIds = targetLane.map((candidate) => candidate.id).join("\n");
    const finalLaneIds = finalLane.map((candidate) => candidate.id).join("\n");

    if (targetStatus !== issue.status || originalLaneIds !== finalLaneIds) {
      const laneIdsByStatus: KanbanDropOrderPreview["laneIdsByStatus"] = {
        [targetStatus]: finalLane.map((candidate) => candidate.id),
      };
      if (targetStatus !== issue.status) {
        laneIdsByStatus[issue.status] = (columnIssues[issue.status] ?? [])
          .filter((candidate) => candidate.id !== issueId)
          .map((candidate) => candidate.id);
      }
      setDropOrderPreview({ laneIdsByStatus });
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
      if (onReorderIssue) {
        onReorderIssue({
          issueId,
          targetStatus,
          previousIssueId,
          nextIssueId,
          ...(position ? { position } : {}),
        });
      } else if (targetStatus !== issue.status) {
        onUpdateIssue(issueId, { status: targetStatus });
      }
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
                issueLinkState={issueLinkState}
                recentlyDroppedIssueIds={recentlyDroppedIssueIds}
                projects={projects}
                onCreateIssue={onCreateIssue}
                onOpenIssue={onOpenIssue}
                pinnedIssueIds={pinnedIssueIds}
                onTogglePinnedIssue={onTogglePinnedIssue}
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
            pinnedIssueIds={pinnedIssueIds}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
