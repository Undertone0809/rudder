import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { chatsApi } from "../api/chats";
import { activityApi } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { organizationSkillsApi } from "../api/organizationSkills";
import { projectsApi } from "../api/projects";
import { useOrganization } from "../context/OrganizationContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { assigneeValueFromSelection, suggestedCommentAssigneeValue } from "../lib/assignees";
import { buildAgentSkillMentionOptions } from "../lib/agent-skill-mentions";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { queryKeys } from "../lib/queryKeys";
import { readIssueDetailBreadcrumb } from "../lib/issueDetailBreadcrumb";
import { resolveBoardActorLabel } from "../lib/activity-actors";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { relativeTime, cn, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { InlineEditor } from "../components/InlineEditor";
import { CommentThread } from "../components/CommentThread";
import { IssueDocumentsSection } from "../components/IssueDocumentsSection";
import { IssueProperties } from "../components/IssueProperties";
import { LiveRunWidget } from "../components/LiveRunWidget";
import type { MentionOption } from "../components/MarkdownEditor";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity as ActivityIcon,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  EyeOff,
  Hexagon,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Repeat,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { ActivityEvent } from "@rudderhq/shared";
import type { Agent, Issue, IssueAttachment } from "@rudderhq/shared";

type CommentReassignment = {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.passive_followup_queued": "queued passive follow-up",
  "issue.closure_needs_operator_review": "needs operator review for close-out",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.document_created": "created a document",
  "issue.document_updated": "updated a document",
  "issue.document_deleted": "deleted a document",
  "issue.deleted": "deleted the issue",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

const issueStatusOptions = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
  "blocked",
] as const;

function issueStatusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function isMarkdownFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    file.type === "text/markdown"
  );
}

function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatAction(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (details.status !== undefined) {
      const from = previous.status;
      parts.push(
        from
          ? `changed the status from ${humanizeValue(from)} to ${humanizeValue(details.status)}`
          : `changed the status to ${humanizeValue(details.status)}`
      );
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      parts.push(
        from
          ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
          : `changed the priority to ${humanizeValue(details.priority)}`
      );
    }
    if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
      parts.push(
        details.assigneeAgentId || details.assigneeUserId
          ? "assigned the issue"
          : "unassigned the issue",
      );
    }
    if (details.title !== undefined) parts.push("updated the title");
    if (details.description !== undefined) parts.push("updated the description");

    if (parts.length > 0) return parts.join(", ");
  }
  if (
    (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted") &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ACTION_LABELS[action] ?? action} ${key}${title}`;
  }
  if (action === "issue.passive_followup_queued" && details) {
    const attempt = typeof details.attempt === "number" ? details.attempt : null;
    const maxAttempts = typeof details.maxAttempts === "number" ? details.maxAttempts : null;
    const followupRunId = typeof details.followupRunId === "string" ? details.followupRunId : null;
    const attemptLabel = attempt && maxAttempts ? ` (${attempt}/${maxAttempts})` : "";
    return `queued passive follow-up${attemptLabel}${followupRunId ? ` as run ${followupRunId.slice(0, 8)}` : ""}`;
  }
  if (action === "issue.closure_needs_operator_review" && details) {
    const attempts = typeof details.attempts === "number" ? details.attempts : null;
    return attempts
      ? `stopped passive follow-up after ${attempts} attempts; operator review needed`
      : "stopped passive follow-up; operator review needed";
  }
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

function issueActivityChatLabel(evt: ActivityEvent): string {
  const details = asRecord(evt.details);
  const title = typeof details?.conversationTitle === "string" ? details.conversationTitle.trim() : "";
  return title || `Chat ${evt.entityId.slice(0, 8)}`;
}

function renderActivityDescription(evt: ActivityEvent): ReactNode {
  const details = asRecord(evt.details);
  if (evt.entityType === "chat") {
    const chatHref = `/chat/${evt.entityId}`;
    const label = issueActivityChatLabel(evt);
    const link = (
      <Link to={chatHref} className="underline underline-offset-4 hover:text-foreground">
        {label}
      </Link>
    );

    if (evt.action === "chat.issue_converted") {
      return <>created this issue from {link}</>;
    }
    if (evt.action === "chat.context_linked") {
      return <>linked this issue in {link}</>;
    }
    if (evt.action === "chat.created") {
      return <>started {link} with this issue linked</>;
    }
  }

  return formatAction(evt.action, details);
}

function shouldHandleIssueDetailEscape(event: KeyboardEvent) {
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

function ActorIdentity({
  evt,
  agentMap,
  currentBoardUserId,
}: {
  evt: ActivityEvent;
  agentMap: Map<string, Agent>;
  currentBoardUserId?: string | null;
}) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return <Identity name={agent?.name ?? id.slice(0, 8)} size="sm" />;
  }
  return <Identity name={resolveBoardActorLabel(evt.actorType, id, currentBoardUserId)} size="sm" />;
}

