import { useCallback, useMemo, useState } from "react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { findIssueLabelExactMatch, normalizeIssueLabelName, pickIssueLabelColor } from "@/lib/issue-labels";
import { Link } from "@/lib/router";
import type { Issue } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useOrganization } from "../context/OrganizationContext";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { projectColorBackgroundStyle } from "../lib/project-colors";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { AssigneeLabel } from "./AssigneeLabel";
import { AgentIdentity } from "./AgentAvatar";
import { formatDate, formatDateTime, cn, projectUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { User, Hexagon, ArrowUpRight, Tag, Plus } from "lucide-react";
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
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1">{children}</div>
    </div>
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
        <PropertyRow label={label}>
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
    <PropertyRow label={label}>
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

export function IssueProperties({ issue, onUpdate, inline }: IssuePropertiesProps) {
  const { selectedOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  const orgId = issue.orgId ?? selectedOrganizationId;
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labelSearch, setLabelSearch] = useState("");

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

  const projectName = (id: string | null) => {
    if (!id) return id?.slice(0, 8) ?? "None";
    const project = orderedProjects.find((p) => p.id === id);
    return project?.name ?? id.slice(0, 8);
  };
  const currentProject = issue.projectId
    ? orderedProjects.find((project) => project.id === issue.projectId) ?? null
    : null;
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
  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);

  const assignee = issue.assigneeAgentId
    ? agentById.get(issue.assigneeAgentId)
    : null;
  const userLabel = (userId: string | null | undefined) => formatAssigneeUserLabel(userId, currentUserId);
  const assigneeUserLabel = userLabel(issue.assigneeUserId);
  const creatorUserLabel = userLabel(issue.createdByUserId);

  const labelsTrigger = (issue.labels ?? []).length > 0 ? (
    <div className="flex items-center gap-1 flex-wrap">
      {(issue.labels ?? []).slice(0, 3).map((label) => (
        <span
          key={label.id}
          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border"
          style={{
            borderColor: label.color,
            backgroundColor: `${label.color}22`,
            color: pickTextColorForPillBg(label.color, 0.13),
          }}
        >
          {label.name}
        </span>
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
    <AssigneeLabel kind="agent" label={formatChatAgentLabel(assignee)} agentIcon={assignee.icon} />
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
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            !issue.assigneeAgentId && !issue.assigneeUserId && "bg-accent"
          )}
          onClick={() => { onUpdate({ assigneeAgentId: null, assigneeUserId: null }); setAssigneeOpen(false); }}
        >
          <AssigneeLabel kind="unassigned" label="No assignee" />
        </button>
        {currentUserId && (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
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
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
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
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              a.id === issue.assigneeAgentId && "bg-accent"
            )}
            onClick={() => { trackRecentAssignee(a.id); onUpdate({ assigneeAgentId: a.id, assigneeUserId: null }); setAssigneeOpen(false); }}
          >
            <AssigneeLabel kind="agent" label={formatChatAgentLabel(a)} agentIcon={a.icon} />
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
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-52"
        >
          {assigneeContent}
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
              className="text-sm hover:underline"
            >
              {issue.ancestors?.[0]?.title ?? issue.parentId.slice(0, 8)}
            </Link>
          </PropertyRow>
        )}

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
