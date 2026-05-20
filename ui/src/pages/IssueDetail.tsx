import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { organizationsApi } from "../api/orgs";
import { activityApi } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { pluginsApi } from "../api/plugins";
import { organizationSkillsApi } from "../api/organizationSkills";
import { projectsApi } from "../api/projects";
import { useNavigationBack } from "../context/NavigationBackContext";
import { useOrganization } from "../context/OrganizationContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { buildAgentSkillMentionOptions } from "../lib/agent-skill-mentions";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { queryKeys } from "../lib/queryKeys";
import { readIssueDetailBreadcrumb } from "../lib/issueDetailBreadcrumb";
import { readRecentIssueIds, recordRecentIssue } from "../lib/recent-issues";
import { resolveBoardActorLabel } from "../lib/activity-actors";
import { useOperatorDisplayName } from "../hooks/useOperatorDisplayName";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { relativeTime, cn, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { InlineEditor } from "../components/InlineEditor";
import { CommentThread, type CommentThreadActivityItem } from "../components/CommentThread";
import {
  IssueDocumentFocusPage,
  IssueDocumentsSection,
  type IssueDocumentFocusTarget,
} from "../components/IssueDocumentsSection";
import { IssueDetailFind } from "../components/IssueDetailFind";
import { IssueProperties } from "../components/IssueProperties";
import { LiveRunWidget } from "../components/LiveRunWidget";
import type { MentionOption } from "../components/MarkdownEditor";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { formatPriorityLabel } from "../lib/priorities";
import { Identity } from "../components/Identity";
import { AgentIdentity } from "../components/AgentAvatar";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Activity as ActivityIcon,
  Check,
  ChevronRight,
  Copy,
  EyeOff,
  ExternalLink,
  FileCode2,
  Folder,
  Hexagon,
  ListTree,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Repeat,
  SlidersHorizontal,
  Trash2,
  Upload,
} from "lucide-react";
import { summarizeTokenUsage, type ActivityEvent } from "@rudderhq/shared";
import type { Agent, Issue, IssueAttachment, OrganizationWorkspaceFileEntry } from "@rudderhq/shared";
import { DocumentFocusState, IssueCostSummaryData, IssueChatTarget, buildIssueChatHref, ISSUE_UPDATE_METADATA_KEYS, ACTION_LABELS, humanizeValue, formatIssueUserLabel, formatIssuePrincipalLabel, describeIssuePrincipalChange, asRecord, issueUpdatedChangedKeys, isDescriptionOnlyIssueUpdate, shouldShowIssueActivityEvent, usageNumber, usageString, truncate, issueStatusOptions, ISSUE_ATTACHMENT_ACCEPT, LINEAR_PLUGIN_KEY, LINEAR_ISSUE_DETAIL_SLOT_ID, LINEAR_ISSUE_LINK_DATA_KEY, LinearIssueActivitySlot, LinearIssueLinkState, LinearIssueSummary, LinearIssueLinkData, issueStatusLabel, isLinearIssueDetailSlot, isMarkdownFile, fileBaseName, slugifyDocumentKey, titleizeFilename, workspaceEntryLabel, parentWorkspaceDirectory, WorkspaceAttachDialog, formatAction, issueActivityChatLabel, renderActivityDescription, shouldHandleIssueDetailEscape, shouldHandleDocumentFocusEscape, hasBrowserBackStackEntry, ActorIdentity, IssueActivityRow, LinearIssueActivityCard, IssueCostSummaryPanel } from "./IssueDetail.parts";

export { buildIssueChatHref } from "./IssueDetail.parts";