export function IssueDetail() {
  const { issueId } = useParams<{ issueId: string }>();
  const { organizations, selectedOrganizationId, selectedOrganization } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { pushToast } = useToast();
  const [headerMoreOpen, setHeaderMoreOpen] = useState(false);
  const [sidebarMoreOpen, setSidebarMoreOpen] = useState(false);
  const [copiedIssueId, setCopiedIssueId] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [detailTab, setDetailTab] = useState("comments");
  const [subIssueComposerOpen, setSubIssueComposerOpen] = useState(false);
  const [subIssueTitle, setSubIssueTitle] = useState("");
  const [subIssueStatusPickerIssueId, setSubIssueStatusPickerIssueId] = useState<string | null>(null);
  const [updatingSubIssueId, setUpdatingSubIssueId] = useState<string | null>(null);
  const [secondaryOpen, setSecondaryOpen] = useState({
    approvals: false,
  });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastMarkedReadIssueIdRef = useRef<string | null>(null);

  const { data: issue, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
  });
  const resolvedCompanyId = issue?.orgId ?? selectedOrganizationId;

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId,
  });

  const { data: activity } = useQuery({
    queryKey: queryKeys.issues.activity(issueId!),
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!issueId,
  });

  const { data: linkedRuns } = useQuery({
    queryKey: queryKeys.issues.runs(issueId!),
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 5000,
  });

  const { data: linkedApprovals } = useQuery({
    queryKey: queryKeys.issues.approvals(issueId!),
    queryFn: () => issuesApi.listApprovals(issueId!),
    enabled: !!issueId,
  });

  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId!),
    queryFn: () => issuesApi.listAttachments(issueId!),
    enabled: !!issueId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId!),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId!),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId!),
    enabled: !!issueId,
    refetchInterval: 3000,
  });

  const hasLiveRuns = (liveRuns ?? []).length > 0 || !!activeRun;
  const sourceBreadcrumb = useMemo(
    () => readIssueDetailBreadcrumb(location.state) ?? { label: "Issues", href: "/issues" },
    [location.state],
  );
  const ancestors = issue?.ancestors ?? [];
  const issueHeaderBreadcrumbs = useMemo(() => {
    const currentLabel = issue?.title ?? issueId ?? "Issue";
    return [
      sourceBreadcrumb,
      ...[...ancestors].reverse().map((ancestor) => ({
        label: ancestor.title,
        href: `/issues/${ancestor.identifier ?? ancestor.id}`,
      })),
      { label: currentLabel, href: null },
    ];
  }, [ancestors, issue?.title, issueId, sourceBreadcrumb]);

  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>();
    for (const r of liveRuns ?? []) liveIds.add(r.id);
    if (activeRun) liveIds.add(activeRun.id);
    if (liveIds.size === 0) return linkedRuns ?? [];
    return (linkedRuns ?? []).filter((r) => !liveIds.has(r.runId));
  }, [linkedRuns, liveRuns, activeRun]);

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(resolvedCompanyId ?? "__none__"),
    queryFn: () => issuesApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });

  const { data: childIssues = [] } = useQuery({
    queryKey: queryKeys.issues.children(resolvedCompanyId ?? "__none__", issue?.id ?? "__none__"),
    queryFn: () => issuesApi.list(resolvedCompanyId!, { parentId: issue!.id }),
    enabled: !!resolvedCompanyId && !!issue?.id,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });

  const { data: assigneeOrganizationSkills } = useQuery({
    queryKey: queryKeys.organizationSkills.list(resolvedCompanyId ?? "__none__"),
    queryFn: () => organizationSkillsApi.list(resolvedCompanyId!),
    enabled: Boolean(resolvedCompanyId) && Boolean(issue?.assigneeAgentId),
  });

  const { data: assigneeSkillSnapshot } = useQuery({
    queryKey: queryKeys.agents.skills(issue?.assigneeAgentId ?? "__none__"),
    queryFn: () => agentsApi.skills(issue!.assigneeAgentId!, resolvedCompanyId!),
    enabled: Boolean(resolvedCompanyId) && Boolean(issue?.assigneeAgentId),
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(resolvedCompanyId ?? "__none__"),
    queryFn: () => projectsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });
  const { data: currentBoardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: !!issueId,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const currentBoardUserId = currentBoardAccess?.user?.id ?? currentBoardAccess?.userId ?? currentUserId;
  const currentOrganization = organizations.find((organization) => organization.id === resolvedCompanyId) ?? selectedOrganization;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    orgId: resolvedCompanyId,
    userId: currentUserId,
  });
  const { slots: issuePluginDetailSlots } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "issue",
    orgId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const issuePluginTabItems = useMemo(
    () => issuePluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}`,
      label: slot.displayName,
      slot,
    })),
    [issuePluginDetailSlots],
  );
  const activePluginTab = issuePluginTabItems.find((item) => item.value === detailTab) ?? null;

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const currentAssigneeAgent = issue?.assigneeAgentId
    ? agentMap.get(issue.assigneeAgentId) ?? null
    : null;

  const skillMentionOptions = useMemo(
    () => buildAgentSkillMentionOptions({
      agent: currentAssigneeAgent,
      orgUrlKey: currentOrganization?.urlKey ?? "organization",
      organizationSkills: assigneeOrganizationSkills,
      skillSnapshot: assigneeSkillSnapshot,
    }),
    [
      assigneeOrganizationSkills,
      assigneeSkillSnapshot,
      currentAssigneeAgent,
      currentOrganization?.urlKey,
    ],
  );

  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        name: formatChatAgentLabel(agent),
        kind: "agent",
        agentId: agent.id,
        agentIcon: agent.icon,
      });
    }
    for (const project of orderedProjects) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    for (const relatedIssue of allIssues ?? []) {
      if (relatedIssue.id === issue?.id) continue;
      options.push({
        id: `issue:${relatedIssue.id}`,
        name: relatedIssue.identifier ? `${relatedIssue.identifier} ${relatedIssue.title}` : relatedIssue.title,
        kind: "issue",
        issueId: relatedIssue.id,
        issueIdentifier: relatedIssue.identifier,
      });
    }
    options.push(...skillMentionOptions);
    return options;
  }, [agents, allIssues, issue?.id, orderedProjects, skillMentionOptions]);

  const orderedChildIssues = useMemo(
    () => [...childIssues].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [childIssues],
  );

  const commentReassignOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; searchText?: string }> = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        label: formatChatAgentLabel(agent),
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      });
    }
    if (currentUserId) {
      options.push({ id: `user:${currentUserId}`, label: "Me" });
    }
    return options;
  }, [agents, currentUserId]);

  const actualAssigneeValue = useMemo(
    () => assigneeValueFromSelection(issue ?? {}),
    [issue],
  );

  const suggestedAssigneeValue = useMemo(
    () => suggestedCommentAssigneeValue(issue ?? {}, comments, currentUserId),
    [issue, comments, currentUserId],
  );

  const commentsWithRunMeta = useMemo(() => {
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null }>();
    const agentIdByRunId = new Map<string, string>();
    for (const run of linkedRuns ?? []) {
      agentIdByRunId.set(run.runId, run.agentId);
    }
    for (const evt of activity ?? []) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
      });
    }
    return (comments ?? []).map((comment) => {
      const meta = runMetaByCommentId.get(comment.id);
      return meta ? { ...comment, ...meta } : comment;
    });
  }, [activity, comments, linkedRuns]);

  const issueCostSummary = useMemo(() => {
    let input = 0;
    let output = 0;
    let cached = 0;
    let cost = 0;
    let hasCost = false;
    let hasTokens = false;

    for (const run of linkedRuns ?? []) {
      const usage = asRecord(run.usageJson);
      const result = asRecord(run.resultJson);
      const runInput = usageNumber(usage, "inputTokens", "input_tokens");
      const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
      const runCached = usageNumber(
        usage,
        "cachedInputTokens",
        "cached_input_tokens",
        "cache_read_input_tokens",
      );
      const runCost = visibleRunCostUsd(usage, result);
      if (runCost > 0) hasCost = true;
      if (runInput + runOutput + runCached > 0) hasTokens = true;
      input += runInput;
      output += runOutput;
      cached += runCached;
      cost += runCost;
    }

    return {
      input,
      output,
      cached,
      cost,
      totalTokens: input + output,
      hasCost,
      hasTokens,
    };
  }, [linkedRuns]);

  const invalidateIssue = () => {
    const issueOrgId = issue?.orgId ?? resolvedCompanyId ?? selectedOrganizationId;
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.approvals(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId!) });
    if (issue?.id && issueOrgId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.children(issueOrgId, issue.id) });
    }
    if (issueOrgId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(issueOrgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(issueOrgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(issueOrgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(issueOrgId) });
    }
  };

  const markIssueRead = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onSuccess: () => {
      const issueOrgId = issue?.orgId ?? resolvedCompanyId ?? selectedOrganizationId;
      if (issueOrgId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(issueOrgId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(issueOrgId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(issueOrgId) });
      }
    },
  });

  const updateIssue = useMutation({
    mutationFn: (data: Record<string, unknown>) => issuesApi.update(issueId!, data),
    onSuccess: () => {
      invalidateIssue();
    },
  });

  const updateSubIssueStatus = useMutation({
    mutationFn: ({
      childIssueId,
      status,
    }: {
      childIssueId: string;
      status: string;
    }) => issuesApi.update(childIssueId, { status }),
    onMutate: ({ childIssueId }) => {
      setUpdatingSubIssueId(childIssueId);
    },
    onSuccess: (updatedChild) => {
      if (resolvedCompanyId && issue?.id) {
        queryClient.setQueryData<Issue[]>(
          queryKeys.issues.children(resolvedCompanyId, issue.id),
          (current) =>
            current?.map((child) => (
              child.id === updatedChild.id
                ? { ...child, ...updatedChild }
                : child
            )) ?? current,
        );
      }
      queryClient.setQueryData(queryKeys.issues.detail(updatedChild.id), updatedChild);
      if (updatedChild.identifier) {
        queryClient.setQueryData(queryKeys.issues.detail(updatedChild.identifier), updatedChild);
      }
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(resolvedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(resolvedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(resolvedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(resolvedCompanyId) });
      }
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update sub-issue status",
        body: err instanceof Error ? err.message : "Try again.",
        tone: "error",
      });
    },
    onSettled: (_, __, variables) => {
      setSubIssueStatusPickerIssueId((current) => current === variables.childIssueId ? null : current);
      setUpdatingSubIssueId((current) => current === variables.childIssueId ? null : current);
    },
  });

  const addComment = useMutation({
    mutationFn: ({ body, reopen }: { body: string; reopen?: boolean }) =>
      issuesApi.addComment(issueId!, body, reopen),
    onSuccess: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    },
  });

  const addCommentAndReassign = useMutation({
    mutationFn: ({
      body,
      reopen,
      reassignment,
    }: {
      body: string;
      reopen?: boolean;
      reassignment: CommentReassignment;
    }) =>
      issuesApi.update(issueId!, {
        comment: body,
        assigneeAgentId: reassignment.assigneeAgentId,
        assigneeUserId: reassignment.assigneeUserId,
        ...(reopen ? { status: "todo" } : {}),
      }),
    onSuccess: () => {
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId!) });
    },
  });

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      const issueOrgId = issue?.orgId ?? resolvedCompanyId ?? selectedOrganizationId;
      if (!issueOrgId) throw new Error("No organization selected");
      return issuesApi.uploadAttachment(issueOrgId, issueId!, file);
    },
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const importMarkdownDocument = useMutation({
    mutationFn: async (file: File) => {
      const baseName = fileBaseName(file.name);
      const key = slugifyDocumentKey(baseName);
      const existing = (issue?.documentSummaries ?? []).find((doc) => doc.key === key) ?? null;
      const body = await file.text();
      const inferredTitle = titleizeFilename(baseName);
      const nextTitle = existing?.title ?? inferredTitle ?? null;
      return issuesApi.upsertDocument(issueId!, key, {
        title: key === "plan" ? null : nextTitle,
        format: "markdown",
        body,
        baseRevisionId: existing?.latestRevisionId ?? null,
      });
    },
    onSuccess: () => {
      setAttachmentError(null);
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Document import failed");
    },
  });

  const deleteAttachment = useMutation({
    mutationFn: (attachmentId: string) => issuesApi.deleteAttachment(attachmentId),
    onSuccess: () => {
      setAttachmentError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const openInChat = useMutation({
    mutationFn: async () => {
      if (!resolvedCompanyId || !issue) throw new Error("Issue is not ready");
      return chatsApi.create(resolvedCompanyId, {
        title: `Discuss ${issue.identifier ?? "issue"}`,
        contextLinks: [{ entityType: "issue", entityId: issue.id }],
      });
    },
    onSuccess: (conversation) => {
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(resolvedCompanyId) });
      }
      navigate(`/chat/${conversation.id}`);
    },
    onError: (err) => {
      pushToast({
        title: err instanceof Error ? err.message : "Failed to open chat",
        tone: "error",
      });
    },
  });

  const createSubIssue = useMutation({
    mutationFn: async (title: string) => {
      if (!issue) throw new Error("Issue is not ready");
      return issuesApi.create(issue.orgId, {
        title,
        parentId: issue.id,
      });
    },
    onSuccess: () => {
      setSubIssueTitle("");
      setSubIssueComposerOpen(false);
      invalidateIssue();
    },
    onError: (err) => {
      pushToast({
        title: err instanceof Error ? err.message : "Failed to create sub-issue",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    const titleLabel = issue?.title ?? issueId ?? "Issue";
    setBreadcrumbs([
      sourceBreadcrumb,
      { label: hasLiveRuns ? `🔵 ${titleLabel}` : titleLabel },
    ]);
  }, [setBreadcrumbs, sourceBreadcrumb, issue, issueId, hasLiveRuns]);

  useEffect(() => {
    if (issue?.identifier && issueId !== issue.identifier) {
      navigate(`/issues/${issue.identifier}`, { replace: true, state: location.state });
    }
  }, [issue, issueId, navigate, location.state]);

  useLayoutEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleIssueDetailEscape(event)) return;
      navigate(sourceBreadcrumb.href);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [navigate, sourceBreadcrumb.href]);

  useEffect(() => {
    if (!issue?.id) return;
    if (lastMarkedReadIssueIdRef.current === issue.id) return;
    lastMarkedReadIssueIdRef.current = issue.id;
    markIssueRead.mutate(issue.id);
  }, [issue?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyIssueIdToClipboard = async () => {
    if (!issue) return;
    await navigator.clipboard.writeText(issue.identifier ?? issue.id);
    setCopiedIssueId(true);
    pushToast({ title: "Copied issue ID", tone: "success" });
    setTimeout(() => setCopiedIssueId(false), 1500);
  };

  const handleSubIssueSubmit = async () => {
    const nextTitle = subIssueTitle.trim();
    if (!nextTitle || createSubIssue.isPending) return;
    await createSubIssue.mutateAsync(nextTitle);
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!issue) return null;

  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const files = evt.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleAttachmentDrop = async (evt: DragEvent<HTMLDivElement>) => {
    evt.preventDefault();
    setAttachmentDragActive(false);
    const files = evt.dataTransfer.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (isMarkdownFile(file)) {
        await importMarkdownDocument.mutateAsync(file);
      } else {
        await uploadAttachment.mutateAsync(file);
      }
    }
  };

  const isImageAttachment = (attachment: IssueAttachment) => attachment.contentType.startsWith("image/");
  const attachmentList = attachments ?? [];
  const hasAttachments = attachmentList.length > 0;
  const subIssueCountLabel = `${orderedChildIssues.length}`;
  const attachmentUploadButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown"
        className="hidden"
        onChange={handleFilePicked}
        multiple
      />
      <Button
        variant="quiet"
        size="xs"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploadAttachment.isPending || importMarkdownDocument.isPending}
        className={cn(
          "shadow-none",
          attachmentDragActive && "border-primary bg-primary/5",
        )}
        title={uploadAttachment.isPending || importMarkdownDocument.isPending ? "Uploading" : "Attach file"}
      >
        <Paperclip className="h-3.5 w-3.5" />
        {uploadAttachment.isPending || importMarkdownDocument.isPending ? "Uploading..." : (
          <>
            <span className="hidden sm:inline">Attach</span>
          </>
        )}
      </Button>
    </>
  );

  const issueDisplayId = issue.identifier ?? issue.id.slice(0, 8);
  const renderDesktopIssueActions = ({
    moreOpen,
    onMoreOpenChange,
    grouped = false,
  }: {
    moreOpen: boolean;
    onMoreOpenChange: (open: boolean) => void;
    grouped?: boolean;
  }) => (
    <div
      className={cn(
        "flex items-center gap-1 shrink-0",
        grouped && "rounded-lg border border-border bg-background/80 p-1",
      )}
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={copyIssueIdToClipboard}
        title={`Copy ${issueDisplayId}`}
      >
        {copiedIssueId ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
        {copiedIssueId ? "Copied" : "Copy ID"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => openInChat.mutate()}
        disabled={openInChat.isPending}
      >
        <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
        Chat
      </Button>
      <Popover open={moreOpen} onOpenChange={onMoreOpenChange}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 w-7 px-0 shrink-0" aria-label="More issue actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-44 p-1" align="end">
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
            onClick={() => {
              updateIssue.mutate(
                { hiddenAt: new Date().toISOString() },
                { onSuccess: () => navigate("/issues/all") },
              );
              onMoreOpenChange(false);
            }}
          >
            <EyeOff className="h-3 w-3" />
            Hide this Issue
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl xl:grid xl:grid-cols-[minmax(0,1fr)_280px] xl:items-start xl:gap-6">
      <div className="min-w-0 space-y-6">
        <nav aria-label="Issue navigation" data-testid="issue-detail-breadcrumb">
          <Breadcrumb>
            <BreadcrumbList className="flex-wrap gap-y-1">
              {issueHeaderBreadcrumbs.map((crumb, index) => {
                const isLast = index === issueHeaderBreadcrumbs.length - 1;
                return (
                  <BreadcrumbItem key={`${crumb.label}-${index}`} className={isLast ? "min-w-0" : "max-w-[220px]"}>
                    {index > 0 ? <BreadcrumbSeparator /> : null}
                    {isLast || !crumb.href ? (
                      <BreadcrumbPage className="truncate" title={crumb.label}>
                        {crumb.label}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <Link
                          to={crumb.href}
                          state={crumb.href.startsWith("/issues/") ? location.state : undefined}
                          className="truncate"
                          title={crumb.label}
                        >
                          {crumb.label}
                        </Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
        </nav>

        {issue.hiddenAt && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <EyeOff className="h-4 w-4 shrink-0" />
            This issue is hidden
          </div>
        )}

      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {hasLiveRuns && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 px-2 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400 shrink-0">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400" />
              </span>
              Live
            </span>
          )}

          {issue.originKind === "automation_execution" && issue.originId && (
            <Link
              to={`/automations/${issue.originId}`}
              className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400 shrink-0 hover:bg-violet-500/20 transition-colors"
            >
              <Repeat className="h-3 w-3" />
              Automation
            </Link>
          )}
          </div>

          <div className="flex items-center gap-0.5 md:hidden shrink-0">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={copyIssueIdToClipboard}
              title="Copy issue ID"
            >
              {copiedIssueId ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => openInChat.mutate()}
              title="Open in chat"
            >
              <MessageSquare className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setMobilePropsOpen(true)}
              title="Properties"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </div>

          <div className="hidden md:flex xl:hidden items-center shrink-0">
            {renderDesktopIssueActions({
              moreOpen: headerMoreOpen,
              onMoreOpenChange: setHeaderMoreOpen,
            })}
          </div>
        </div>

        <InlineEditor
          value={issue.title}
          onSave={(title) => updateIssue.mutateAsync({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={issue.description ?? ""}
          onSave={(description) => updateIssue.mutateAsync({ description })}
          as="p"
          className="text-[15px] leading-7 text-foreground"
          placeholder="Add a description..."
          multiline
          mentions={mentionOptions}
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync(file);
            return attachment.contentPath;
          }}
        />
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="issue"
        context={{
          orgId: issue.orgId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="issue"
        context={{
          orgId: issue.orgId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <PluginSlotOutlet
        slotTypes={["taskDetailView"]}
        entityType="issue"
        context={{
          orgId: issue.orgId,
          projectId: issue.projectId ?? null,
          entityId: issue.id,
          entityType: "issue",
        }}
        className="space-y-3"
        itemClassName="rounded-lg border border-border p-3"
        missingBehavior="placeholder"
      />

      <section
        aria-label="Sub-issues"
        className="space-y-3"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <ListTree className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Sub-issues</span>
            </div>
            <span className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {subIssueCountLabel}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={() => {
              setSubIssueComposerOpen(true);
              setSubIssueTitle("");
            }}
            disabled={createSubIssue.isPending}
          >
            <Plus className="h-3.5 w-3.5" />
            Add sub-issue
          </Button>
        </div>

        {subIssueComposerOpen ? (
          <div className="rounded-lg border border-border bg-background/80 p-2.5">
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
              onSubmit={(evt) => {
                evt.preventDefault();
                void handleSubIssueSubmit();
              }}
            >
              <Input
                value={subIssueTitle}
                onChange={(evt) => setSubIssueTitle(evt.target.value)}
                onKeyDown={(evt) => {
                  if (evt.key === "Escape") {
                    evt.preventDefault();
                    setSubIssueComposerOpen(false);
                    setSubIssueTitle("");
                  }
                }}
                placeholder="Add sub-issue title"
                autoFocus
                disabled={createSubIssue.isPending}
                className="h-9 text-sm"
              />
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  type="submit"
                  size="sm"
                  className="h-8 px-3 text-xs"
                  disabled={!subIssueTitle.trim() || createSubIssue.isPending}
                >
                  Create
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2.5 text-xs"
                  onClick={() => {
                    setSubIssueComposerOpen(false);
                    setSubIssueTitle("");
                  }}
                  disabled={createSubIssue.isPending}
                >
                  Cancel
                </Button>
              </div>
            </form>
            {createSubIssue.error instanceof Error ? (
              <p className="mt-2 text-xs text-destructive">{createSubIssue.error.message}</p>
            ) : null}
          </div>
        ) : null}

        {orderedChildIssues.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sub-issues.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {orderedChildIssues.map((child) => {
              const childPathId = child.identifier ?? child.id;
              const isStatusPickerOpen = subIssueStatusPickerIssueId === child.id;
              const isUpdatingStatus = updatingSubIssueId === child.id;

              return (
                <div
                  key={child.id}
                  className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm transition-colors hover:bg-accent/20 last:border-b-0"
                >
                  <Popover
                    open={isStatusPickerOpen}
                    onOpenChange={(open) => {
                      setSubIssueStatusPickerIssueId(open ? child.id : null);
                    }}
                  >
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Change status for ${child.title}`}
                        className="inline-flex shrink-0 items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-accent/50 disabled:cursor-wait disabled:opacity-60"
                        disabled={isUpdatingStatus}
                      >
                        <StatusIcon status={child.status} />
                        <PriorityIcon priority={child.priority} />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-40 p-1" align="start">
                      {issueStatusOptions.map((status) => (
                        <Button
                          key={status}
                          variant="ghost"
                          size="sm"
                          className={cn("w-full justify-start gap-2 text-xs", status === child.status && "bg-accent")}
                          onClick={() => {
                            updateSubIssueStatus.mutate({
                              childIssueId: child.id,
                              status,
                            });
                          }}
                        >
                          <StatusIcon status={status} />
                          {issueStatusLabel(status)}
                        </Button>
                      ))}
                    </PopoverContent>
                  </Popover>

                  <Link
                    to={`/issues/${childPathId}`}
                    state={location.state}
                    className="flex min-w-0 flex-1 items-center justify-between gap-3"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {childPathId}
                      </span>
                      <span className="truncate">{child.title}</span>
                    </div>
                    <div className="shrink-0">
                      {child.assigneeAgentId ? (
                        agentMap.get(child.assigneeAgentId)?.name ? (
                          <Identity name={agentMap.get(child.assigneeAgentId)?.name ?? child.assigneeAgentId.slice(0, 8)} size="sm" />
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">{child.assigneeAgentId.slice(0, 8)}</span>
                        )
                      ) : child.assigneeUserId ? (
                        <Identity name={resolveBoardActorLabel("user", child.assigneeUserId, currentBoardUserId)} size="sm" />
                      ) : null}
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <IssueDocumentsSection
        issue={issue}
        canDeleteDocuments={Boolean(session?.user?.id)}
        mentions={mentionOptions}
        imageUploadHandler={async (file) => {
          const attachment = await uploadAttachment.mutateAsync(file);
          return attachment.contentPath;
        }}
        extraActions={!hasAttachments ? attachmentUploadButton : undefined}
      />

      {hasAttachments ? (
        <div
          className={cn("space-y-3 rounded-lg transition-colors")}
          onDragEnter={(evt) => {
            evt.preventDefault();
            setAttachmentDragActive(true);
          }}
          onDragOver={(evt) => {
            evt.preventDefault();
            setAttachmentDragActive(true);
          }}
          onDragLeave={(evt) => {
            if (evt.currentTarget.contains(evt.relatedTarget as Node | null)) return;
            setAttachmentDragActive(false);
          }}
          onDrop={(evt) => void handleAttachmentDrop(evt)}
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">Attachments</h3>
            {attachmentUploadButton}
          </div>

          {attachmentError && (
            <p className="text-xs text-destructive">{attachmentError}</p>
          )}

          <div className="space-y-2">
            {attachmentList.map((attachment) => (
              <div key={attachment.id} className="border border-border rounded-md p-2">
                <div className="flex items-center justify-between gap-2">
                  <a
                    href={attachment.contentPath}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs hover:underline truncate"
                    title={attachment.originalFilename ?? attachment.id}
                  >
                    {attachment.originalFilename ?? attachment.id}
                  </a>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => deleteAttachment.mutate(attachment.id)}
                    disabled={deleteAttachment.isPending}
                    title="Delete attachment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {attachment.contentType} · {(attachment.byteSize / 1024).toFixed(1)} KB
                </p>
                {isImageAttachment(attachment) && (
                  <a href={attachment.contentPath} target="_blank" rel="noreferrer">
                    <img
                      src={attachment.contentPath}
                      alt={attachment.originalFilename ?? "attachment"}
                      className="mt-2 max-h-56 rounded border border-border object-contain bg-accent/10"
                      loading="lazy"
                    />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <Separator />

      <Tabs value={detailTab} onValueChange={setDetailTab} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start gap-1">
          <TabsTrigger value="comments" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
          {issuePluginTabItems.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="comments">
          <CommentThread
            comments={commentsWithRunMeta}
            linkedRuns={timelineRuns}
            orgId={issue.orgId}
            projectId={issue.projectId}
            issueStatus={issue.status}
            agentMap={agentMap}
            draftKey={`rudder:issue-comment-draft:${issue.id}`}
            enableReassign
            reassignOptions={commentReassignOptions}
            currentAssigneeValue={actualAssigneeValue}
            suggestedAssigneeValue={suggestedAssigneeValue}
            mentions={mentionOptions}
            onAdd={async (body, reopen, reassignment) => {
              if (reassignment) {
                await addCommentAndReassign.mutateAsync({ body, reopen, reassignment });
                return;
              }
              await addComment.mutateAsync({ body, reopen });
            }}
            imageUploadHandler={async (file) => {
              const attachment = await uploadAttachment.mutateAsync(file);
              return attachment.contentPath;
            }}
            onAttachImage={async (file) => {
              await uploadAttachment.mutateAsync(file);
            }}
            liveRunSlot={<LiveRunWidget issueId={issueId!} orgId={issue.orgId} />}
          />
        </TabsContent>

        <TabsContent value="activity">
          {linkedRuns && linkedRuns.length > 0 && (
            <div className="mb-3 px-3 py-2 rounded-lg border border-border">
              <div className="text-sm font-medium text-muted-foreground mb-1">Cost Summary</div>
              {!issueCostSummary.hasCost && !issueCostSummary.hasTokens ? (
                <div className="text-xs text-muted-foreground">No cost data yet.</div>
              ) : (
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground tabular-nums">
                  {issueCostSummary.hasCost && (
                    <span className="font-medium text-foreground">
                      ${issueCostSummary.cost.toFixed(4)}
                    </span>
                  )}
                  {issueCostSummary.hasTokens && (
                    <span>
                      Tokens {formatTokens(issueCostSummary.totalTokens)}
                      {issueCostSummary.cached > 0
                        ? ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)}, cached ${formatTokens(issueCostSummary.cached)})`
                        : ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)})`}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          {!activity || activity.length === 0 ? (
            <p className="text-xs text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="space-y-1.5">
              {activity.slice(0, 20).map((evt) => (
                <div key={evt.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ActorIdentity evt={evt} agentMap={agentMap} currentBoardUserId={currentBoardUserId} />
                  <span>{renderActivityDescription(evt)}</span>
                  <span className="ml-auto shrink-0">{relativeTime(evt.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {activePluginTab && (
          <TabsContent value={activePluginTab.value}>
            <PluginSlotMount
              slot={activePluginTab.slot}
              context={{
                orgId: issue.orgId,
                orgPrefix: currentOrganization?.issuePrefix ?? null,
                projectId: issue.projectId ?? null,
                entityId: issue.id,
                entityType: "issue",
              }}
              missingBehavior="placeholder"
            />
          </TabsContent>
        )}
      </Tabs>

      {linkedApprovals && linkedApprovals.length > 0 && (
        <Collapsible
          open={secondaryOpen.approvals}
          onOpenChange={(open) => setSecondaryOpen((prev) => ({ ...prev, approvals: open }))}
          className="rounded-lg border border-border"
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
            <span className="text-sm font-medium text-muted-foreground">
              Linked Approvals ({linkedApprovals.length})
            </span>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", secondaryOpen.approvals && "rotate-180")}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border divide-y divide-border">
              {linkedApprovals.map((approval) => (
                <Link
                  key={approval.id}
                  to={`/messenger/approvals/${approval.id}`}
                  className="flex items-center justify-between px-3 py-2 text-xs hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <StatusBadge status={approval.status} />
                    <span className="font-medium">
                      {approval.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                    <span className="font-mono text-muted-foreground">{approval.id.slice(0, 8)}</span>
                  </div>
                  <span className="text-muted-foreground">{relativeTime(approval.createdAt)}</span>
                </Link>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} inline />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      <ScrollToBottom />
      </div>
      <aside className="mt-6 xl:mt-0">
        <div className="space-y-3 xl:sticky xl:top-4">
          <div className="hidden xl:flex justify-end">
            {renderDesktopIssueActions({
              moreOpen: sidebarMoreOpen,
              onMoreOpenChange: setSidebarMoreOpen,
              grouped: true,
            })}
          </div>

          <section className="rounded-lg border border-border bg-background/80 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Properties
              </p>
            </div>
            <IssueProperties issue={issue} onUpdate={(data) => updateIssue.mutate(data)} />
          </section>
        </div>
      </aside>
    </div>
  );
}
