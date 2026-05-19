import { useCallback, useMemo, useState } from "react";
import { findIssueLabelExactMatch, normalizeIssueLabelName, pickIssueLabelColor } from "@/lib/issue-labels";
import { Link } from "@/lib/router";
import type { Agent, Issue } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { agentTitleBadgeLabel, formatChatAgentLabel } from "../lib/agent-labels";
import { projectColorBackgroundStyle } from "../lib/project-colors";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { AssigneeLabel } from "./AssigneeLabel";
import { Identity } from "./Identity";
import { AgentIdentity } from "./AgentAvatar";
import { IssueLabelChip } from "./IssueLabelChip";
import { formatDate, formatDateTime, cn, projectUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { User, Hexagon, ArrowUpRight, Tag, Plus, AlertTriangle, ListTree } from "lucide-react";
import { AgentIcon } from "./AgentIconPicker";

function defaultProjectWorkspaceIdForProject(project: {
  workspaces?: Array<{ id: string; isPrimary: boolean }>;
  executionWorkspacePolicy?: { defaultProjectWorkspaceId?: string | null } | null;
  codebase?: { scope?: string | null } | null;
} | null | undefined) {
  if (!project) return null;
  if (project.codebase?.scope === "organization" || project.codebase?.scope === "none") {
    return project.executionWorkspacePolicy?.defaultProjectWorkspaceId ?? null;
  }
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? null;
}

interface IssuePropertiesProps {
  issue: Issue;
  onUpdate: (data: Record<string, unknown>) => void;
  inline?: boolean;
  childIssues?: Issue[];
}

function PropertyRow({
  label,
  children,
  align = "center",
}: {
  label: string;
  children: React.ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div
      data-slot="issue-property-row"
      data-align={align}
      className={cn("flex gap-3 py-1.5", align === "start" ? "items-start" : "items-center")}
    >
      <span className="text-xs text-muted-foreground shrink-0 w-20">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1">{children}</div>
    </div>
  );
}

function AgentMenuLabel({ agent }: { agent: Pick<Agent, "name" | "role" | "title" | "icon"> }) {
  const supportingLabel = agentTitleBadgeLabel(agent);

  return (
    <span data-slot="agent-menu-label" className="flex min-w-0 flex-1 items-center gap-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/40 text-muted-foreground">
        <AgentIcon icon={agent.icon} role={agent.role} className="h-3.5 w-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-xs font-medium leading-4 text-foreground">{agent.name}</span>
        {supportingLabel ? (
          <span data-slot="agent-menu-supporting-label" className="truncate text-[11px] leading-3 text-muted-foreground">
            {supportingLabel}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** Renders a Popover on desktop, or an inline collapsible section on mobile (inline mode). */
function PropertyPicker({
  inline,
  label,
  open,
  onOpenChange,
  triggerContent,
  triggerClassName,
  popoverClassName,
  popoverAlign = "end",
  rowAlign = "center",
  extra,
  children,
}: {
  inline?: boolean;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerContent: React.ReactNode;
  triggerClassName?: string;
  popoverClassName?: string;
  popoverAlign?: "start" | "center" | "end";
  rowAlign?: "center" | "start";
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const btnCn = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors",
    triggerClassName,
  );

  if (inline) {
    return (
      <div>
        <PropertyRow label={label} align={rowAlign}>
          <button className={btnCn} onClick={() => onOpenChange(!open)}>
            {triggerContent}
          </button>
          {extra}
        </PropertyRow>
        {open && (
          <div className={cn("rounded-md border border-border bg-popover p-1 mb-2", popoverClassName)}>
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <PropertyRow label={label} align={rowAlign}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button className={btnCn}>{triggerContent}</button>
        </PopoverTrigger>
        <PopoverContent className={cn("p-1", popoverClassName)} align={popoverAlign} collisionPadding={16}>
          {children}
        </PopoverContent>
      </Popover>
      {extra}
    </PropertyRow>
  );
}

export function IssueProperties({
  issue,
  onUpdate,
  inline,
  childIssues,
}: IssuePropertiesProps) {
  const { selectedOrganizationId } = useOrganization();
  const { openNewIssue } = useDialog();
  const queryClient = useQueryClient();
  const orgId = issue.orgId ?? selectedOrganizationId;
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [reviewerOpen, setReviewerOpen] = useState(false);
  const [reviewerSearch, setReviewerSearch] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labelSearch, setLabelSearch] = useState("");
  const assigneeScrollRef = useScrollbarActivityRef();
  const reviewerScrollRef = useScrollbarActivityRef();

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(orgId!),
    queryFn: () => agentsApi.list(orgId!),
    enabled: !!orgId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(orgId!),
    queryFn: () => projectsApi.list(orgId!),
    enabled: !!orgId,
  });
  const activeProjects = useMemo(
    () => (projects ?? []).filter((p) => !p.archivedAt || p.id === issue.projectId),
    [projects, issue.projectId],
  );
  const { orderedProjects } = useProjectOrder({
    projects: activeProjects,
    orgId,
    userId: currentUserId,
  });

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(orgId!),
    queryFn: () => issuesApi.listLabels(orgId!),
    enabled: !!orgId,
  });

  const createLabel = useMutation({
    mutationFn: (data: { name: string; color: string }) => issuesApi.createLabel(orgId!, data),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(orgId!) });
      onUpdate({ labelIds: [...(issue.labelIds ?? []), created.id] });
      setLabelSearch("");
    },
  });

  const toggleLabel = (labelId: string) => {
    const ids = issue.labelIds ?? [];
    const next = ids.includes(labelId)
      ? ids.filter((id) => id !== labelId)
      : [...ids, labelId];
    onUpdate({ labelIds: next });
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    const agent = agents.find((a) => a.id === id);
    return agent?.name ?? id.slice(0, 8);
  };
  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);

  const projectName = (id: string | null) => {
    if (!id) return id?.slice(0, 8) ?? "None";
    const project = orderedProjects.find((p) => p.id === id);
    return project?.name ?? id.slice(0, 8);
  };
  const currentProject = issue.projectId
    ? orderedProjects.find((project) => project.id === issue.projectId) ?? null
    : null;
  const visibleChildIssues = useMemo(() => (childIssues ?? []).slice(0, 5), [childIssues]);
  const openSubIssueComposer = () => {
    openNewIssue({
      parentId: issue.id,
      parentIssue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      },
      ...(issue.projectId ? { projectId: issue.projectId } : {}),
    });
  };
  const projectLink = (id: string | null) => {
    if (!id) return null;
    const project = projects?.find((p) => p.id === id) ?? null;
    return project ? projectUrl(project) : `/projects/${id}`;
  };

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [assigneeOpen]);
  const sortedAgents = useMemo(
    () => sortAgentsByRecency((agents ?? []).filter((a) => a.status !== "terminated"), recentAssigneeIds),
    [agents, recentAssigneeIds],
  );

  const assignee = issue.assigneeAgentId
    ? agents?.find((a) => a.id === issue.assigneeAgentId)
    : null;
  const reviewer = issue.reviewerAgentId
    ? agents?.find((a) => a.id === issue.reviewerAgentId)
    : null;
  const userLabel = (userId: string | null | undefined) => formatAssigneeUserLabel(userId, currentUserId);
  const assigneeUserLabel = userLabel(issue.assigneeUserId);
  const reviewerUserLabel = userLabel(issue.reviewerUserId);
  const creatorUserLabel = userLabel(issue.createdByUserId);
  const reviewerMatchesAssignee = Boolean(
    (issue.reviewerAgentId && issue.reviewerAgentId === issue.assigneeAgentId) ||
      (issue.reviewerUserId && issue.reviewerUserId === issue.assigneeUserId),
  );

  const labelsTrigger = (issue.labels ?? []).length > 0 ? (
    <div className="flex items-center gap-1 flex-wrap">
      {(issue.labels ?? []).slice(0, 3).map((label) => (
        <IssueLabelChip key={label.id} label={label} size="sm" />
      ))}
      {(issue.labels ?? []).length > 3 && (
        <span className="text-xs text-muted-foreground">+{(issue.labels ?? []).length - 3}</span>
      )}
    </div>
  ) : (
    <>
      <Tag className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">No labels</span>
    </>
  );

  const normalizedLabelQuery = normalizeIssueLabelName(labelSearch);
  const visibleLabels = useMemo(
    () =>
      (labels ?? []).filter((label) => {
        if (!normalizedLabelQuery) return true;
        return label.name.toLowerCase().includes(normalizedLabelQuery.toLowerCase());
      }),
    [labels, normalizedLabelQuery],
  );
  const exactLabelMatch = useMemo(
    () => findIssueLabelExactMatch(labels ?? [], normalizedLabelQuery),
    [labels, normalizedLabelQuery],
  );
  const shouldShowCreateLabelOption =
    normalizedLabelQuery.length > 0 &&
    visibleLabels.length === 0 &&
    !exactLabelMatch;
  const createLabelColor = pickIssueLabelColor(normalizedLabelQuery);

  const createLabelFromSearch = useCallback(() => {
    if (!shouldShowCreateLabelOption || createLabel.isPending) return;
    createLabel.mutate({
      name: normalizedLabelQuery,
      color: createLabelColor,
    });
  }, [createLabel, createLabelColor, normalizedLabelQuery, shouldShowCreateLabelOption]);

  const labelsContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search labels..."
        value={labelSearch}
        onChange={(e) => setLabelSearch(e.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !shouldShowCreateLabelOption) return;
          event.preventDefault();
          createLabelFromSearch();
        }}
        autoFocus={!inline}
      />
      <div className="max-h-44 overflow-y-auto overscroll-contain space-y-0.5">
        {visibleLabels.map((label) => {
            const selected = (issue.labelIds ?? []).includes(label.id);
            return (
              <button
                key={label.id}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                  selected && "bg-accent"
                )}
                onClick={() => toggleLabel(label.id)}
              >
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
                <span className="truncate">{label.name}</span>
              </button>
            );
          })}
        {shouldShowCreateLabelOption && (
          <>
            {visibleLabels.length > 0 ? <div className="my-1 border-t border-border" /> : null}
            <button
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left"
              disabled={createLabel.isPending}
              onClick={createLabelFromSearch}
            >
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-border/70 text-muted-foreground">
                <Plus className="h-2.5 w-2.5" />
              </span>
              <span className="truncate">
                {createLabel.isPending ? "Creating…" : `Create label "${normalizedLabelQuery}"`}
              </span>
              <span
                className="ml-auto h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: createLabelColor }}
                aria-hidden="true"
              />
            </button>
          </>
        )}
      </div>
    </>
  );

  const assigneeTrigger = assignee ? (
    <AssigneeLabel
      kind="agent"
      label={assignee.name}
      badgeLabel={agentTitleBadgeLabel(assignee)}
      agentIcon={assignee.icon}
      agentRole={assignee.role}
      layout="stacked"
    />
  ) : assigneeUserLabel ? (
    <AssigneeLabel kind="user" label={assigneeUserLabel} />
  ) : (
    <AssigneeLabel kind="unassigned" label="Unassigned" muted />
  );

  const assigneeContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search assignees..."
        value={assigneeSearch}
        onChange={(e) => setAssigneeSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div
        ref={assigneeScrollRef}
        data-testid="issue-properties-assignee-scroll"
        className="scrollbar-auto-hide max-h-60 overflow-y-auto overscroll-contain"
      >
        <button
          className={cn(
            "flex min-w-0 items-center gap-2 w-full px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50",
            !issue.assigneeAgentId && !issue.assigneeUserId && "bg-accent"
          )}
          onClick={() => { onUpdate({ assigneeAgentId: null, assigneeUserId: null }); setAssigneeOpen(false); }}
        >
          <AssigneeLabel kind="unassigned" label="No assignee" />
        </button>
        {currentUserId && (
          <button
            className={cn(
              "flex min-w-0 items-center gap-2 w-full px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50",
              issue.assigneeUserId === currentUserId && "bg-accent",
            )}
            onClick={() => {
              onUpdate({ assigneeAgentId: null, assigneeUserId: currentUserId });
              setAssigneeOpen(false);
            }}
          >
            <AssigneeLabel kind="user" label="Assign to me" />
          </button>
        )}
        {issue.createdByUserId && issue.createdByUserId !== currentUserId && (
          <button
            className={cn(
              "flex min-w-0 items-center gap-2 w-full px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50",
              issue.assigneeUserId === issue.createdByUserId && "bg-accent",
            )}
            onClick={() => {
              onUpdate({ assigneeAgentId: null, assigneeUserId: issue.createdByUserId });
              setAssigneeOpen(false);
            }}
          >
            <AssigneeLabel
              kind="user"
              label={creatorUserLabel ? `Assign to ${creatorUserLabel}` : "Assign to requester"}
            />
          </button>
        )}
        {sortedAgents
          .filter((a) => {
            if (!assigneeSearch.trim()) return true;
            const q = assigneeSearch.toLowerCase();
            return `${formatChatAgentLabel(a)} ${a.name} ${a.role} ${a.title ?? ""}`.toLowerCase().includes(q);
          })
          .map((a) => (
          <button
            key={a.id}
            className={cn(
              "flex min-w-0 items-center gap-2 w-full px-2 py-2 text-left text-xs rounded hover:bg-accent/50",
              a.id === issue.assigneeAgentId && "bg-accent"
            )}
            onClick={() => { trackRecentAssignee(a.id); onUpdate({ assigneeAgentId: a.id, assigneeUserId: null }); setAssigneeOpen(false); }}
          >
            <AgentMenuLabel agent={a} />
          </button>
        ))}
      </div>
    </>
  );

  const reviewerTrigger = reviewer ? (
    <AssigneeLabel
      kind="agent"
      label={reviewer.name}
      badgeLabel={agentTitleBadgeLabel(reviewer)}
      agentIcon={reviewer.icon}
      agentRole={reviewer.role}
      layout="stacked"
    />
  ) : reviewerUserLabel ? (
    <AssigneeLabel kind="user" label={reviewerUserLabel} />
  ) : (
    <AssigneeLabel kind="unassigned" label="No reviewer" muted />
  );

  const reviewerContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search reviewers..."
        value={reviewerSearch}
        onChange={(e) => setReviewerSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div
        ref={reviewerScrollRef}
        data-testid="issue-properties-reviewer-scroll"
        className="scrollbar-auto-hide max-h-60 overflow-y-auto overscroll-contain"
      >
        <button
          className={cn(
            "flex min-w-0 items-center gap-2 w-full px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50",
            !issue.reviewerAgentId && !issue.reviewerUserId && "bg-accent"
          )}
          onClick={() => { onUpdate({ reviewerAgentId: null, reviewerUserId: null }); setReviewerOpen(false); }}
        >
          <AssigneeLabel kind="unassigned" label="No reviewer" />
        </button>
        {currentUserId && (
          <button
            className={cn(
              "flex min-w-0 items-center gap-2 w-full px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50",
              issue.reviewerUserId === currentUserId && "bg-accent",
            )}
            onClick={() => {
              onUpdate({ reviewerAgentId: null, reviewerUserId: currentUserId });
              setReviewerOpen(false);
            }}
          >
            <AssigneeLabel kind="user" label="Me" />
          </button>
        )}
        {sortedAgents
          .filter((a) => {
            if (!reviewerSearch.trim()) return true;
            const q = reviewerSearch.toLowerCase();
            return `${formatChatAgentLabel(a)} ${a.name} ${a.role} ${a.title ?? ""}`.toLowerCase().includes(q);
          })
          .map((a) => (
          <button
            key={a.id}
            className={cn(
              "flex min-w-0 items-center gap-2 w-full px-2 py-2 text-left text-xs rounded hover:bg-accent/50",
              a.id === issue.reviewerAgentId && "bg-accent"
            )}
            onClick={() => { trackRecentAssignee(a.id); onUpdate({ reviewerAgentId: a.id, reviewerUserId: null }); setReviewerOpen(false); }}
          >
            <AgentMenuLabel agent={a} />
          </button>
        ))}
      </div>
    </>
  );

  const projectTrigger = issue.projectId ? (
    <>
      <span
        className="shrink-0 h-3 w-3 rounded-sm"
        style={projectColorBackgroundStyle(orderedProjects.find((p) => p.id === issue.projectId)?.color)}
      />
      <span className="text-sm truncate">{projectName(issue.projectId)}</span>
    </>
  ) : (
    <>
      <Hexagon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">No project</span>
    </>
  );

  const projectContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search projects..."
        value={projectSearch}
        onChange={(e) => setProjectSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 whitespace-nowrap",
            !issue.projectId && "bg-accent"
          )}
          onClick={() => {
            onUpdate({
              projectId: null,
              projectWorkspaceId: null,
            });
            setProjectOpen(false);
          }}
        >
          No project
        </button>
        {orderedProjects
          .filter((p) => {
            if (!projectSearch.trim()) return true;
            const q = projectSearch.toLowerCase();
            return p.name.toLowerCase().includes(q);
          })
          .map((p) => (
          <button
            key={p.id}
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 whitespace-nowrap",
              p.id === issue.projectId && "bg-accent"
            )}
            onClick={() => {
              onUpdate({
                projectId: p.id,
                projectWorkspaceId: defaultProjectWorkspaceIdForProject(p),
              });
              setProjectOpen(false);
            }}
          >
            <span
              className="shrink-0 h-3 w-3 rounded-sm"
              style={projectColorBackgroundStyle(p.color)}
            />
            {p.name}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Status">
          <StatusIcon
            status={issue.status}
            onChange={(status) => onUpdate({ status })}
            showLabel
          />
        </PropertyRow>

        <PropertyRow label="Priority">
          <PriorityIcon
            priority={issue.priority}
            onChange={(priority) => onUpdate({ priority })}
            showLabel
          />
        </PropertyRow>

        <PropertyPicker
          inline={inline}
          label="Labels"
          open={labelsOpen}
          onOpenChange={(open) => { setLabelsOpen(open); if (!open) setLabelSearch(""); }}
          triggerContent={labelsTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-64"
        >
          {labelsContent}
        </PropertyPicker>

        <PropertyPicker
          inline={inline}
          label="Assignee"
          open={assigneeOpen}
          onOpenChange={(open) => { setAssigneeOpen(open); if (!open) setAssigneeSearch(""); }}
          triggerContent={assigneeTrigger}
          triggerClassName="min-w-0 w-full max-w-full justify-start"
          popoverClassName="w-[19rem]"
          popoverAlign="start"
          rowAlign="start"
        >
          {assigneeContent}
        </PropertyPicker>

        <PropertyPicker
          inline={inline}
          label="Reviewer"
          open={reviewerOpen}
          onOpenChange={(open) => { setReviewerOpen(open); if (!open) setReviewerSearch(""); }}
          triggerContent={reviewerTrigger}
          triggerClassName="min-w-0 w-full max-w-full justify-start"
          popoverClassName="w-[19rem]"
          popoverAlign="start"
          rowAlign="start"
          extra={reviewerMatchesAssignee ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <AlertTriangle className="h-3 w-3" />
              Same as assignee
            </span>
          ) : undefined}
        >
          {reviewerContent}
        </PropertyPicker>

        <PropertyPicker
          inline={inline}
          label="Project"
          open={projectOpen}
          onOpenChange={(open) => { setProjectOpen(open); if (!open) setProjectSearch(""); }}
          triggerContent={projectTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-fit min-w-[11rem]"
          extra={issue.projectId ? (
            <Link
              to={projectLink(issue.projectId)!}
              className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : undefined}
        >
          {projectContent}
        </PropertyPicker>

        {issue.parentId && (
          <PropertyRow label="Parent">
            <Link
              to={`/issues/${issue.ancestors?.[0]?.identifier ?? issue.parentId}`}
              className="min-w-0 truncate text-sm hover:underline"
            >
              {issue.ancestors?.[0]?.title ?? issue.parentId.slice(0, 8)}
            </Link>
          </PropertyRow>
        )}

        {childIssues ? (
          <div className="py-1.5">
            <div className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">Sub-issues</span>
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/50 disabled:pointer-events-none"
                  onClick={openSubIssueComposer}
                  aria-label="Create sub-issue"
                >
                  <ListTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
                    {childIssues.length}
                  </span>
                </button>
                <button
                  type="button"
                  className="ml-auto inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                  onClick={openSubIssueComposer}
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
              </div>
            </div>

            <div className={cn("mt-1.5 min-w-0 space-y-1", inline ? "ml-0" : "ml-[5.75rem]")}>
              {visibleChildIssues.length === 0 ? (
                <button
                  type="button"
                  className="w-full rounded px-1 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                  onClick={openSubIssueComposer}
                >
                  No sub-issues.
                </button>
              ) : (
                visibleChildIssues.map((child) => {
                  const childPathId = child.identifier ?? child.id;
                  const childLabel = child.identifier ?? child.id.slice(0, 8);

                  return (
                    <Link
                      key={child.id}
                      to={`/issues/${childPathId}`}
                      className="grid max-w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 overflow-hidden rounded px-1 py-1 text-xs transition-colors hover:bg-accent/50"
                      title={child.title}
                    >
                      <StatusIcon status={child.status} />
                      <span className="min-w-0 flex-1 truncate">{child.title}</span>
                      <span className="min-w-0 max-w-[5.5rem] truncate font-mono text-[11px] text-muted-foreground">
                        {childLabel}
                      </span>
                    </Link>
                  );
                })
              )}
              {childIssues.length > visibleChildIssues.length ? (
                <p className="px-1 text-[11px] text-muted-foreground">
                  +{childIssues.length - visibleChildIssues.length} more
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {issue.requestDepth > 0 && (
          <PropertyRow label="Depth">
            <span className="text-sm font-mono">{issue.requestDepth}</span>
          </PropertyRow>
        )}
      </div>

      <Separator />

      <div className="space-y-1">
        {(issue.createdByAgentId || issue.createdByUserId) && (
          <PropertyRow label="Created by">
            {issue.createdByAgentId ? (
              <Link
                to={`/agents/${issue.createdByAgentId}`}
                className="hover:underline"
              >
                <AgentIdentity
                  name={agentName(issue.createdByAgentId) ?? issue.createdByAgentId.slice(0, 8)}
                  icon={issue.createdByAgentId ? agentById.get(issue.createdByAgentId)?.icon : null}
                  role={issue.createdByAgentId ? agentById.get(issue.createdByAgentId)?.role : null}
                  size="sm"
                />
              </Link>
            ) : (
              <>
                <User className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm">{creatorUserLabel ?? "User"}</span>
              </>
            )}
          </PropertyRow>
        )}
        {issue.startedAt && (
          <PropertyRow label="Started">
            <span className="text-sm">{formatDate(issue.startedAt)}</span>
          </PropertyRow>
        )}
        {issue.completedAt && (
          <PropertyRow label="Completed">
            <span className="text-sm">{formatDate(issue.completedAt)}</span>
          </PropertyRow>
        )}
        <PropertyRow label="Created">
          <span className="text-sm">{formatDateTime(issue.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{timeAgo(issue.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