export function IssueDetail() {
  const { issueId } = useParams<{ issueId: string }>();
  const { organizations, selectedOrganizationId, selectedOrganization } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const navigateBack = useNavigationBack();
  const { pushToast } = useToast();
  const operatorDisplayName = useOperatorDisplayName();
  const [headerMoreOpen, setHeaderMoreOpen] = useState(false);
  const [sidebarMoreOpen, setSidebarMoreOpen] = useState(false);
  const [copiedIssueId, setCopiedIssueId] = useState(false);
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const [subIssueComposerOpen, setSubIssueComposerOpen] = useState(false);
  const [subIssueTitle, setSubIssueTitle] = useState("");
  const [existingSubIssuePickerOpen, setExistingSubIssuePickerOpen] = useState(false);
  const [existingSubIssueSearch, setExistingSubIssueSearch] = useState("");
  const [subIssueStatusPickerIssueId, setSubIssueStatusPickerIssueId] = useState<string | null>(null);
  const [updatingSubIssueId, setUpdatingSubIssueId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [workspaceAttachOpen, setWorkspaceAttachOpen] = useState(false);
  const [documentFocusState, setDocumentFocusState] = useState<DocumentFocusState | null>(null);
  const issueFindRootRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const documentFocusCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMarkedReadIssueIdRef = useRef<string | null>(null);

  const { data: issue, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
  });
  const resolvedCompanyId = issue?.orgId ?? selectedOrganizationId;

  useEffect(() => {
    setDocumentFocusState(null);
    if (documentFocusCloseTimerRef.current) {
      clearTimeout(documentFocusCloseTimerRef.current);
      documentFocusCloseTimerRef.current = null;
    }
  }, [issueId]);

  useEffect(() => {
    return () => {
      if (documentFocusCloseTimerRef.current) {
        clearTimeout(documentFocusCloseTimerRef.current);
      }
    };
  }, []);

  const openDocumentFocus = useCallback((target: IssueDocumentFocusTarget) => {
    if (documentFocusCloseTimerRef.current) {
      clearTimeout(documentFocusCloseTimerRef.current);
      documentFocusCloseTimerRef.current = null;
    }
    setDocumentFocusState({ target, phase: "open" });
  }, []);

  const closeDocumentFocus = useCallback(() => {
    setDocumentFocusState((current) => {
      if (!current || current.phase === "closing") return current;
      return { ...current, phase: "closing" };
    });
    if (documentFocusCloseTimerRef.current) {
      clearTimeout(documentFocusCloseTimerRef.current);
    }
    documentFocusCloseTimerRef.current = setTimeout(() => {
      setDocumentFocusState(null);
      documentFocusCloseTimerRef.current = null;
    }, 200);
  }, []);

  useEffect(() => {
    if (!issue?.orgId || !issue.id) return;
    recordRecentIssue(issue.orgId, issue.id, readRecentIssueIds(issue.orgId));
  }, [issue?.id, issue?.orgId]);

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
    () => issuePluginDetailSlots
      .filter((slot) => !isLinearIssueDetailSlot(slot))
      .map((slot) => ({
        value: `plugin:${slot.pluginKey}:${slot.id}`,
        label: slot.displayName,
        slot,
      })),
    [issuePluginDetailSlots],
  );
  const linearIssueActivitySlot = issuePluginDetailSlots.find((slot) => isLinearIssueDetailSlot(slot)) ?? null;
  const { data: linearIssueLink } = useQuery({
    queryKey: [
      "plugins",
      LINEAR_PLUGIN_KEY,
      LINEAR_ISSUE_LINK_DATA_KEY,
      resolvedCompanyId ?? "__none__",
      issue?.id ?? issueId ?? "__none__",
      linearIssueActivitySlot?.pluginId ?? "__none__",
    ] as const,
    queryFn: async () => {
      const response = await pluginsApi.bridgeGetData(
        linearIssueActivitySlot!.pluginId,
        LINEAR_ISSUE_LINK_DATA_KEY,
        {
          orgId: resolvedCompanyId,
          issueId: issue!.id,
        },
        resolvedCompanyId,
      );
      return response.data as LinearIssueLinkData;
    },
    enabled: Boolean(resolvedCompanyId && issue?.id && linearIssueActivitySlot?.pluginId),
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );

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
        agentRole: agent.role,
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
      const relatedIssueProject = relatedIssue.projectId
        ? projectById.get(relatedIssue.projectId) ?? relatedIssue.project ?? null
        : relatedIssue.project ?? null;
      const relatedIssueAssignee = relatedIssue.assigneeAgentId
        ? agentMap.get(relatedIssue.assigneeAgentId) ?? null
        : null;
      const relatedIssueAssigneeName = relatedIssue.assigneeAgentId
        ? relatedIssueAssignee?.name ?? relatedIssue.assigneeAgentId.slice(0, 8)
        : formatAssigneeUserLabel(relatedIssue.assigneeUserId, currentUserId);
      options.push({
        id: `issue:${relatedIssue.id}`,
        name: relatedIssue.identifier ? `${relatedIssue.identifier} ${relatedIssue.title}` : relatedIssue.title,
        kind: "issue",
        searchText: [
          relatedIssue.identifier,
          relatedIssue.title,
          relatedIssue.status,
          relatedIssueProject?.name,
          relatedIssueAssigneeName,
        ].filter(Boolean).join(" "),
        issueId: relatedIssue.id,
        issueIdentifier: relatedIssue.identifier,
        issueStatus: relatedIssue.status,
        issueProjectName: relatedIssueProject?.name ?? null,
        issueProjectColor: relatedIssueProject?.color ?? null,
        issueAssigneeName: relatedIssueAssigneeName,
        issueAssigneeIcon: relatedIssueAssignee?.icon ?? null,
        issueAssigneeRole: relatedIssueAssignee?.role ?? null,
      });
    }
    options.push(...skillMentionOptions);
    return options;
  }, [agentMap, agents, allIssues, currentUserId, issue?.id, orderedProjects, projectById, skillMentionOptions]);

  const orderedChildIssues = useMemo(
    () => [...childIssues].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [childIssues],
  );
  const issueById = useMemo(() => new Map((allIssues ?? []).map((candidate) => [candidate.id, candidate])), [allIssues]);
  const existingSubIssueCandidates = useMemo(() => {
    if (!issue) return [];
    const q = existingSubIssueSearch.trim().toLowerCase();
    return (allIssues ?? [])
      .filter((candidate) => candidate.id !== issue.id)
      .filter((candidate) => candidate.parentId !== issue.id)
      .filter((candidate) => !(issue.ancestors ?? []).some((ancestor) => ancestor.id === candidate.id))
      .filter((candidate) => {
        if (!q) return true;
        return `${candidate.identifier ?? ""} ${candidate.title}`.toLowerCase().includes(q);
      })
      .slice(0, 12);
  }, [allIssues, existingSubIssueSearch, issue]);

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

  const issueCostSummary = useMemo<IssueCostSummaryData>(() => {
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
      const runCached =
        usageNumber(usage, "cachedInputTokens", "cached_input_tokens") +
        usageNumber(usage, "cache_read_input_tokens") +
        usageNumber(usage, "cache_creation_input_tokens");
      const tokenSummary = summarizeTokenUsage({
        provider: usageString(usage, "provider") ?? usageString(result, "provider"),
        inputTokens: runInput,
        cachedInputTokens: runCached,
        outputTokens: runOutput,
      });
      const runCost = visibleRunCostUsd(usage, result);
      if (runCost > 0) hasCost = true;
      if (runInput + runOutput + runCached > 0) hasTokens = true;
      input += tokenSummary.promptTokens;
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

  const issueActivityItems = useMemo<CommentThreadActivityItem[]>(() => {
    const items: CommentThreadActivityItem[] = [];

    if (linearIssueLink?.linked) {
      items.push({
        id: "linear-linked-issue",
        createdAt: linearIssueLink.latestIssue?.updatedAt ?? linearIssueLink.link.updatedAt ?? linearIssueLink.link.importedAt,
        node: <LinearIssueActivityCard data={linearIssueLink} />,
      });
    }

    for (const evt of activity ?? []) {
      if (!shouldShowIssueActivityEvent(evt)) continue;
      items.push({
        id: evt.id,
        createdAt: evt.createdAt,
        node: (
          <IssueActivityRow
            evt={evt}
            agentMap={agentMap}
            currentBoardUserId={currentBoardUserId}
            operatorDisplayName={operatorDisplayName}
          />
        ),
      });
    }

    return items;
  }, [activity, agentMap, currentBoardUserId, linearIssueLink, operatorDisplayName]);

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

  const uploadAttachment = useMutation({
    mutationFn: async ({
      file,
      usage = "issue",
    }: {
      file: File;
      usage?: IssueAttachment["usage"];
    }) => {
      const issueOrgId = issue?.orgId ?? resolvedCompanyId ?? selectedOrganizationId;
      if (!issueOrgId) throw new Error("No organization selected");
      return issuesApi.uploadAttachment(issueOrgId, issueId!, file, { usage });
    },
    onSuccess: (_, variables) => {
      setAttachmentError(null);
      if (variables.usage === undefined || variables.usage === "issue") {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      }
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const attachWorkspaceFile = useMutation({
    mutationFn: async (filePath: string) => {
      const issueOrgId = issue?.orgId ?? resolvedCompanyId ?? selectedOrganizationId;
      if (!issueOrgId) throw new Error("No organization selected");
      return issuesApi.attachWorkspaceFile(issueOrgId, issueId!, filePath);
    },
    onSuccess: () => {
      setAttachmentError(null);
      setWorkspaceAttachOpen(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId!) });
      invalidateIssue();
    },
    onError: (err) => {
      setAttachmentError(err instanceof Error ? err.message : "Workspace attach failed");
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

  const openInChat = useCallback(() => {
    if (!issue) {
      pushToast({
        title: "Issue is not ready",
        tone: "error",
      });
      return;
    }
    navigate(buildIssueChatHref(issue));
  }, [issue, navigate, pushToast]);

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

  const linkExistingSubIssue = useMutation({
    mutationFn: async (candidate: Issue) => {
      if (!issue) throw new Error("Issue is not ready");
      return issuesApi.update(candidate.id, { parentId: issue.id });
    },
    onSuccess: (updated, candidate) => {
      setExistingSubIssuePickerOpen(false);
      setExistingSubIssueSearch("");
      invalidateIssue();
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(updated.id) });
      if (updated.identifier) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(updated.identifier) });
      }
      if (issue?.orgId && candidate.parentId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.children(issue.orgId, candidate.parentId) });
      }
    },
    onError: (err) => {
      pushToast({
        title: err instanceof Error ? err.message : "Failed to add existing issue",
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
      if (documentFocusState) {
        if (!shouldHandleDocumentFocusEscape(event)) return;
        event.preventDefault();
        closeDocumentFocus();
        return;
      }
      if (!shouldHandleIssueDetailEscape(event)) return;
      event.preventDefault();
      if (navigateBack?.()) return;
      if (hasBrowserBackStackEntry()) {
        navigate(-1);
        return;
      }
      navigate(sourceBreadcrumb.href);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeDocumentFocus, documentFocusState, navigate, navigateBack, sourceBreadcrumb.href]);

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
        await uploadAttachment.mutateAsync({ file, usage: "issue" });
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
        await uploadAttachment.mutateAsync({ file, usage: "issue" });
      }
    }
  };

  const isImageAttachment = (attachment: IssueAttachment) => attachment.contentType.startsWith("image/");
  const attachmentList = attachments ?? [];
  const hasAttachments = attachmentList.length > 0;
  const subIssueCountLabel = `${orderedChildIssues.length}`;
  const documentFocusTarget = documentFocusState?.target ?? null;
  const attachmentBusy = uploadAttachment.isPending || importMarkdownDocument.isPending || attachWorkspaceFile.isPending;
  const attachmentActions = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={ISSUE_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={handleFilePicked}
        multiple
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="xs"
            disabled={attachmentBusy}
            className={cn(
              "shadow-none",
              attachmentDragActive && "border-primary bg-primary/5",
            )}
            title={attachmentBusy ? "Attaching" : "Attach file"}
          >
            {attachmentBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
            {attachmentBusy ? "Attaching..." : <span className="hidden sm:inline">Attach</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            onSelect={() => {
              fileInputRef.current?.click();
            }}
          >
            <Upload className="h-4 w-4" />
            Upload from computer
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setWorkspaceAttachOpen(true);
            }}
          >
            <Folder className="h-4 w-4" />
            Attach from Workspaces
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  const issueDisplayId = issue.identifier ?? issue.id.slice(0, 8);
  const issueFindRefreshKey = [
    issue.id,
    issue.updatedAt,
    commentsWithRunMeta.length,
    issueActivityItems.length,
    orderedChildIssues.length,
    attachmentList.length,
  ].join(":");
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
        grouped && "rounded-full border border-border bg-background/80 p-1",
      )}
    >
      <Button
        variant="ghost"
        size="sm"
        className={cn("h-7 px-2 text-xs", grouped && "rounded-full")}
        onClick={copyIssueIdToClipboard}
        title={`Copy ${issueDisplayId}`}
      >
        {copiedIssueId ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
        {copiedIssueId ? "Copied" : "Copy ID"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={cn("h-7 px-2 text-xs", grouped && "rounded-full")}
        onClick={openInChat}
      >
        <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
        Chat
      </Button>
      <Popover open={moreOpen} onOpenChange={onMoreOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-7 w-7 px-0 shrink-0", grouped && "rounded-full")}
            aria-label="More issue actions"
          >
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
    <div
      ref={issueFindRootRef}
      className={cn(
        "mx-auto max-w-6xl",
        !documentFocusTarget && "xl:grid xl:grid-cols-[minmax(0,1fr)_280px] xl:items-start xl:gap-6",
      )}
    >
      {!documentFocusTarget ? (
        <IssueDetailFind rootRef={issueFindRootRef} refreshKey={issueFindRefreshKey} />
      ) : null}
      {documentFocusTarget ? (
        <IssueDocumentFocusPage
          issue={issue}
          target={documentFocusTarget}
          motionState={documentFocusState?.phase ?? "open"}
          mentions={mentionOptions}
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync({ file, usage: "document_inline" });
            return attachment.contentPath;
          }}
          onClose={closeDocumentFocus}
          onDocumentCreated={(key) => {
            setDocumentFocusState((current) => current ? { ...current, target: { kind: "existing", key } } : current);
          }}
        />
      ) : (
        <>
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
              onClick={openInChat}
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
            const attachment = await uploadAttachment.mutateAsync({ file, usage: "description_inline" });
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-2.5 text-xs"
                disabled={createSubIssue.isPending || linkExistingSubIssue.isPending}
              >
                <Plus className="h-3.5 w-3.5" />
                Add sub-issue
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  setExistingSubIssuePickerOpen(false);
                  setSubIssueComposerOpen(true);
                  setSubIssueTitle("");
                }}
              >
                Create new sub-issue
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setSubIssueComposerOpen(false);
                  setSubIssueTitle("");
                  setExistingSubIssuePickerOpen(true);
                }}
              >
                Add existing issue
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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

        {existingSubIssuePickerOpen ? (
          <div className="rounded-lg border border-border bg-background/80 p-2.5">
            <div className="flex items-center gap-2 border-b border-border/70 pb-2">
              <Input
                value={existingSubIssueSearch}
                onChange={(evt) => setExistingSubIssueSearch(evt.target.value)}
                placeholder="Search existing issues"
                autoFocus
                disabled={linkExistingSubIssue.isPending}
                className="h-8 text-sm"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2.5 text-xs"
                onClick={() => {
                  setExistingSubIssuePickerOpen(false);
                  setExistingSubIssueSearch("");
                }}
                disabled={linkExistingSubIssue.isPending}
              >
                Cancel
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto pt-2">
              {existingSubIssueCandidates.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">No matching issues.</p>
              ) : (
                existingSubIssueCandidates.map((candidate) => {
                  const candidateRef = candidate.identifier ?? candidate.id.slice(0, 8);
                  const moveFrom = candidate.parentId ? issueById.get(candidate.parentId) ?? null : null;
                  const candidateProject = candidate.projectId
                    ? projectById.get(candidate.projectId) ?? candidate.project ?? null
                    : candidate.project ?? null;
                  const secondary = moveFrom
                    ? `Move from ${moveFrom.identifier ?? moveFrom.id.slice(0, 8)}`
                    : candidateProject && candidate.projectId !== issue.projectId
                      ? candidateProject.name
                      : "No parent";

                  return (
                    <button
                      type="button"
                      key={candidate.id}
                      className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent/40 disabled:cursor-wait disabled:opacity-60"
                      onClick={() => linkExistingSubIssue.mutate(candidate)}
                      disabled={linkExistingSubIssue.isPending}
                    >
                      <StatusIcon status={candidate.status} />
                      <span className="min-w-0 truncate">{candidate.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">{candidateRef}</span>
                      <span className="col-start-2 min-w-0 truncate text-xs text-muted-foreground">{secondary}</span>
                    </button>
                  );
                })
              )}
            </div>
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
                          <AgentIdentity
                            name={agentMap.get(child.assigneeAgentId)?.name ?? child.assigneeAgentId.slice(0, 8)}
                            icon={agentMap.get(child.assigneeAgentId)?.icon}
                            role={agentMap.get(child.assigneeAgentId)?.role}
                            size="sm"
                          />
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">{child.assigneeAgentId.slice(0, 8)}</span>
                        )
                      ) : child.assigneeUserId ? (
                        <Identity name={resolveBoardActorLabel("user", child.assigneeUserId, currentBoardUserId, operatorDisplayName)} size="sm" />
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
          const attachment = await uploadAttachment.mutateAsync({ file, usage: "document_inline" });
          return attachment.contentPath;
        }}
        extraActions={!hasAttachments ? attachmentActions : undefined}
        onFocusNewDocument={() => openDocumentFocus({ kind: "new" })}
        onFocusDocument={(key) => openDocumentFocus({ kind: "existing", key })}
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
            {attachmentActions}
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

      <section aria-label="Activity" className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Activity</span>
        </div>
        <CommentThread
          comments={commentsWithRunMeta}
          linkedRuns={timelineRuns}
          activityItems={issueActivityItems}
          orgId={issue.orgId}
          projectId={issue.projectId}
          issueStatus={issue.status}
          agentMap={agentMap}
          draftKey={`rudder:issue-comment-draft:${issue.id}`}
          mentions={mentionOptions}
          operatorDisplayName={operatorDisplayName}
          hideHeading
          emptyMessage="No activity yet."
          escapeBackWhenEmpty
          onAdd={async (body, reopen) => {
            await addComment.mutateAsync({ body, reopen });
          }}
          imageUploadHandler={async (file) => {
            const attachment = await uploadAttachment.mutateAsync({ file, usage: "comment_inline" });
            return attachment.contentPath;
          }}
          onAttachImage={async (file) => {
            await uploadAttachment.mutateAsync({ file, usage: "comment_attachment" });
          }}
          liveRunSlot={<LiveRunWidget issueId={issueId!} orgId={issue.orgId} />}
        />
      </section>

      {issuePluginTabItems.length > 0 ? (
        <div className="space-y-3">
          {issuePluginTabItems.map((item) => (
            <section key={item.value} className="space-y-2">
              <h3 className="text-sm font-semibold">{item.label}</h3>
              <PluginSlotMount
                slot={item.slot}
                context={{
                  orgId: issue.orgId,
                  orgPrefix: currentOrganization?.issuePrefix ?? null,
                  projectId: issue.projectId ?? null,
                  entityId: issue.id,
                  entityType: "issue",
                }}
                missingBehavior="placeholder"
              />
            </section>
          ))}
        </div>
      ) : null}

      <Sheet open={mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="space-y-3 px-4 pb-4">
              <IssueProperties
                issue={issue}
                onUpdate={(data) => updateIssue.mutate(data)}
                inline
                childIssues={orderedChildIssues}
              />
              <IssueCostSummaryPanel summary={issueCostSummary} />
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

          <section aria-label="Issue properties" className="rounded-lg border border-border bg-background/80 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Properties
              </p>
            </div>
            <IssueProperties
              issue={issue}
              onUpdate={(data) => updateIssue.mutate(data)}
              childIssues={orderedChildIssues}
            />
          </section>
          <IssueCostSummaryPanel summary={issueCostSummary} />
        </div>
      </aside>
      </>
      )}
      <WorkspaceAttachDialog
        orgId={issue.orgId ?? resolvedCompanyId ?? selectedOrganizationId}
        open={workspaceAttachOpen}
        onOpenChange={setWorkspaceAttachOpen}
        onAttach={(filePath) => attachWorkspaceFile.mutateAsync(filePath).then(() => undefined).catch(() => undefined)}
        attaching={attachWorkspaceFile.isPending}
        error={attachmentError}
      />
    </div>
  );
}
