import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Link, Navigate, useLocation, useNavigate, useParams } from "@/lib/router";
import {
  type GoalActivityTimelinePage,
  type GoalFeedbackAttachment,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  ArrowRight,
  CalendarDays,
  Check,
  Clock3,
  Copy,
  FileCheck2,
  Focus,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { agentsApi } from "../api/agents";
import { assetsApi } from "../api/assets";
import { authApi } from "../api/auth";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { AgentIdentity } from "../components/AgentAvatar";
import { AgentMenuLabel } from "../components/AssigneeLabel";
import { CommentComposer } from "../components/CommentComposer";
import { CommentThread, type CommentThreadActivityItem } from "../components/CommentThread";
import type { LinkedRunItem } from "../components/CommentThread.runs";
import { GoalTargetTimePicker } from "../components/GoalTargetTimePicker";
import { InlineEditor } from "../components/InlineEditor";
import { PropertyPicker, PropertyRow } from "../components/IssueProperties";
import { IssueRuntimeSelector, supportsIssueRuntimeOverrides } from "../components/IssueRuntimeSelector";
import { MarkdownBody } from "../components/MarkdownBody";
import type { MarkdownEditorRef } from "../components/MarkdownEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { PropertiesManifest, PropertiesManifestSheet, PropertiesManifestTrigger } from "../components/PropertiesManifest";
import { StatusIcon } from "../components/StatusIcon";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { usePanel } from "../context/PanelContext";
import { useSidePanel } from "../context/SidePanelContext";
import { useToast } from "../context/ToastContext";
import { formatDateOnly, toDateOnlyValue } from "../lib/date-only";
import { markdownDocumentOrNull } from "../lib/markdown-document-value";
import { findOrganizationByPrefix, getOrganizationRouteKey } from "../lib/organization-routes";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

import type {
  ChangeDecisionInput,
  DecisionFocusRequest,
  EvidenceContext,
  GoalDetailTab,
  GoalTimelineItem,
  PendingFeedback,
  ResultDecisionInput
} from "./goal-detail-helpers";
import {
  EvidenceList,
  GOAL_DETAIL_TABS,
  ResultProposalSummary,
  Section,
  WorkLinks,
  asRecord,
  attentionKindLabel,
  buildGoalTimelineActivityItems,
  goalDetailTab,
  goalStatusIconStatus,
  goalStatusLabel,
  mergeGoalTimelineItems,
  normalizeChangeProposals,
  normalizeResultProposals,
  readString,
  storedGoalChatTarget
} from "./goal-detail-helpers";

export function GoalDetail() {
  const { goalId, orgPrefix } = useParams<{ goalId: string; orgPrefix?: string }>();
  const location = useLocation();
  const debugMode = new URLSearchParams(location.search).get("goalDebug") === "1";
  const activeTab = goalDetailTab(location.search);
  const { organizations, selectedOrganizationId } = useOrganization();
  const { confirm, openNewGoal } = useDialog();
  const { closePanel } = usePanel();
  const sidePanel = useSidePanel();
  const { pushToast } = useToast();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const feedbackRef = useRef<MarkdownEditorRef>(null);
  const feedbackSurfaceRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const focusButtonRef = useRef<HTMLButtonElement>(null);
  const goalTitleRef = useRef<HTMLHeadingElement>(null);
  const goalActivityPanelRef = useRef<HTMLDivElement>(null);
  const goalTimelineLoadMoreButtonRef = useRef<HTMLButtonElement>(null);
  const outcomeHeadingRef = useRef<HTMLHeadingElement>(null);
  const attentionHeadingRef = useRef<HTMLHeadingElement>(null);
  const feedbackRequestRef = useRef<{ identity: string; key: string } | null>(null);
  const resultRequestKeysRef = useRef(new Map<string, string>());
  const decisionFocusRequestRef = useRef<DecisionFocusRequest | null>(null);
  const focusControlRequestRef = useRef<{ goalId: string; focus: boolean } | null>(null);
  const goalTimelineFocusAfterLoadRef = useRef(false);
  const [feedbackBody, setFeedbackBody] = useState("");
  const [feedbackAttachments, setFeedbackAttachments] = useState<GoalFeedbackAttachment[]>([]);
  const [feedbackAttachmentError, setFeedbackAttachmentError] = useState<string | null>(null);
  const [failedFeedbackFile, setFailedFeedbackFile] = useState<File | null>(null);
  const [pendingFeedback, setPendingFeedback] = useState<PendingFeedback | null>(null);
  const [changeNotes, setChangeNotes] = useState<Record<string, string>>({});
  const [resultFeedback, setResultFeedback] = useState<Record<string, string>>({});
  const [goalTimelineOlderPages, setGoalTimelineOlderPages] = useState<GoalActivityTimelinePage["items"][]>([]);
  const [goalTimelineLoadedItems, setGoalTimelineLoadedItems] = useState<GoalTimelineItem[]>([]);
  const [goalTimelineCursor, setGoalTimelineCursor] = useState<string | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [copiedGoalId, setCopiedGoalId] = useState(false);
  const [relatedExpanded, setRelatedExpanded] = useState(false);
  const [desktopOwnerOpen, setDesktopOwnerOpen] = useState(false);
  const [desktopOwnerSearch, setDesktopOwnerSearch] = useState("");
  const [mobileOwnerOpen, setMobileOwnerOpen] = useState(false);
  const [mobileOwnerSearch, setMobileOwnerSearch] = useState("");
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);

  const focusFeedbackComposer = useCallback(() => {
    let attempts = 0;
    const focusWhenReady = () => {
      attempts += 1;
      feedbackRef.current?.focus();
      const editable = feedbackSurfaceRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!editable) {
        if (attempts < 12) requestAnimationFrame(focusWhenReady);
        return;
      }
      if (document.activeElement !== editable) editable.focus({ preventScroll: true });
      if (attempts < 4) requestAnimationFrame(focusWhenReady);
    };
    requestAnimationFrame(focusWhenReady);
  }, []);

  const workspaceQuery = useQuery({
    queryKey: ["goals", "detail", goalId, "workspace"],
    queryFn: () => goalsApi.getWorkspace(goalId!),
    enabled: Boolean(goalId),
  });
  const workspace = workspaceQuery.data;
  const goal = workspace?.goal;
  const routeOrganization = findOrganizationByPrefix({ organizations, organizationPrefix: orgPrefix });
  const routeOrganizationId = routeOrganization?.id ?? selectedOrganizationId;
  const goalOrganization = goal
    ? organizations.find((organization) => organization.id === goal.orgId) ?? null
    : null;
  const canonicalGoalPath = goal && routeOrganizationId && goal.orgId !== routeOrganizationId && goalOrganization
    ? `/${getOrganizationRouteKey(goalOrganization)}/goals/${goal.id}${location.search}${location.hash}`
    : null;
  const orgId = routeOrganizationId;
  const sessionQuery = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => authApi.getSession(),
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(orgId!),
    queryFn: () => agentsApi.list(orgId!),
    enabled: Boolean(orgId),
  });
  const agentMap = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent])),
    [agentsQuery.data],
  );
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(orgId!),
    queryFn: () => projectsApi.list(orgId!),
    enabled: Boolean(orgId),
  });
  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.list(orgId!),
    queryFn: () => issuesApi.list(orgId!),
    enabled: Boolean(orgId),
  });
  const dependenciesQuery = useQuery({
    queryKey: queryKeys.goals.dependencies(goalId!),
    queryFn: () => goalsApi.dependencies(goalId!),
    enabled: Boolean(goalId),
  });
  const goalTimelineQuery = useQuery({
    queryKey: ["goals", "detail", goalId, "timeline"],
    queryFn: () => goalsApi.getTimeline(goalId!, null, 50),
    enabled: Boolean(goalId),
    refetchInterval: 5000,
  });

  useEffect(() => closePanel(), [closePanel]);
  useEffect(() => {
    setBreadcrumbs([{ label: "Goals", href: "/goals" }, { label: goal?.title ?? goalId ?? "Goal" }]);
  }, [goal?.title, goalId, setBreadcrumbs]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(goalId!) }),
      queryClient.invalidateQueries({ queryKey: ["goals", "detail", goalId, "timeline"] }),
      orgId ? queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(orgId) }) : Promise.resolve(),
      orgId ? queryClient.invalidateQueries({ queryKey: ["goals", "workspace", orgId] }) : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.dependencies(goalId!) }),
    ]);
  };

  const updateGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) => goalsApi.update(goalId!, data),
    onSuccess: async () => {
      await invalidate();
      pushToast({ id: "goal-detail-operation", title: "Goal updated", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: error.message, tone: "error" }),
  });
  const assignOwner = useMutation({
    mutationFn: (agentId: string) => goalsApi.assignOwner(goalId!, { agentId }),
    onSuccess: async () => {
      await invalidate();
      pushToast({ id: "goal-detail-operation", title: "Owner updated", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: error.message, tone: "error" }),
  });
  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedOrganizationId) throw new Error("No organization selected");
      return assetsApi.uploadImage(selectedOrganizationId, file, `goals/${goalId}`);
    },
  });

  useEffect(() => {
    if (!goal) return;
    setTitleDraft(goal.title);
    setTitleEditing(false);
    setTitleError(null);
  }, [goal?.id]);

  useEffect(() => {
    if (titleEditing) titleInputRef.current?.focus();
  }, [titleEditing]);
  const setFocus = useMutation({
    mutationFn: (focus: boolean) => goalsApi.setFocus(goalId!, focus),
    onMutate: (focus) => {
      focusControlRequestRef.current = { goalId: goalId!, focus };
    },
    onSuccess: async () => {
      await invalidate();
      pushToast({ id: "goal-detail-operation", title: "Focus updated", tone: "success" });
    },
    onError: (error: Error) => {
      focusControlRequestRef.current = null;
      pushToast({ title: error.message, tone: "error" });
    },
  });
  const resumeOwner = useMutation({
    mutationFn: () => {
      if (!goal?.ownerAgentId || !orgId) throw new Error("This Goal has no available Owner Agent.");
      return agentsApi.resume(goal.ownerAgentId, orgId);
    },
    onSuccess: async () => {
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(orgId!) });
      pushToast({ id: "goal-detail-operation", title: "Agent resumed", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: error.message, tone: "error" }),
  });
  const deleteGoal = useMutation({
    mutationFn: () => goalsApi.remove(goalId!),
    onSuccess: () => {
      if (orgId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(orgId) });
        queryClient.invalidateQueries({ queryKey: ["goals", "workspace", orgId] });
      }
      navigate("/goals");
    },
    onError: (error: Error) => pushToast({ title: error.message, tone: "error" }),
  });

  const feedbackMutation = useMutation({
    mutationFn: (feedback: PendingFeedback) => goalsApi.feedback(goalId!, {
      body: feedback.body,
      attachments: feedback.attachments,
      feedbackKind: feedback.feedbackKind,
      idempotencyKey: feedback.idempotencyKey,
    }),
    onMutate: (feedback) => setPendingFeedback({ ...feedback, status: "sending", error: null }),
    onSuccess: async () => {
      await invalidate();
      setPendingFeedback(null);
      feedbackRequestRef.current = null;
      setFeedbackAttachments([]);
      focusFeedbackComposer();
    },
    onError: (error: Error, feedback) => {
      setPendingFeedback({ ...feedback, status: "failed", error: error.message });
      focusFeedbackComposer();
    },
  });

  const feedbackAttachmentMutation = useMutation({
    mutationFn: async ({ file }: { file: File }) => {
      if (!orgId) throw new Error("No organization selected");
      if (!file.type.startsWith("image/")) throw new Error("Only image attachments are supported right now.");
      return assetsApi.uploadImage(orgId, file, "goals/feedback");
    },
    onSuccess: (asset, { file }) => {
      setFeedbackAttachments((current) => [...current, {
        name: asset.originalFilename ?? file.name,
        uri: `asset://${asset.assetId}`,
        mimeType: asset.contentType,
        size: asset.byteSize,
      }]);
      setFeedbackAttachmentError(null);
      setFailedFeedbackFile(null);
    },
    onError: (error: Error, { file }) => {
      setFeedbackAttachmentError(error.message);
      setFailedFeedbackFile(file);
    },
  });

  const changeDecision = useMutation({
    mutationFn: ({ id, decision }: ChangeDecisionInput) => goalsApi.decideChangeProposal(id, {
      decision,
      note: changeNotes[id]?.trim() || undefined,
    }),
    onMutate: (variables) => {
      decisionFocusRequestRef.current = { goalId: variables.goalId, kind: "change", id: variables.id };
    },
    onSuccess: async () => {
      await invalidate();
    },
    onError: (_, variables) => {
      const request = decisionFocusRequestRef.current;
      if (request?.goalId === variables.goalId && request.kind === "change" && request.id === variables.id) {
        decisionFocusRequestRef.current = null;
      }
    },
  });

  const resultDecision = useMutation<unknown, Error, ResultDecisionInput>({
    mutationFn: ({ id, decision, feedback, idempotencyKey }) => decision === "accept"
      ? goalsApi.acceptResultProposal(id, { idempotencyKey })
      : goalsApi.rejectResultProposal(id, { idempotencyKey, feedback }),
    onMutate: (variables) => {
      decisionFocusRequestRef.current = { goalId: variables.goalId, kind: "result", id: variables.id };
    },
    onSuccess: async (_, variables) => {
      await invalidate();
      if (variables.decision === "reject") {
        setResultFeedback((current) => ({ ...current, [variables.id]: "" }));
      }
    },
    onError: (_, variables) => {
      const request = decisionFocusRequestRef.current;
      if (request?.goalId === variables.goalId && request.kind === "result" && request.id === variables.id) {
        decisionFocusRequestRef.current = null;
      }
    },
  });

  const goalTimelineMutation = useMutation({
    mutationFn: (cursor: string) => goalsApi.getTimeline(goalId!, cursor, 50),
    onSuccess: (page) => {
      setGoalTimelineOlderPages((current) => [...current, page.items]);
      setGoalTimelineLoadedItems((current) => mergeGoalTimelineItems(current, page.items));
      setGoalTimelineCursor(page.nextCursor);
      goalTimelineFocusAfterLoadRef.current = true;
    },
  });

  useEffect(() => {
    setGoalTimelineOlderPages([]);
    setGoalTimelineLoadedItems([]);
    setGoalTimelineCursor(null);
  }, [goalId]);

  useEffect(() => {
    const page = goalTimelineQuery.data;
    if (!page) return;
    setGoalTimelineLoadedItems((current) => mergeGoalTimelineItems(current, page.items));
    setGoalTimelineCursor((current) => goalTimelineOlderPages.length === 0 ? page.nextCursor : current);
  }, [goalTimelineOlderPages.length, goalTimelineQuery.data]);

  useEffect(() => {
    setRelatedExpanded(false);
  }, [goalId]);

  const linkedProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => project.goalIds.includes(goalId!) || project.goalId === goalId),
    [goalId, projectsQuery.data],
  );
  const linkedIssues = useMemo(
    () => (issuesQuery.data ?? []).filter((issue) => issue.goalId === goalId),
    [goalId, issuesQuery.data],
  );
  const changeProposals = useMemo(() => normalizeChangeProposals(workspace?.changeProposals), [workspace?.changeProposals]);
  const resultProposals = useMemo(
    () => normalizeResultProposals(workspace?.resultProposals, workspace?.goal.criteria, {
      issues: issuesQuery.data ?? [],
      projects: projectsQuery.data ?? [],
      ownerAgentId: workspace?.goal.ownerAgentId ?? null,
    }),
    [issuesQuery.data, projectsQuery.data, workspace?.goal.criteria, workspace?.goal.ownerAgentId, workspace?.resultProposals],
  );
  const goalTimelineItems = useMemo<GoalActivityTimelinePage["items"]>(() => {
    return mergeGoalTimelineItems(
      goalTimelineLoadedItems,
      goalTimelineQuery.data?.items ?? [],
    );
  }, [goalTimelineLoadedItems, goalTimelineQuery.data?.items]);
  useLayoutEffect(() => {
    if (!goalTimelineFocusAfterLoadRef.current || goalTimelineMutation.isPending) return;
    goalTimelineFocusAfterLoadRef.current = false;
    const button = goalTimelineLoadMoreButtonRef.current;
    if (button && !button.disabled) {
      button.focus();
      return;
    }
    goalActivityPanelRef.current?.focus({ preventScroll: true });
  }, [goalTimelineCursor, goalTimelineItems.length, goalTimelineMutation.isPending]);
  const goalTimelineRuns = useMemo<LinkedRunItem[]>(() => (
    goalTimelineItems
      .filter((entry): entry is Extract<GoalActivityTimelinePage["items"][number], { source: "agent-run" }> => entry.source === "agent-run")
      .map(({ item: run }) => ({
        runId: run.id,
        status: run.status,
        agentId: run.agentId,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        invocationSource: run.invocationSource,
        triggerDetail: run.triggerDetail,
        contextSnapshot: run.contextSnapshot,
        resultJson: run.resultJson,
      }))
  ), [goalTimelineItems]);
  const goalTimelineRunById = useMemo(
    () => new Map(goalTimelineRuns.map((run) => [run.runId, run] as const)),
    [goalTimelineRuns],
  );
  const goalTimelineActivityItems = useMemo<CommentThreadActivityItem[]>(() => buildGoalTimelineActivityItems({
    items: goalTimelineItems,
    runById: goalTimelineRunById,
    sessionUserId: sessionQuery.data?.user.id,
    pendingFeedback,
    goalLifecycle: workspace?.goal.lifecycle,
    onRetryFeedback: (feedback) => feedbackMutation.mutate(feedback),
  }), [feedbackMutation, goalTimelineItems, goalTimelineRunById, pendingFeedback, sessionQuery.data?.user.id, workspace?.goal.lifecycle]);
  useLayoutEffect(() => {
    const request = decisionFocusRequestRef.current;
    if (!request || workspaceQuery.isFetching) return;
    if (request.goalId !== goalId) {
      decisionFocusRequestRef.current = null;
      return;
    }
    const decisionIsPending = request.kind === "change"
      ? changeDecision.isPending
      : resultDecision.isPending;
    if (decisionIsPending) return;
    const proposalIsStillActionable = request.kind === "change"
      ? changeProposals.some((proposal) => proposal.id === request.id && proposal.status === "pending")
      : resultProposals.some((proposal) => proposal.id === request.id && proposal.status === "ready");
    if (proposalIsStillActionable) return;

    const hasOtherActionableAttention = changeProposals.some(
      (proposal) => proposal.id !== request.id && proposal.status === "pending",
    ) || resultProposals.some(
      (proposal) => proposal.id !== request.id && proposal.status === "ready",
    ) || Boolean(workspace?.attention && workspace.attention.sourceId !== request.id);
    const attentionHeading = hasOtherActionableAttention ? attentionHeadingRef.current : null;
    const outcomeHeading = outcomeHeadingRef.current?.isConnected
      ? outcomeHeadingRef.current
      : null;
    const feedbackComposer = feedbackSurfaceRef.current;
    const goalTitle = goalTitleRef.current;
    const target = attentionHeading?.isConnected
      ? attentionHeading
      : feedbackComposer?.isConnected
          ? feedbackComposer
          : goalTitle?.isConnected
            ? goalTitle
            : outcomeHeading?.isConnected
              ? outcomeHeading
            : null;
    if (!target) return;
    if (target === feedbackComposer) focusFeedbackComposer();
    else target.focus();
    decisionFocusRequestRef.current = null;
  }, [
    changeDecision.isPending,
    changeProposals,
    focusFeedbackComposer,
    goalId,
    resultDecision.isPending,
    resultProposals,
    workspace?.attention,
    workspaceQuery.isFetching,
  ]);

  useLayoutEffect(() => {
    const request = focusControlRequestRef.current;
    if (!request || setFocus.isPending || workspaceQuery.isFetching) return;
    if (request.goalId !== goalId) {
      focusControlRequestRef.current = null;
      return;
    }
    if (workspace?.goal.focus !== request.focus) return;

    const focusButton = focusButtonRef.current;
    if (!focusButton?.isConnected) return;
    focusButton.focus();
    focusControlRequestRef.current = null;
  }, [goalId, setFocus.isPending, workspace?.goal.focus, workspaceQuery.isFetching]);

  if (workspaceQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (canonicalGoalPath) return <Navigate to={canonicalGoalPath} replace />;
  if (workspaceQuery.error) {
    const message = workspaceQuery.error instanceof Error ? workspaceQuery.error.message : "Unable to load Goal";
    return (
      <div role="alert" className="space-y-3 py-8">
        <p className="text-sm font-medium text-destructive">{message}</p>
        <p className="text-sm text-muted-foreground">This Goal may have been removed or is no longer available.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void workspaceQuery.refetch()}>Retry</Button>
          <Link to="/goals" className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent">
            Back to Goals
          </Link>
        </div>
      </div>
    );
  }
  if (!workspace || !goal) {
    return (
      <div role="alert" className="space-y-3 py-8">
        <p className="text-sm font-medium text-destructive">Goal not found</p>
        <p className="text-sm text-muted-foreground">This Goal may have been removed or is no longer available.</p>
        <Link to="/goals" className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent">
          Back to Goals
        </Link>
      </div>
    );
  }

  const lifecycle = goal.lifecycle ?? "draft";
  const isDraft = lifecycle === "draft";
  const isActive = lifecycle === "active";
  const isClosed = lifecycle === "closed";
  const owner = agentsQuery.data?.find((agent) => agent.id === goal.ownerAgentId) ?? null;
  const evidenceContext: EvidenceContext = {
    issues: issuesQuery.data ?? [],
    projects: projectsQuery.data ?? [],
    runAgentId: goal.ownerAgentId ?? null,
  };
  const currentGoalRecord = asRecord(workspace.currentGoal);
  const currentGoalSummary = readString(currentGoalRecord, "summary")
    ?? goal.outcomeStatement
    ?? goal.description
    ?? goal.title;
  const agentActionRecord = asRecord(workspace.agentAction);
  const agentAction = readString(agentActionRecord, "summary")
    ?? (isDraft ? "Work has not started while this Goal is being aligned." : "No active work has been reported yet.");
  const agentActionStatus = readString(agentActionRecord, "status");
  const agentActionHeading = agentActionStatus && ["succeeded", "completed", "failed", "cancelled", "timed_out"].includes(agentActionStatus)
    ? "Latest Agent activity"
    : "Agent is doing";
  const nextStepRecord = asRecord(workspace.nextStep);
  const nextStep = readString(nextStepRecord, "summary")
    ?? goal.continuationSummary
    ?? (isDraft ? workspace.attention?.reason : null)
    ?? "No next step has been recorded.";
  const wakeCondition = readString(nextStepRecord, "wakeCondition") ?? goal.wakeCondition ?? null;
  const readyProposals = resultProposals.filter((proposal) => proposal.status === "ready");
  const acceptedProposal = resultProposals.find((proposal) => proposal.status === "accepted") ?? null;
  const pendingChanges = changeProposals.filter((proposal) => proposal.status === "pending");
  const hasActionableProposal = readyProposals.length > 0 || pendingChanges.length > 0;
  const hasAttention = Boolean(workspace.attention || readyProposals.length > 0 || pendingChanges.length > 0);
  const evaluationOutcome = readString(asRecord(goal.evaluationResult), "outcome");
  const progressProposal = acceptedProposal ?? readyProposals[0] ?? resultProposals[0] ?? null;
  const linkedWorkCount = linkedProjects.length + linkedIssues.length;
  const activeIssueCount = linkedIssues.filter((issue) => !["done", "cancelled"].includes(issue.status)).length;
  const activeProjectCount = linkedProjects.filter((project) => !["completed", "cancelled", "archived"].includes(project.status)).length;
  const activeWorkCount = activeIssueCount + activeProjectCount;
  const waitingForAgentStart = isActive && workspace.facet === "waiting_focus";
  const nextActionHeading = hasAttention
    ? "Review needed"
    : waitingForAgentStart
      ? "Owner ready"
      : goal.focus
        ? "Waiting for progress"
        : "Give the Agent direction";

  const beginTitleEdit = () => {
    setTitleDraft(goal.title);
    setTitleError(null);
    setTitleEditing(true);
  };
  const cancelTitleEdit = () => {
    setTitleDraft(goal.title);
    setTitleError(null);
    setTitleEditing(false);
  };
  const saveTitle = async () => {
    const title = titleDraft.trim();
    if (!title) {
      setTitleError("Goal title cannot be empty.");
      titleInputRef.current?.focus();
      return;
    }
    if (title === goal.title) {
      cancelTitleEdit();
      return;
    }
    setTitleError(null);
    try {
      await updateGoal.mutateAsync({ title });
      setTitleDraft(title);
      setTitleEditing(false);
    } catch (error) {
      setTitleError(error instanceof Error ? error.message : "Goal title could not be saved.");
      requestAnimationFrame(() => titleInputRef.current?.focus());
    }
  };
  const remove = async () => {
    const dependencies = dependenciesQuery.data;
    if (dependencies && !dependencies.canDelete) {
      pushToast({ title: "Goal cannot be deleted", body: dependencies.blockers.join(", "), tone: "warn" });
      return;
    }
    if (await confirm({ title: "Delete draft Goal?", description: "This removes the unlinked draft record.", confirmLabel: "Delete", tone: "destructive" })) {
      deleteGoal.mutate();
    }
  };
  const continueAlignment = () => openNewGoal({
    draftId: goal.id,
    title: goal.title,
    context: goal.description ?? "",
    ownerAgentId: goal.ownerAgentId ?? "",
    targetTime: goal.evaluationDeadline ? toDateOnlyValue(goal.evaluationDeadline) : "",
  });
  const submitFeedback = () => {
    const body = feedbackBody.trim();
    if (!body || feedbackMutation.isPending) return;
    const feedbackKind = "ordinary" as const;
    const attachments = [...feedbackAttachments];
    const identity = `${feedbackKind}\0${body}\0${attachments.map((attachment) => attachment.uri).join("\0")}`;
    if (feedbackRequestRef.current?.identity !== identity) {
      feedbackRequestRef.current = { identity, key: crypto.randomUUID() };
    }
    const pending: PendingFeedback = {
      identity,
      idempotencyKey: feedbackRequestRef.current.key,
      body,
      attachments,
      createdAt: new Date().toISOString(),
      feedbackKind,
      status: "sending",
      error: null,
    };
    setFeedbackBody("");
    feedbackMutation.mutate(pending);
  };
  const resultKey = (proposalId: string, decision: "accept" | "reject", feedback = "") => {
    const identity = `${proposalId}:${decision}:${feedback.trim()}`;
    const existing = resultRequestKeysRef.current.get(identity);
    if (existing) return existing;
    const key = crypto.randomUUID();
    resultRequestKeysRef.current.set(identity, key);
    return key;
  };
  const selectTab = (value: string) => {
    if (!GOAL_DETAIL_TABS.includes(value as GoalDetailTab)) return;
    const nextTab = value as GoalDetailTab;
    const params = new URLSearchParams(location.search);
    if (nextTab === "overview") params.delete("tab");
    else params.set("tab", nextTab);
    const nextSearch = params.toString();
    navigate({
      pathname: location.pathname,
      search: nextSearch ? `?${nextSearch}` : "",
      hash: location.hash,
    }, { replace: true });
  };
  const copyGoalId = async () => {
    await navigator.clipboard?.writeText(goal.id);
    setCopiedGoalId(true);
    pushToast({ title: "Copied Goal ID", tone: "success" });
    setTimeout(() => setCopiedGoalId(false), 1500);
  };
  const openGoalChat = () => {
    const restored = storedGoalChatTarget(goal.orgId, goal.id);
    sidePanel.openTarget({
      kind: "goal_chat",
      organizationId: goal.orgId,
      goalId: goal.id,
      agentId: goal.ownerAgentId ?? null,
      conversationId: restored?.conversationId ?? null,
      clientMutationId: restored?.clientMutationId ?? crypto.randomUUID(),
      body: restored?.body ?? "",
      label: goal.title,
    });
  };
  const goalTimelinePagination = goalTimelineCursor ? (
    <div className="py-3 text-center">
      <Button
        ref={goalTimelineLoadMoreButtonRef}
        type="button"
        size="sm"
        variant="outline"
        disabled={goalTimelineMutation.isPending}
        onClick={() => goalTimelineMutation.mutate(goalTimelineCursor)}
      >
        {goalTimelineMutation.isPending ? "Loading..." : goalTimelineMutation.isError ? "Retry earlier activity" : "Load earlier activity"}
      </Button>
      {goalTimelineMutation.isError ? <p role="alert" className="mt-2 text-xs text-destructive">{goalTimelineMutation.error.message}</p> : null}
    </div>
  ) : null;
  const goalFeedbackComposer = isActive && !hasActionableProposal ? (
    <CommentComposer
      body={feedbackBody}
      onBodyChange={(body) => {
        feedbackMutation.reset();
        setFeedbackBody(body);
      }}
      onSubmit={submitFeedback}
      canSubmit={Boolean(feedbackBody.trim()) && !feedbackMutation.isPending && !feedbackAttachmentMutation.isPending}
      submitting={feedbackMutation.isPending}
      editorRef={feedbackRef}
      surfaceRef={feedbackSurfaceRef}
      ariaLabel="Goal feedback composer"
      editorAriaLabel="Goal feedback"
      detailEscapeLayer
      attachmentAccept="image/*"
      attachmentAriaLabel="Attach feedback image"
      attachmentMultiple={false}
      imageUploadHandler={async (file) => {
        const asset = await feedbackAttachmentMutation.mutateAsync({ file });
        return asset.contentPath;
      }}
      onAttachmentError={(error, file) => {
        setFeedbackAttachmentError(error.message);
        setFailedFeedbackFile(file);
      }}
      attachmentStatus={feedbackAttachmentError ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span role="alert">{feedbackAttachmentError}</span>
          {failedFeedbackFile ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => {
                const file = failedFeedbackFile;
                void feedbackAttachmentMutation.mutateAsync({ file }).then((asset) => {
                  const safeName = file.name.replace(/[[\]]/g, "\\$&");
                  setFeedbackBody((current) => current
                    ? `${current}\n\n![${safeName}](${asset.contentPath})`
                    : `![${safeName}](${asset.contentPath})`);
                  focusFeedbackComposer();
                }).catch(() => undefined);
              }}
              disabled={feedbackAttachmentMutation.isPending}
            >
              Retry attachment
            </Button>
          ) : null}
        </div>
      ) : null}
    />
  ) : (
    <p className="border-t border-border pt-4 text-sm text-muted-foreground">
      {isDraft
        ? "Feedback becomes available after this Goal starts."
        : hasActionableProposal
          ? "Resolve the review above before adding more feedback."
          : "This conversation is read-only because the Goal is closed."}
    </p>
  );
  const diagnostics = debugMode ? (
    <Section title="Goal diagnostics" icon={ShieldCheck}>
      <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words border border-border bg-muted/20 p-3 text-xs leading-5">{JSON.stringify(workspace, null, 2)}</pre>
    </Section>
  ) : null;
  const renderGoalProperties = (inline = false) => {
    const ownerOpen = inline ? mobileOwnerOpen : desktopOwnerOpen;
    const ownerSearch = inline ? mobileOwnerSearch : desktopOwnerSearch;
    const setOwnerOpen = inline ? setMobileOwnerOpen : setDesktopOwnerOpen;
    const setOwnerSearch = inline ? setMobileOwnerSearch : setDesktopOwnerSearch;
    const ownerOptions = (agentsQuery.data ?? [])
      .filter((agent) => agent.status !== "terminated" && agent.status !== "pending_approval")
      .filter((agent) => {
        const query = ownerSearch.trim().toLowerCase();
        return !query || `${agent.name} ${agent.title ?? ""} ${agent.role}`.toLowerCase().includes(query);
      });

    return (
    <div className="space-y-1">
      {isClosed ? (
        <PropertyRow label="Owner" align="start">
          {owner ? (
            <AgentIdentity
              name={owner.name}
              icon={owner.icon}
              role={owner.role}
              className="max-w-full min-w-0 px-1 py-1 font-medium"
            />
          ) : (
            <span className="px-1 py-1 text-sm text-muted-foreground">{goal.ownerAgentId ? "Owner unavailable" : "Unassigned"}</span>
          )}
        </PropertyRow>
      ) : (
        <PropertyPicker
          inline={inline}
          label="Owner"
          open={ownerOpen}
          onOpenChange={(open) => { setOwnerOpen(open); if (!open) setOwnerSearch(""); }}
          triggerContent={owner ? (
            <AgentIdentity name={owner.name} icon={owner.icon} role={owner.role} className="w-full" />
          ) : (
            <span className="text-sm text-muted-foreground">{goal.ownerAgentId ? "Owner unavailable" : "Unassigned"}</span>
          )}
          triggerAriaLabel="Change Goal owner"
          triggerClassName="min-w-0 w-full max-w-full flex-1 justify-start overflow-hidden border-transparent bg-transparent px-1 py-1 hover:bg-accent/40"
          popoverClassName={inline ? "w-full" : "w-[19rem]"}
          popoverAlign="start"
          rowAlign="start"
          extra={owner && orgId && supportsIssueRuntimeOverrides(owner) ? (
            <IssueRuntimeSelector
              agent={owner}
              orgId={orgId}
              overrides={goal.ownerAgentRuntimeOverrides}
              variant="icon"
              disabled={updateGoal.isPending || assignOwner.isPending}
              onApply={(ownerAgentRuntimeOverrides) => updateGoal.mutate({ ownerAgentRuntimeOverrides })}
            />
          ) : null}
        >
          <input
            className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
            placeholder="Search Agents..."
            value={ownerSearch}
            onChange={(event) => setOwnerSearch(event.target.value)}
            autoFocus={!inline}
          />
          <div className="scrollbar-auto-hide max-h-60 overflow-y-auto overscroll-contain">
            {isDraft ? (
              <button
                type="button"
                className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50", !goal.ownerAgentId && "bg-accent")}
                onClick={() => { updateGoal.mutate({ ownerAgentId: null }); setOwnerOpen(false); }}
              >
                <span className="text-sm text-muted-foreground">Unassigned</span>
              </button>
            ) : (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">Keep current owner</div>
            )}
            {ownerOptions.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">{agentsQuery.isError ? "Agents could not be loaded." : "No available Agents."}</p>
            ) : ownerOptions.map((agent) => (
              <button
                type="button"
                data-inline-entity-option
                key={agent.id}
                role="option"
                aria-selected={agent.id === goal.ownerAgentId}
                className={cn("flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-accent/50", agent.id === goal.ownerAgentId && "bg-accent")}
                onClick={() => {
                  if (isDraft) updateGoal.mutate({ ownerAgentId: agent.id });
                  else assignOwner.mutate(agent.id);
                  setOwnerOpen(false);
                }}
              >
                <span className="flex min-w-0 flex-1"><AgentMenuLabel agent={agent} agentAvatarStyle="bare" /></span>
                {agent.id === goal.ownerAgentId ? <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
              </button>
            ))}
          </div>
        </PropertyPicker>
      )}

      <PropertyRow label="Agent work">
        <span className="inline-flex items-center gap-1.5 px-1 py-1 text-sm text-muted-foreground">
          <Focus className="h-3.5 w-3.5" />
          {isActive ? (goal.focus ? "Focused" : "On demand") : isDraft ? "Starts with Goal" : "Stopped"}
          {isActive ? (
            <span className="sr-only">
              {goal.focus
                ? "This Goal stays eligible for the Owner Agent's next run."
                : "The Owner Agent responds to new direction or linked work."}
            </span>
          ) : null}
        </span>
      </PropertyRow>

      <PropertyRow label="Active work" align="start">
        {linkedWorkCount > 0 ? (
          <div className="flex flex-wrap gap-2">
            <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium tabular-nums">{activeWorkCount} active</span>
            <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground tabular-nums">{linkedWorkCount} linked</span>
          </div>
        ) : <p className="text-sm text-muted-foreground">No linked work yet.</p>}
      </PropertyRow>

      <PropertyRow label="Status">
        <StatusIcon
          status={goalStatusIconStatus[goal.status] ?? "todo"}
          label={goalStatusLabel(goal.status)}
          showLabel
        />
      </PropertyRow>

      <PropertyRow label="Target">
        {isDraft ? (
          <GoalTargetTimePicker
            value={goal.evaluationDeadline || goal.actionDeadline
              ? toDateOnlyValue(goal.evaluationDeadline ?? goal.actionDeadline!)
              : ""}
            onChange={(targetDate) => updateGoal.mutate({ targetTime: targetDate || null })}
          />
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5 px-1 py-1 text-sm">
            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {goal.evaluationDeadline || goal.actionDeadline
                ? formatDateOnly(goal.evaluationDeadline ?? goal.actionDeadline!)
                : "Not set"}
            </span>
          </span>
        )}
      </PropertyRow>

      {linkedWorkCount > 0 ? (
        <div className="min-w-0 border-t border-border pt-3">
          <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>Related</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </div>
          <WorkLinks projects={linkedProjects} issues={linkedIssues} limit={relatedExpanded ? undefined : 3} />
          {linkedWorkCount > 3 ? (
            <button
              type="button"
              className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={relatedExpanded}
              onClick={() => setRelatedExpanded((current) => !current)}
            >
              {relatedExpanded ? "Show fewer" : `Show ${linkedWorkCount - 3} more`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
    );
  };

  const renderGoalActions = (mobile = false) => {
    const actionButtons = (
      <>
        <Button
          type="button"
          variant="ghost"
          size={mobile ? "icon-xs" : "sm"}
          className={cn("h-7", mobile ? "w-7 px-0" : "px-2 text-xs", !mobile && "rounded-full")}
          aria-label={copiedGoalId ? "Copied" : "Copy ID"}
          onClick={() => void copyGoalId()}
          title="Copy Goal ID"
        >
          {copiedGoalId ? <Check className={cn("h-4 w-4", !mobile && "mr-1.5 h-3.5 w-3.5")} /> : <Copy className={cn("h-4 w-4", !mobile && "mr-1.5 h-3.5 w-3.5")} />}
          {!mobile ? (copiedGoalId ? "Copied" : "Copy ID") : null}
        </Button>
        {!isDraft ? (
          <Button
            type="button"
            variant="ghost"
            size={mobile ? "icon-xs" : "sm"}
            className={cn("h-7", mobile ? "w-7 px-0" : "px-2 text-xs", !mobile && "rounded-full")}
            aria-label="Chat"
            onClick={openGoalChat}
            title="Open in chat"
          >
            <MessageSquare className={cn("h-4 w-4", !mobile && "mr-1.5 h-3.5 w-3.5")} />
            {!mobile ? "Chat" : null}
          </Button>
        ) : null}
        {(!mobile || isDraft) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size={mobile ? "icon-xs" : "sm"}
                className={cn("h-7", mobile ? "w-7 px-0" : "w-7 px-0", !mobile && "rounded-full")}
                aria-label="More Goal actions"
                title="More actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => void copyGoalId()}>
                <Copy className="h-4 w-4" />Copy Goal ID
              </DropdownMenuItem>
              {isDraft ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => void remove()}>
                    <Trash2 className="h-4 w-4" />Delete Goal
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </>
    );

    return (
      <div className={cn(
        "flex items-center gap-0.5 shrink-0",
        mobile ? "md:hidden" : "rounded-full border border-border bg-background/80 p-1",
      )}>
        {actionButtons}
        {mobile ? <PropertiesManifestTrigger onClick={() => setMobilePropsOpen(true)} /> : null}
      </div>
    );
  };

  return (
    <div data-testid="goal-detail-workspace" className="issue-detail-container min-h-0 w-full min-w-0 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-8">
      <div className="issue-detail-layout goal-detail-layout mx-auto min-h-full max-w-6xl" data-testid="goal-detail-layout">
      <header className="issue-detail-heading min-w-0 space-y-3" data-testid="goal-detail-heading" aria-label="Goal identity and context">
        <div className="flex items-start justify-end gap-3">
          {renderGoalActions(true)}
        </div>
        <div className="min-w-0">
            {isDraft && titleEditing ? (
              <div className="min-w-0 space-y-2" data-testid="goal-title-editor" data-detail-escape-layer="true">
                <div className="flex min-w-0 items-start gap-2">
                  <input
                    ref={titleInputRef}
                    aria-label="Goal title"
                    value={titleDraft}
                    onChange={(event) => {
                      setTitleDraft(event.target.value);
                      setTitleError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        void saveTitle();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelTitleEdit();
                      }
                    }}
                    disabled={updateGoal.isPending}
                    className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-xl font-semibold outline-none focus:border-ring"
                  />
                  <Button type="button" size="icon-sm" aria-label="Save Goal title" title="Save title" onClick={() => void saveTitle()} disabled={updateGoal.isPending}>
                    {updateGoal.isPending ? <Clock3 className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                  </Button>
                  <Button type="button" size="icon-sm" variant="outline" aria-label="Cancel Goal title edit" title="Cancel" onClick={cancelTitleEdit} disabled={updateGoal.isPending}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {titleError ? <p role="alert" className="text-sm text-destructive">{titleError}</p> : null}
              </div>
            ) : (
              <div className="flex min-w-0 items-start gap-2">
                <h1 ref={goalTitleRef} tabIndex={-1} className="min-w-0 flex-1 whitespace-normal break-words rounded-sm text-xl font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring">{goal.title}</h1>
                {isDraft ? (
                  <Button type="button" size="icon-sm" variant="ghost" aria-label="Edit Goal title" title="Edit title" onClick={beginTitleEdit}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            )}
        </div>
      </header>

      <aside className="issue-detail-rail min-w-0">
        <div className="issue-detail-actions min-w-0 items-center justify-end" data-testid="goal-detail-actions">
          {renderGoalActions()}
        </div>
        <div className="issue-detail-properties min-w-0" data-testid="goal-detail-sidebar">
          <PropertiesManifest ariaLabel="Goal properties">
            {renderGoalProperties()}
          </PropertiesManifest>
        </div>
      </aside>

      <main className="issue-detail-body min-w-0 space-y-6" data-testid="goal-detail-primary-content">
        {isDraft ? (
            <InlineEditor
              value={goal.description ?? ""}
              onSave={(description) => updateGoal.mutateAsync({ description: markdownDocumentOrNull(description) })}
              as="p"
              className="min-h-0 min-w-0 whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground"
              placeholder="Add a description..."
              multiline
              editorEngine="codemirror"
              documentIdentity={`goal:${goal.id}`}
              variant="issue-description"
              imageUploadHandler={async (file) => {
                const asset = await uploadDescriptionImage.mutateAsync(file);
                return asset.contentPath;
              }}
            />
        ) : (
          <MarkdownBody className="min-w-0 break-words text-[15px] leading-7 text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            {goal.description ?? ""}
          </MarkdownBody>
        )}

        <section aria-label="Goal content" className="min-w-0 space-y-3">
          <Tabs value={activeTab} onValueChange={selectTab} className="min-w-0 space-y-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border pb-2">
            <span className="sr-only">Goal detail views</span>
            <TabsList className="h-8 rounded-md p-0.5" aria-label="Goal detail views">
              <TabsTrigger value="overview" className="h-7 rounded px-2.5 text-xs">
                <Target className="h-3.5 w-3.5" />Overview
              </TabsTrigger>
              <TabsTrigger value="activity" className="h-7 rounded px-2.5 text-xs">
                <ActivityIcon className="h-3.5 w-3.5" />Activity
                {goalTimelineItems.length > 0 ? <span className="rounded-sm bg-background/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{goalTimelineItems.length}</span> : null}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="m-0 min-w-0 space-y-5">
            <section aria-label="Goal overview" className="min-w-0 space-y-5">
              <Section title="Overview" icon={Target} headingRef={outcomeHeadingRef}>
                {isDraft ? (
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">
                        {workspace.attention?.reason ?? "Clarify the result and confirm an Owner Agent before starting this Goal."}
                      </p>
                      <p className="text-xs text-muted-foreground">Continue this Goal when its result and Owner Agent are ready.</p>
                    </div>
                    <Button type="button" size="sm" onClick={continueAlignment}>
                      <Target className="mr-1.5 h-4 w-4" />Continue Goal
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-5">
                    {!isClosed && !hasAttention ? (
                      <div
                        aria-label="Next Goal action"
                        className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">{nextActionHeading}</p>
                          <p className="mt-0.5 min-w-0 break-words text-xs leading-5 text-muted-foreground">
                            {waitingForAgentStart
                              ? `${owner?.name ?? "The Owner Agent"} is ready to begin the next action.`
                              : goal.focus
                                ? `Rudder will keep this Goal eligible for ${owner?.name ?? "the Owner Agent"} and report new evidence here.`
                                : "Send direction to the Owner Agent without leaving this Goal."}
                          </p>
                        </div>
                        {!goal.focus ? (
                          <Button ref={focusButtonRef} type="button" size="sm" onClick={() => setFocus.mutate(true)} disabled={setFocus.isPending}>
                            <Sparkles className="h-4 w-4" />{setFocus.isPending && setFocus.variables === true ? "Starting..." : "Start Agent work"}
                          </Button>
                        ) : (
                          <Button ref={focusButtonRef} type="button" size="sm" variant="outline" onClick={() => setFocus.mutate(false)} disabled={setFocus.isPending}>
                            <Focus className="h-4 w-4" />{setFocus.isPending && setFocus.variables === false ? "Pausing..." : "Pause Agent work"}
                          </Button>
                        )}
                      </div>
                    ) : null}

                    <div className="divide-y divide-border border-y border-border">
                      <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
                        <div className="text-xs font-medium text-muted-foreground">Outcome</div>
                        <div className="min-w-0">
                          <p className="whitespace-pre-wrap break-words text-sm leading-6">{currentGoalSummary}</p>
                          {currentGoalRecord.updatedFromEvidence === true ? <p className="mt-1 text-xs text-muted-foreground">Updated from evidence and feedback</p> : null}
                        </div>
                      </div>
                      <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
                        <div className="text-xs font-medium text-muted-foreground">Current progress</div>
                        <div className="min-w-0">
                          <p className="whitespace-pre-wrap break-words text-sm leading-6">{workspace.currentProgress.summary}</p>
                          {workspace.currentProgress.uncertainty ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{workspace.currentProgress.uncertainty}</p> : null}
                          <EvidenceList items={workspace.currentProgress.evidence ?? []} refs={[]} context={evidenceContext} />
                        </div>
                      </div>
                      <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
                        <div className="text-xs font-medium text-muted-foreground">Success criteria</div>
                        <div className="min-w-0">
                          {goal.criteria.length > 0 ? (
                            <ul className="list-disc space-y-1 pl-4 text-sm leading-6">
                              {goal.criteria.map((criterion) => <li key={criterion.id} className="break-words">{criterion.label}</li>)}
                            </ul>
                          ) : (
                            <p className="text-sm leading-6 text-muted-foreground">No success criteria recorded yet.</p>
                          )}
                        </div>
                      </div>
                      {!isClosed && workspace.agentAction ? (
                        <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
                          <div className="text-xs font-medium text-muted-foreground">{agentActionHeading}</div>
                          <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{agentAction}</p>
                        </div>
                      ) : null}
                      {!isClosed ? (
                        <div className="grid min-w-0 gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
                          <div className="text-xs font-medium text-muted-foreground">Next step</div>
                          <div className="min-w-0">
                            <p className="whitespace-pre-wrap break-words text-sm leading-6">{nextStep}</p>
                            {wakeCondition ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">Resume when: {wakeCondition}</p> : null}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    {isClosed ? (
                      <div className="space-y-3">
                        <div className="text-xs font-medium text-muted-foreground">Result accepted</div>
                        {acceptedProposal ? (
                          <article
                            aria-label="Accepted Goal result"
                            className={cn(
                              "min-w-0 border-l-2 pl-3",
                              acceptedProposal.outcomeKind === "not_achieved" || acceptedProposal.outcomeKind === "breached"
                                ? "border-destructive/45"
                                : "border-emerald-500/50",
                            )}
                          >
                            <ResultProposalSummary proposal={acceptedProposal} accepted />
                          </article>
                        ) : (
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{evaluationOutcome ?? goal.status}</p>
                            <p className="mt-1 text-xs text-muted-foreground">Accepted proposal details are not available for this earlier Goal.</p>
                          </div>
                        )}
                      </div>
                    ) : null}

                    {!isClosed && hasAttention ? (
                      <div className="space-y-3">
                        <h3
                          ref={attentionHeadingRef}
                          tabIndex={-1}
                          className="rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Review needed
                        </h3>
                        {workspace.attention ? (
                          <div className="min-w-0 border-l-2 border-amber-500/50 pl-3">
                            <div className="text-xs font-medium text-muted-foreground">{attentionKindLabel(workspace.attention.kind)}</div>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{workspace.attention.reason}</p>
                            {workspace.attention.impact ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{workspace.attention.impact}</p> : null}
                            <EvidenceList items={workspace.attention.evidence ?? []} refs={[]} context={evidenceContext} />
                            {workspace.attention.kind === "owner_blocked" && owner?.status === "paused" ? (
                              <Button type="button" size="sm" className="mt-3" onClick={() => resumeOwner.mutate()} disabled={resumeOwner.isPending}>
                                {resumeOwner.isPending ? "Resuming..." : "Resume Agent"}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}

                        {pendingChanges.map((proposal) => {
                          const isPending = changeDecision.isPending && changeDecision.variables?.id === proposal.id;
                          const error = changeDecision.error && changeDecision.variables?.id === proposal.id ? changeDecision.error : null;
                          return (
                            <article
                              key={proposal.id}
                              aria-label="Goal change proposal"
                              className="min-w-0 rounded-md border border-amber-500/35 bg-amber-500/5 p-3"
                            >
                              <div className="text-sm font-semibold">Proposed Goal change</div>
                              <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
                                <div className="min-w-0"><div className="text-xs font-medium text-muted-foreground">Before</div><p className="mt-1 whitespace-pre-wrap break-words text-sm">{proposal.before}</p></div>
                                <div className="min-w-0"><div className="text-xs font-medium text-muted-foreground">After</div><p className="mt-1 whitespace-pre-wrap break-words text-sm">{proposal.after}</p></div>
                              </div>
                              {proposal.rationale ? <p className="mt-3 whitespace-pre-wrap break-words text-sm">{proposal.rationale}</p> : null}
                              {proposal.impact ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">Impact: {proposal.impact}</p> : null}
                              <EvidenceList items={proposal.evidence} refs={proposal.evidenceRefs} context={evidenceContext} />
                              <label className="mt-3 block text-xs text-muted-foreground">
                                Decision note
                                <input
                                  className="mt-1 h-9 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:border-ring"
                                  value={changeNotes[proposal.id] ?? ""}
                                  onChange={(event) => {
                                    changeDecision.reset();
                                    setChangeNotes((current) => ({ ...current, [proposal.id]: event.target.value }));
                                  }}
                                />
                              </label>
                              {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error.message}</p> : null}
                              <div className="mt-3 flex flex-wrap justify-end gap-2">
                                <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={() => changeDecision.mutate({ goalId: goal.id, id: proposal.id, decision: "reject" })}>
                                  {error && changeDecision.variables?.decision === "reject" ? "Retry reject" : "Reject"}
                                </Button>
                                <Button type="button" size="sm" disabled={isPending} onClick={() => changeDecision.mutate({ goalId: goal.id, id: proposal.id, decision: "approve" })}>
                                  <Check className="mr-1.5 h-3.5 w-3.5" />{error && changeDecision.variables?.decision === "approve" ? "Retry approve" : "Approve"}
                                </Button>
                              </div>
                            </article>
                          );
                        })}

                        {readyProposals.map((proposal) => {
                          const rejection = resultFeedback[proposal.id] ?? "";
                          const isPending = resultDecision.isPending && resultDecision.variables?.id === proposal.id;
                          const error = resultDecision.error && resultDecision.variables?.id === proposal.id ? resultDecision.error : null;
                          return (
                            <article
                              key={proposal.id}
                              aria-label="Goal result proposal"
                              className={cn(
                                "min-w-0 rounded-md border p-3",
                                proposal.outcomeKind === "not_achieved" || proposal.outcomeKind === "breached"
                                  ? "border-destructive/35 bg-destructive/5"
                                  : "border-emerald-500/35 bg-emerald-500/5",
                              )}
                            >
                              <div className="text-sm font-semibold">Result proposed</div>
                              <ResultProposalSummary proposal={proposal} />
                              <label className="mt-3 block text-xs font-medium text-muted-foreground">
                                Why is this result not sufficient?
                                <Textarea
                                  aria-label="Why is this result not sufficient?"
                                  value={rejection}
                                  onChange={(event) => {
                                    resultDecision.reset();
                                    setResultFeedback((current) => ({ ...current, [proposal.id]: event.target.value }));
                                  }}
                                  className="mt-1 min-h-16 resize-y bg-background text-sm text-foreground"
                                />
                              </label>
                              {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error.message}</p> : null}
                              <div className="mt-3 flex flex-wrap justify-end gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={isPending || !rejection.trim()}
                                  onClick={() => resultDecision.mutate({
                                    goalId: goal.id,
                                    id: proposal.id,
                                    decision: "reject",
                                    feedback: rejection.trim(),
                                    idempotencyKey: resultKey(proposal.id, "reject", rejection),
                                  })}
                                >
                                  {error && resultDecision.variables?.decision === "reject" ? "Retry rejection" : "Result is not sufficient"}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={isPending}
                                  onClick={() => resultDecision.mutate({
                                    goalId: goal.id,
                                    id: proposal.id,
                                    decision: "accept",
                                    idempotencyKey: resultKey(proposal.id, "accept"),
                                  })}
                                >
                                  <FileCheck2 className="mr-1.5 h-3.5 w-3.5" />{error && resultDecision.variables?.decision === "accept" ? "Retry accept" : "Accept result"}
                                </Button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                )}
              </Section>
              {diagnostics}
            </section>
          </TabsContent>

          <TabsContent
            ref={goalActivityPanelRef}
            value="activity"
            tabIndex={-1}
            className="m-0 min-w-0 space-y-4 outline-none"
          >
            {goalTimelineQuery.isError ? (
              <div role="alert" className="flex min-w-0 flex-wrap items-center justify-between gap-3 border border-destructive/35 bg-destructive/5 px-3 py-2.5 text-sm">
                <span className="min-w-0 break-words text-destructive">
                  {goalTimelineQuery.error instanceof Error ? goalTimelineQuery.error.message : "Activity could not be loaded."}
                </span>
                <Button type="button" size="sm" variant="outline" onClick={() => void goalTimelineQuery.refetch()}>
                  Retry activity
                </Button>
              </div>
            ) : null}
            {goalTimelineQuery.isLoading && !goalTimelineQuery.data ? (
              <div role="status" aria-label="Loading activity" className="px-3 py-6 text-sm text-muted-foreground">
                Loading activity...
              </div>
            ) : (
              <CommentThread
                comments={[]}
                linkedRuns={goalTimelineRuns}
                activityItems={goalTimelineActivityItems}
                orgId={goal.orgId}
                agentMap={agentMap}
                hideHeading
                fixedComposer
                fixedComposerTimelineScroll={false}
                composerReplacement={goalFeedbackComposer}
                emptyMessage={goalTimelineQuery.isError ? "Activity is unavailable." : "No activity yet."}
                onAdd={async () => undefined}
              />
            )}
            {goalTimelinePagination}
          </TabsContent>
        </Tabs>
      </section>
      </main>
      </div>
      <PropertiesManifestSheet
        open={mobilePropsOpen}
        onOpenChange={(open) => {
          setMobilePropsOpen(open);
          if (!open) {
            setMobileOwnerOpen(false);
            setMobileOwnerSearch("");
          }
        }}
      >
        {renderGoalProperties(true)}
      </PropertiesManifestSheet>
    </div>
  );
}
